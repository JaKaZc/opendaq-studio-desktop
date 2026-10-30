#include "engine.h"

#include "logs.h"
#include "platform.h"
#include "value_text.h"
#include "routes/routes.h"
#include "timeserver.h"
#include "timesync.h"

#include <algorithm>
#include <cmath>
#include <set>

namespace studio
{

// ------------------------------------------------------------------ router

void Router::add(const std::string& method, const std::string& path, Handler handler)
{
    routes[method + " " + path] = std::move(handler);
}

const Handler* Router::find(const std::string& method, const std::string& path) const
{
    const auto it = routes.find(method + " " + path);
    return it == routes.end() ? nullptr : &it->second;
}

bool Router::knowsPath(const std::string& path) const
{
    for (const auto& [key, handler] : routes)
        if (key.size() > path.size() && key.compare(key.size() - path.size(), path.size(), path) == 0 && key[key.size() - path.size() - 1] == ' ')
            return true;
    return false;
}

void requireOnly(const rj::Value& body, std::initializer_list<const char*> allowed)
{
    if (!body.IsObject())
        fail(422, "invalid_request", "The request body must be a JSON object");
    for (const auto& item : body.GetObject())
        if (std::none_of(allowed.begin(), allowed.end(), [&](const char* name) { return item.name == name; }))
            fail(422, "invalid_request", std::string("The request does not take ") + item.name.GetString());
}

int64_t queryInteger(const rj::Value& query, const char* name, int64_t fallback, int64_t min, int64_t max)
{
    if (!query.IsObject() || !query.HasMember(name))
        return fallback;
    const std::string text = queryString(query, name);
    char* end = nullptr;
    const long long value = std::strtoll(text.c_str(), &end, 10);
    if (text.empty() || *end)
        fail(422, "invalid_request", std::string(name) + " must be an integer");
    if (value < min)
        fail(422, "invalid_request", std::string(name) + " must be at least " + std::to_string(min));
    if (value > max)
        fail(422, "invalid_request", std::string(name) + " must be at most " + std::to_string(max));
    return value;
}

// ------------------------------------------------------------------ live data

void SignalStream::countSamples(uint64_t count)
{
    const auto now = std::chrono::steady_clock::now();
    recent.emplace_back(now, count);
    while (!recent.empty() && recent.front().first < now - std::chrono::seconds(2))
        recent.pop_front();
}

double SignalStream::samplesPerSecond() const
{
    if (recent.size() < 2)
        return 0;
    const double span = std::chrono::duration<double>(recent.back().first - recent.front().first).count();
    uint64_t total = 0;
    for (const auto& [at, count] : recent)
        total += count;
    return span > 0 ? std::round(static_cast<double>(total) / span * 10) / 10 : 0;
}

// ------------------------------------------------------------------ the engine

namespace
{

double unixSeconds()
{
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count() / 1e6;
}

/// The SDK's log is a rolling window, not an archive: two files of 4 MB.
constexpr SizeT kSdkLogBytes = 4 * 1024 * 1024;
constexpr SizeT kSdkLogFiles = 2;

}  // namespace

Engine::Engine(const std::string& moduleDirectory, const rj::Value& rootDevice)
    : moduleDirectory(moduleDirectory)
    , startedAt(unixSeconds())
{
    addAllRoutes(router);
    // Client 0 is the phone app, which uses the original single subscription.
    clients[0];

    auto makeBuilder = [&](bool announce)
    {
        auto builder = InstanceBuilder().setModulePath(moduleDirectory);
        if (announce)
            builder.addDiscoveryServer("mdns");
        // openDAQ logs to the console, which nobody sees in an app, so it
        // also writes to a file the log page reads. The sink takes every
        // level; the components decide what reaches it, at the level stored
        // on the log page, which openDAQ fixes when it creates them.
        const std::string sdkLog = logs::sdkLogPath();
        if (!sdkLog.empty())
        {
            for (const auto& sink : DefaultSinks())
                builder.addLoggerSink(sink);
            builder.setSinkLogLevel(RotatingFileLoggerSink(sdkLog, kSdkLogBytes, kSdkLogFiles), LogLevel::Trace);
        }
        builder.setGlobalLogLevel(static_cast<LogLevel>(logs::sdkLevelValue(logs::storedLevel("sdkLevel"))));
        if (rootDevice.IsObject())
        {
            auto text = [&](const char* key) { return rootDevice.HasMember(key) && rootDevice[key].IsString() ? rootDevice[key].GetString() : ""; };
            auto info = DeviceInfo("", text("name"));
            info.setManufacturer(text("manufacturer"));
            info.setModel(text("model"));
            info.setSerialNumber(text("serialNumber"));
            builder.setDefaultRootDeviceInfo(info);
            if (*text("localId"))
                builder.setDefaultRootDeviceLocalId(text("localId"));
        }
        return builder;
    };
    if (!logs::sdkLogPath().empty())
        logs::followSdkLog(logs::sdkLogPath());
    // openDAQ's mDNS discovery server refuses to start without a network
    // interface, which a phone in airplane mode or without Wi-Fi lacks. The
    // instance then starts without it: everything works, and sharing works
    // by connection string, but the phone is not announced until openDAQ
    // restarts on a network.
    try
    {
        instance = makeBuilder(true).build();
        announcing = true;
    }
    catch (const std::exception& error)
    {
        platform::log(platform::Level::Warn, kTag, "Starting without mDNS: %s", error.what());
        instance = makeBuilder(false).build();
        announcing = false;
    }
    root = instance.getRootDevice();
    // The default root device keeps its own name, "OpenDAQClient", whatever
    // the info says, so the phone's name is set on it as well.
    if (rootDevice.IsObject() && rootDevice.HasMember("name") && rootDevice["name"].IsString() && *rootDevice["name"].GetString())
        root.setName(rootDevice["name"].GetString());
    context = instance.getContext();
    context.getOnCoreEvent() += [this](const ComponentPtr& component, const CoreEventArgsPtr& args)
    { onCoreEvent(component, args); };

#if !defined(__ANDROID__)
    timeMaster = std::make_unique<TimeMaster>();
    timeKeeper = std::thread([this] { keepTime(); });
#endif
}

void Engine::useAsRoot(const std::string& connection, const rj::Value& identity)
{
    PropertyObjectPtr config;
    for (const auto& [id, type] : instance.getAvailableDeviceTypes())
    {
        const std::string prefix = type.getConnectionStringPrefix().toStdString();
        if (!prefix.empty() && connection.rfind(prefix + "://", 0) == 0)
            config = type.createDefaultConfig();
    }
    if (config.assigned() && identity.IsObject())
    {
        const auto set = [&](const char* key, const char* property)
        {
            if (identity.HasMember(key) && identity[key].IsString() && *identity[key].GetString() && config.hasProperty(property))
                config.setPropertyValue(property, String(identity[key].GetString()));
        };
        set("localId", "LocalId");
        set("name", "Name");
        set("serialNumber", "SerialNumber");
    }
    instance.setRootDevice(connection, config);
    root = instance.getRootDevice();
    rootIsDevice = true;
}

Engine::~Engine()
{
    {
        std::lock_guard guard(keeperLock);
        stopping = true;
    }
    keeperWake.notify_all();
    if (timeKeeper.joinable())
        timeKeeper.join();
    timeMaster.reset();
    streams.clear();
    instance.release();
}

void Engine::loadModule(const std::string& library)
{
    using CreateModule = ErrCode (*)(IModule**, IContext*);
    auto create = reinterpret_cast<CreateModule>(platform::openSymbol(library, "createModule"));
    IModule* raw = nullptr;
    checkErrorInfo(create(&raw, context));
    instance.getModuleManager().addModule(ModulePtr::Adopt(raw));
}

std::string Engine::handle(const std::string& method, const std::string& path, const rj::Value& query, const rj::Value& body, int& status)
{
    const auto started = std::chrono::steady_clock::now();
    std::string failure;
    const std::string out = answer(method, path, query, body, status, failure);
    const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    recordCall(seconds, true, failure);
    if (!failure.empty())
        platform::log(platform::Level::Warn, kTag, "%s %s -> %s", method.c_str(), path.c_str(), failure.c_str());
    // Each request with its duration is what makes debug logging worth
    // turning on; reading the log itself would only add to it.
    else if (path != "/api/system/logs")
        platform::log(platform::Level::Debug, kTag, "%s %s in %.1f ms", method.c_str(), path.c_str(), seconds * 1000);
    return out;
}

std::string Engine::answer(const std::string& method, const std::string& path, const rj::Value& query, const rj::Value& body, int& status,
                           std::string& failure)
{
    rj::Document out;
    auto& a = out.GetAllocator();
    HttpError refusal;
    try
    {
        const Handler* handler = router.find(method, path);
        if (!handler)
        {
            if (router.knowsPath(path))
                fail(405, "method_not_allowed", path + " does not take " + method);
            fail(404, "not_found", "The openDAQ engine does not offer " + method + " " + path);
        }
        const Request request{method, path, query, body, a};
        rj::Value result = (*handler)(*this, request);
        status = 200;
        return toText(result);
    }
    catch (const HttpError& error)
    {
        refusal = error;
    }
    catch (const DaqException& error)
    {
        refusal = sdkError(method + " " + path, error);
    }
    catch (const std::exception& error)
    {
        refusal = HttpError{500, "internal_error", error.what(), "", ""};
    }
    status = refusal.status;
    if (status >= 500)
        failure = refusal.code + ": " + refusal.message;
    return errorJson(refusal);
}

std::string Engine::errorJson(const HttpError& error)
{
    rj::Document d;
    auto& a = d.GetAllocator();
    rj::Value out(rj::kObjectType);
    // A refusal without a code answers as a plain HTTP error, `{detail}`.
    if (error.code.empty())
    {
        out.AddMember("detail", str(error.message, a), a);
        return toText(out);
    }
    rj::Document extra(&a);
    if (!error.extra.empty())
        extra.Parse(error.extra.c_str());
    const bool hasExtra = !extra.HasParseError() && extra.IsObject() && extra.MemberCount() > 0;
    // A request that fails validation answers with only the list of its
    // problems, `{"detail": [...]}`, when there is one.
    if (error.status != 422 || !hasExtra)
    {
        out.AddMember("code", str(error.code, a), a);
        out.AddMember("message", str(error.message, a), a);
        if (!error.detail.empty())
            out.AddMember("detail", str(error.detail, a), a);
    }
    if (hasExtra)
        for (auto& member : extra.GetObject())
            out.AddMember(rj::Value(member.name, a), rj::Value(member.value, a), a);
    return toText(out);
}

// ------------------------------------------------------------------ events

namespace
{

/// Core events that change the shape of the tree.
const std::set<std::string> kStructural = {"ComponentAdded",     "ComponentRemoved",       "SignalConnected",
                                           "SignalDisconnected", "DeviceDomainChanged",    "DeviceLockStateChanged",
                                           "DeviceOperationModeChanged", "TypeAdded",      "TypeRemoved"};
/// Notifications kept for clients that look later.
constexpr size_t kHistory = 200;

/// A connection status as words, such as "Connected".
std::string statusText(const rj::Value& status)
{
    if (status.IsObject())
        return status.HasMember("name") && status["name"].IsString() ? status["name"].GetString() : "";
    if (status.IsString())
        return status.GetString();
    return truthy(status) ? jsonRepr(status) : "";
}

rj::Value optionalText(const std::optional<std::string>& text, Alloc& a)
{
    return text ? str(*text, a) : rj::Value();
}

}  // namespace

std::string Engine::takeEvents()
{
    std::vector<std::string> taken;
    {
        std::lock_guard lock(eventLock);
        if (treeChanged)
        {
            rj::Document d;
            rj::Value payload(rj::kObjectType);
            payload.AddMember("reason", str(treeReason.empty() ? "structure" : treeReason, d.GetAllocator()), d.GetAllocator());
            publishLocked("tree.changed", payload);
            treeChanged = false;
            treeReason.clear();
        }
        taken.swap(events);
    }
    std::string out = "[";
    for (const auto& event : taken)
        out += (out.size() > 1 ? "," : "") + event;
    return out + "]";
}

void Engine::pushEvent(const std::string& json)
{
    rj::Document d;
    d.Parse(json.c_str());
    if (d.HasParseError() || !d.IsObject() || !d.HasMember("type") || !d["type"].IsString())
        return;
    const rj::Value none;
    publish(d["type"].GetString(), d.HasMember("payload") ? d["payload"] : none);
}

void Engine::publish(const std::string& type, const rj::Value& payload)
{
    std::lock_guard lock(eventLock);
    publishLocked(type, payload);
}

void Engine::publishLocked(const std::string& type, const rj::Value& payload)
{
    rj::Document d;
    auto& a = d.GetAllocator();
    rj::Value event(rj::kObjectType);
    event.AddMember("type", str(type, a), a);
    event.AddMember("seq", ++eventSequence, a);
    event.AddMember("at", unixSeconds(), a);
    event.AddMember("payload", payload.IsNull() ? rj::Value(rj::kObjectType) : rj::Value(payload, a), a);
    auto text = toText(event);
    if (type == "notification")
    {
        history.push_back(text);
        if (history.size() > kHistory)
            history.pop_front();
    }
    // A host that does not take its events loses the oldest; the next
    // tree.changed makes its clients read the state again.
    if (events.size() > 500)
        events.erase(events.begin(), events.begin() + 250);
    events.push_back(std::move(text));
}

void Engine::notify(const std::string& message, const std::string& level, const std::string& source,
                    const std::optional<std::string>& detail, const std::optional<std::string>& componentId)
{
    rj::Document d;
    auto& a = d.GetAllocator();
    rj::Value payload(rj::kObjectType);
    payload.AddMember("level", str(level, a), a);
    payload.AddMember("message", str(message, a), a);
    payload.AddMember("detail", optionalText(detail, a), a);
    payload.AddMember("source", str(source, a), a);
    payload.AddMember("componentId", optionalText(componentId, a), a);
    publish("notification", payload);
}

void Engine::invalidateTree(const std::string& reason)
{
    std::lock_guard lock(eventLock);
    treeChanged = true;
    treeReason = reason;
}

rj::Value Engine::eventHistory(size_t limit, Alloc& a)
{
    std::lock_guard lock(eventLock);
    rj::Value list(rj::kArrayType);
    for (size_t i = history.size() > limit ? history.size() - limit : 0; i < history.size(); i++)
    {
        rj::Document event;
        event.Parse(history[i].c_str());
        list.PushBack(rj::Value(event, a), a);
    }
    return list;
}

void Engine::ignoreComponents(const std::vector<std::string>& ids, double seconds)
{
    const auto until = std::chrono::steady_clock::now() + std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::duration<double>(seconds));
    std::lock_guard lock(eventLock);
    for (const auto& id : ids)
        if (!id.empty())
            ignored[id] = until;
}

