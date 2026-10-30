// /api/configuration: saving the instance as openDAQ configuration JSON and
// loading it back.
//
// Loading takes openDAQ's update parameters, which say whether devices are
// connected again, and per device of the file whether it is loaded, skipped,
// removed or remapped to other hardware, so a configuration saved in the lab
// can be replayed against different devices.

#include "properties.h"
#include "routes.h"
#include "topology_support.h"

#include "../platform.h"
#include "../value_text.h"

#include <opendaq/update_parameters_factory.h>
#include <rapidjson/error/en.h>

#include <ctime>

namespace studio
{

namespace
{

/// Device update modes as the UI names them, in the order it offers them.
const char* const kUpdateModes[] = {"Load", "Skip", "Remap", "Remove", "UpdateOnly"};

std::string modeName(DeviceUpdateMode mode)
{
    switch (mode)
    {
        case DeviceUpdateMode::UpdateOnly: return "UpdateOnly";
        case DeviceUpdateMode::Skip: return "Skip";
        case DeviceUpdateMode::Remove: return "Remove";
        case DeviceUpdateMode::Remap: return "Remap";
        default: return "Load";
    }
}

DeviceUpdateMode modeValue(const std::string& name)
{
    static const std::pair<const char*, DeviceUpdateMode> modes[] = {{"Load", DeviceUpdateMode::Load},
                                                                     {"Skip", DeviceUpdateMode::Skip},
                                                                     {"Remap", DeviceUpdateMode::Remap},
                                                                     {"Remove", DeviceUpdateMode::Remove},
                                                                     {"UpdateOnly", DeviceUpdateMode::UpdateOnly}};
    for (const auto& [text, mode] : modes)
        if (name == text)
            return mode;
    fail(400, "bad_request", "unknown device update mode: " + name, "Load, Skip, Remap, Remove, UpdateOnly");
}

std::string saveConfiguration(Engine& e)
{
    try
    {
        return e.instance.saveConfiguration().toStdString();
    }
    catch (const DaqException& error)
    {
        failSdk("Save configuration", error);
    }
}

std::string suggestedFilename()
{
    const std::time_t now = std::time(nullptr);
    std::tm local{};
#if defined(_WIN32)
    localtime_s(&local, &now);
#else
    localtime_r(&now, &local);
#endif
    char name[64];
    std::strftime(name, sizeof name, "opendaq-config-%Y%m%d-%H%M%S.json", &local);
    return name;
}

/// The body's `content`: a configuration file's text, which must not be empty.
std::string contentOf(const rj::Value& body)
{
    const auto& content = member(body, "content");
    if (!content.IsString() || content.GetStringLength() == 0)
        fail(422, "invalid_request", "The content must be the configuration file's text");
    return {content.GetString(), content.GetStringLength()};
}

void parseConfiguration(const std::string& text, rj::Document& doc)
{
    doc.Parse<rj::kParseFullPrecisionFlag>(text.c_str(), text.size());
    if (doc.HasParseError())
        fail(400, "bad_request", "configuration file is not valid JSON",
             std::string(rj::GetParseError_En(doc.GetParseError())) + " (char " + std::to_string(doc.GetErrorOffset()) + ")");
}

/// A few counts, so the load dialog can say what is in the file.
rj::Value summarize(const rj::Value& parsed, Alloc& a)
{
    std::vector<std::string> devices, functionBlocks, servers;
    std::function<void(const rj::Value&)> walk = [&](const rj::Value& node)
    {
        if (node.IsArray())
            for (const auto& item : node.GetArray())
                walk(item);
        if (!node.IsObject())
            return;
        for (const auto& item : node.GetObject())
        {
            const std::string key = item.name.GetString();
            if (key == "__type" && item.value.IsString())
                continue;
            auto* names = key == "Dev" ? &devices : key == "FB" ? &functionBlocks : key == "Srv" ? &servers : nullptr;
            if (names && item.value.IsObject() && item.value.HasMember("items") && item.value["items"].IsObject())
                for (const auto& entry : item.value["items"].GetObject())
                    names->emplace_back(entry.name.GetString());
            walk(item.value);
        }
    };
    walk(parsed);
    const auto first = [&](const std::vector<std::string>& names)
    {
        rj::Value list(rj::kArrayType);
        for (size_t i = 0; i < names.size() && i < 50; i++)
            list.PushBack(str(names[i], a), a);
        return list;
    };
    rj::Value out(rj::kObjectType);
    out.AddMember("deviceCount", static_cast<uint64_t>(devices.size()), a);
    out.AddMember("functionBlockCount", static_cast<uint64_t>(functionBlocks.size()), a);
    out.AddMember("serverCount", static_cast<uint64_t>(servers.size()), a);
    out.AddMember("devices", first(devices), a);
    out.AddMember("functionBlocks", first(functionBlocks), a);
    out.AddMember("servers", first(servers), a);
    // The size of the file as the API reports it, in its spaced JSON form.
    out.AddMember("sizeBytes", static_cast<uint64_t>(asciiJson(parsed).size()), a);
    return out;
}

rj::Value optionsJson(const DeviceUpdateOptionsPtr& options, const std::vector<std::string>& path, Alloc& a)
{
    const auto text = [&](auto getter) { return str(safe<std::string>([&] { return getter().toStdString(); }, ""), a); };
    rj::Value entry(rj::kObjectType);
    rj::Value at(rj::kArrayType);
    for (const auto& part : path)
        at.PushBack(str(part, a), a);
    entry.AddMember("path", at, a);
    entry.AddMember("localId", text([&] { return options.getLocalId(); }), a);
    entry.AddMember("manufacturer", text([&] { return options.getManufacturer(); }), a);
    entry.AddMember("serialNumber", text([&] { return options.getSerialNumber(); }), a);
    entry.AddMember("connectionString", text([&] { return options.getConnectionString(); }), a);
    entry.AddMember("newManufacturer", text([&] { return options.getNewManufacturer(); }), a);
    entry.AddMember("newSerialNumber", text([&] { return options.getNewSerialNumber(); }), a);
    entry.AddMember("newConnectionString", text([&] { return options.getNewConnectionString(); }), a);
    entry.AddMember("updateMode", str(modeName(safe<DeviceUpdateMode>([&] { return options.getUpdateMode(); }, DeviceUpdateMode::Load)), a), a);
    rj::Value children(rj::kArrayType);
    size_t index = 0;
    for (const auto& child : safe<ListPtr<IDeviceUpdateOptions>>([&] { return options.getChildDeviceOptions(); }, List<IDeviceUpdateOptions>()))
    {
        auto childPath = path;
        childPath.push_back(std::to_string(index++));
        children.PushBack(optionsJson(child, childPath, a), a);
    }
    entry.AddMember("children", children, a);
    return entry;
}

/// The text of an override: a string as itself, another value in its literal
/// form, and empty for null or false.
std::string overrideText(const rj::Value& value)
{
    if (value.IsString())
        return value.GetString();
    return value.IsNull() || (value.IsBool() && !value.GetBool()) ? "" : jsonRepr(value);
}

/// Walks the options in step with the overrides, keyed by the option's
/// path such as "0.1", and applies them.
void applyOptions(const DeviceUpdateOptionsPtr& options, const rj::Value& overrides, const std::string& key)
{
    if (overrides.HasMember(key.c_str()) && overrides[key.c_str()].IsObject())
    {
        const auto& change = overrides[key.c_str()];
        if (change.HasMember("newConnectionString"))
            options.setNewConnectionString(overrideText(change["newConnectionString"]));
        if (change.HasMember("newManufacturer"))
            options.setNewManufacturer(overrideText(change["newManufacturer"]));
        if (change.HasMember("newSerialNumber"))
            options.setNewSerialNumber(overrideText(change["newSerialNumber"]));
        if (change.HasMember("updateMode") && !overrideText(change["updateMode"]).empty())
            options.setUpdateMode(modeValue(overrideText(change["updateMode"])));
    }
    size_t index = 0;
    for (const auto& child : safe<ListPtr<IDeviceUpdateOptions>>([&] { return options.getChildDeviceOptions(); }, List<IDeviceUpdateOptions>()))
        applyOptions(child, overrides, key + "." + std::to_string(index++));
}

rj::Value configuration(Engine& e, const Request& r)
{
    const std::string content = saveConfiguration(e);
    rj::Value out(rj::kObjectType);
    out.AddMember("content", str(content, r.a), r.a);
    out.AddMember("sizeBytes", static_cast<uint64_t>(content.size()), r.a);
    out.AddMember("suggestedFilename", str(suggestedFilename(), r.a), r.a);
    return out;
}

/// The configuration file itself. The host names it, as an attachment, the
/// way GET /api/configuration's suggestedFilename does.
rj::Value download(Engine& e, const Request& r)
{
    rj::Document doc(&r.a);
    doc.Parse<rj::kParseFullPrecisionFlag>(saveConfiguration(e).c_str());
    rj::Value out;
    out.Swap(doc);
    return out;
}

/// What a configuration file implies, unapplied: a summary, the update
/// parameters and the per-device options for the UI to edit.
rj::Value inspect(Engine&, const Request& r)
{
    requireOnly(r.body, {"content"});
    rj::Document parsed;
    parseConfiguration(contentOf(r.body), parsed);

    auto& a = r.a;
    const auto parameters = UpdateParameters();
    rj::Value deviceOptions(rj::kArrayType);
    if (const auto options = safe<DeviceUpdateOptionsPtr>([&] { return parameters.getDeviceUpdateOptions(); }, nullptr); options.assigned())
    {
        size_t index = 0;
        for (const auto& child : safe<ListPtr<IDeviceUpdateOptions>>([&] { return options.getChildDeviceOptions(); }, List<IDeviceUpdateOptions>()))
            deviceOptions.PushBack(optionsJson(child, {std::to_string(index++)}, a), a);
    }
    rj::Value modes(rj::kArrayType);
    for (const char* mode : kUpdateModes)
        modes.PushBack(rj::StringRef(mode), a);

    rj::Value out(rj::kObjectType);
    out.AddMember("summary", summarize(parsed, a), a);
    out.AddMember("parameters", listProperties(parameters, true, a), a);
    out.AddMember("deviceOptions", deviceOptions, a);
    out.AddMember("updateModes", modes, a);
    return out;
}

rj::Value load(Engine& e, const Request& r)
{
    requireOnly(r.body, {"content", "parameters", "deviceOptions"});
    const std::string content = contentOf(r.body);
    const rj::Value none;
    const auto& values = r.body.HasMember("parameters") ? r.body["parameters"] : none;
    const auto& overrides = r.body.HasMember("deviceOptions") ? r.body["deviceOptions"] : none;
    if (!values.IsNull() && !values.IsObject())
        fail(422, "invalid_request", "The parameters must be an object");
    if (!overrides.IsNull() && !overrides.IsObject())
        fail(422, "invalid_request", "The device options must be an object");
    if (content.find_first_not_of(" \t\r\n") == std::string::npos)
        fail(400, "bad_request", "configuration content is required");
    rj::Document parsed;
    parseConfiguration(content, parsed);

    const auto parameters = UpdateParameters();
    std::vector<std::string> ignored;
    if (values.IsObject() && values.MemberCount() > 0)
        ignored = applyConfig(parameters, values, e.context.getTypeManager());
    if (overrides.IsObject() && overrides.MemberCount() > 0)
    {
        // Dropping these silently would apply the file as saved while the
        // user believes a device was remapped.
        const auto root = safe<DeviceUpdateOptionsPtr>([&] { return parameters.getDeviceUpdateOptions(); }, nullptr);
        if (!root.assigned())
            fail(400, "bad_request", "this openDAQ instance did not provide device update options",
                 "load without deviceOptions to apply the file as saved");
        size_t index = 0;
        for (const auto& child : safe<ListPtr<IDeviceUpdateOptions>>([&] { return root.getChildDeviceOptions(); }, List<IDeviceUpdateOptions>()))
            applyOptions(child, overrides, std::to_string(index++));
    }
    try
    {
        e.instance.loadConfiguration(content, parameters);
    }
    catch (const DaqException& error)
    {
        failSdk("Load configuration", error);
    }
    e.notify("Configuration loaded", "success", "viewer");
    e.invalidateTree("configurationLoaded");

    rj::Value keys(rj::kArrayType);
    for (const auto& key : ignored)
        keys.PushBack(str(key, r.a), r.a);
    rj::Value out(rj::kObjectType);
    out.AddMember("applied", true, r.a);
    out.AddMember("ignoredParameterKeys", keys, r.a);
    return out;
}

}  // namespace

void addConfigurationRoutes(Router& router)
{
    router.add("GET", "/api/configuration", configuration);
    router.add("GET", "/api/configuration/download", download);
    router.add("POST", "/api/configuration/inspect", inspect);
    router.add("POST", "/api/configuration/load", load);
}

}  // namespace studio