void Engine::beginProbe(const std::string& folderId)
{
    std::lock_guard lock(eventLock);
    probeFolder = folderId;
}

void Engine::endProbe()
{
    std::lock_guard lock(eventLock);
    probeFolder.clear();
}

bool Engine::isIgnored(const std::vector<std::string>& ids)
{
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard lock(eventLock);
    for (auto it = ignored.begin(); it != ignored.end();)
        it = it->second < now ? ignored.erase(it) : std::next(it);
    for (const auto& id : ids)
        for (const auto& [prefix, until] : ignored)
            if (id == prefix || id.rfind(prefix + "/", 0) == 0)
                return true;
    return false;
}

/// openDAQ's core events as the clients' events.
void Engine::onCoreEvent(const ComponentPtr& component, const CoreEventArgsPtr& args)
{
    if (!args.assigned())
        return;
    const std::string name = safe<std::string>([&] { return args.getEventName().toStdString(); }, "");
    const std::string componentId = safe<std::string>([&] { return component.assigned() ? component.getGlobalId().toStdString() : ""; }, "");

    rj::Document d;
    auto& a = d.GetAllocator();
    rj::Value parameters(rj::kObjectType);
    // Every component the event concerns: its sender, the component it adds,
    // and the one a removal names by its local ID under the sender.
    std::vector<std::string> ids;
    if (!componentId.empty())
        ids.push_back(componentId);
    isSafe([&] {
        for (const auto& [key, value] : args.getParameters())
        {
            const std::string k = key.toStdString();
            parameters.AddMember(str(k, a), valueToJson(value, a), a);
            if (const BaseObjectPtr added = value; k == "Component")
                isSafe([&] { ids.push_back(added.asPtr<IComponent>().getGlobalId().toStdString()); });
            else if (k == "Id" && !componentId.empty())
                ids.push_back(componentId + "/" + textOf(value));
        }
    });
    if (name == "ComponentAdded" && !componentId.empty())
    {
        bool probing;
        {
            std::lock_guard lock(eventLock);
            probing = componentId == probeFolder;
        }
        if (probing)
        {
            ignoreComponents(std::vector<std::string>(ids.begin() + 1, ids.end()));
            return;
        }
    }
    if (isIgnored(ids))
        return;

    const rj::Value none;
    const auto parameter = [&](const char* key) -> const rj::Value& { return parameters.HasMember(key) ? parameters[key] : none; };
    const std::optional<std::string> sender = componentId.empty() ? std::nullopt : std::optional<std::string>(componentId);
    rj::Value payload(rj::kObjectType);
    payload.AddMember("componentId", optionalText(sender, a), a);

    if (kStructural.count(name))
    {
        invalidateTree(name);
        if (name == "ComponentAdded" || name == "ComponentRemoved")
        {
            const auto& added = parameter("Component");
            notify(name == "ComponentAdded" ? "Added component" : "Removed component", "info", "opendaq",
                   added.IsNull() ? std::nullopt : std::optional<std::string>(jsonRepr(added)), sender);
        }
        return;
    }
    if (name == "StatusChanged")
    {
        if (parameters.HasMember("ConnectionStatus"))
        {
            const std::string status = statusText(parameter("ConnectionStatus"));
            payload.AddMember("status", rj::Value(parameter("ConnectionStatus"), a), a);
            publish("device.connectionStatusChanged", payload);
            invalidateTree(name);
            notify("Connection status: " + status, status != "Connected" ? "warning" : "info", "opendaq", std::nullopt, sender);
            return;
        }
        payload.AddMember("parameters", parameters, a);
        publish("component.statusChanged", payload);
        return;
    }
    if (name == "AttributeChanged")
    {
        payload.AddMember("attribute", rj::Value(parameter("AttributeName"), a), a);
        payload.AddMember("parameters", parameters, a);
        publish("component.attributeChanged", payload);
        return;
    }
    if (name == "PropertyValueChanged" || name == "PropertyAdded" || name == "PropertyRemoved" || name == "PropertyObjectUpdateEnd")
    {
        payload.AddMember("event", str(name, a), a);
        payload.AddMember("propertyName", rj::Value(truthy(parameter("Name")) ? parameter("Name") : parameter("Property"), a), a);
        payload.AddMember("value", rj::Value(parameter("Value"), a), a);
        payload.AddMember("parameters", parameters, a);
        publish("component.propertyChanged", payload);
        return;
    }
    payload.AddMember("event", str(name, a), a);
    payload.AddMember("parameters", parameters, a);
    publish("component.updated", payload);
}

// ------------------------------------------------------------------ the host's calls

void Engine::recordCall(double seconds, bool request, const std::string& error)
{
    std::lock_guard lock(callLock);
    calls++;
    if (request)
        requests++;
    if (!error.empty())
    {
        failures++;
        lastFailure = error;
    }
    durations.push_back(seconds);
    if (durations.size() > 200)
        durations.pop_front();
}

rj::Value Engine::callStats(Alloc& a)
{
    const auto rounded = [](double value) { return std::round(value * 1000) / 1000; };
    std::lock_guard lock(callLock);
    double sum = 0;
    double longest = 0;
    for (const double seconds : durations)
    {
        sum += seconds;
        longest = std::max(longest, seconds);
    }
    rj::Value out(rj::kObjectType);
    out.AddMember("uptimeSeconds", rounded(unixSeconds() - startedAt), a);
    out.AddMember("iterations", calls, a);
    out.AddMember("workItems", requests, a);
    out.AddMember("errors", failures, a);
    out.AddMember("lastError", lastFailure.empty() ? rj::Value() : str(lastFailure, a), a);
    out.AddMember("loopMsAvg", durations.empty() ? 0.0 : rounded(1000 * sum / static_cast<double>(durations.size())), a);
    out.AddMember("loopMsMax", rounded(1000 * longest), a);
    return out;
}

int Engine::eventSubscribers()
{
    std::lock_guard lock(streamLock);
    int count = 0;
    for (const auto& [number, client] : clients)
        if (number != 0)
            count++;
    return count;
}

std::vector<std::string> Engine::subscribedSignals(int client)
{
    std::lock_guard lock(streamLock);
    const auto found = clients.find(client);
    if (found == clients.end())
        return {};
    const auto& subscriptions = found->second.subscriptions;
    // The order the client subscribed in, then any signal the order misses.
    std::vector<std::string> out;
    for (const auto& id : found->second.order)
        if (subscriptions.count(id) && std::find(out.begin(), out.end(), id) == out.end())
            out.push_back(id);
    for (const auto& [id, subscription] : subscriptions)
        if (std::find(out.begin(), out.end(), id) == out.end())
            out.push_back(id);
    return out;
}

// ------------------------------------------------------------------ time

void Engine::clearClockOffsets()
{
    std::lock_guard lock(streamLock);
    clockOffsets.clear();
}

void Engine::keepTime()
{
    std::unique_lock guard(keeperLock);
    while (!keeperWake.wait_for(guard, std::chrono::seconds(5), [this] { return stopping; }))
    {
        guard.unlock();
        try
        {
            timeMaster->follow(root);
            if (alignClocks)
                setClockOffsets(measureOffsets(root));
        }
        catch (const std::exception& error)
        {
            // The next round tries again.
            platform::log(platform::Level::Debug, kTag, "Time master: %s", error.what());
        }
        guard.lock();
    }
}

std::string quote(const std::string& text)
{
    rj::Document d;
    return toText(str(text, d.GetAllocator()));
}

// ------------------------------------------------------------------ lookups

ComponentPtr Engine::findComponent(const std::string& id)
{
    return lookupComponent(root, id);
}

SignalPtr Engine::findSignal(const std::string& id)
{
    return safe<SignalPtr>([&]() -> SignalPtr { return findComponent(id).asPtrOrNull<ISignal>(); }, nullptr);
}

ComponentPtr Engine::holderOf(const ComponentPtr& component)
{
    for (auto parent = component.getParent(); parent.assigned(); parent = parent.getParent())
        if (parent.supportsInterface<IDevice>() || parent.supportsInterface<IFunctionBlock>())
            return parent;
    return root;
}

bool Engine::isSelf(const DeviceInfoPtr& info) const
{
    return safe<bool>(
        [&]
        {
            const auto own = root.getInfo();
            const std::string serial = textOf(own.getSerialNumber());
            return !serial.empty() && textOf(info.getSerialNumber()) == serial &&
                   textOf(info.getManufacturer()) == textOf(own.getManufacturer());
        },
        false);
}

}  // namespace studio
