// /api/system: versions, health, diagnostics, the event history and the log.
//
// The "loop" of the diagnostics counts the host's calls into the engine,
// which is what the engine runs on.

#include "routes.h"

#include "../logs.h"
#include "../platform.h"

#include <opendaq/version.h>

#include <chrono>
#include <cmath>

#if defined(_WIN32)
#include <process.h>
#else
#include <sys/utsname.h>
#include <unistd.h>
#endif

namespace studio
{

namespace
{

/// The system and machine, such as "Darwin arm64"; with `release`,
/// "Darwin 25.0.0 (arm64)".
std::string platformName(bool release)
{
#if defined(__ANDROID__)
    if (!release)
        return "Android arm64";
#endif
#if defined(_WIN32)
#if defined(_M_ARM64)
    const std::string machine = "ARM64";
#else
    const std::string machine = "AMD64";
#endif
    return release ? "Windows (" + machine + ")" : "Windows " + machine;
#else
    utsname name{};
    uname(&name);
    return release ? std::string(name.sysname) + " " + name.release + " (" + name.machine + ")"
                   : std::string(name.sysname) + " " + name.machine;
#endif
}

std::string sdkVersion()
{
    unsigned major = 0, minor = 0, patch = 0;
    daqOpenDaqGetVersion(&major, &minor, &patch);
    return std::to_string(major) + "." + std::to_string(minor) + "." + std::to_string(patch);
}

double uptime(const Engine& e)
{
    using namespace std::chrono;
    const double now = duration_cast<microseconds>(system_clock::now().time_since_epoch()).count() / 1e6;
    return std::round((now - e.startedAt) * 1000) / 1000;
}

rj::Value version(Engine&, const Request& r)
{
    auto& a = r.a;
    rj::Value out(rj::kObjectType);
    out.AddMember("app", rj::StringRef(kAppName), a);
    out.AddMember("appVersion", rj::StringRef(kAppVersion), a);
    out.AddMember("apiVersion", rj::StringRef(kApiVersion), a);
    out.AddMember("sdkVersion", str(sdkVersion(), a), a);
    out.AddMember("platform", str(platformName(false), a), a);
    // The phone app reads this to know it runs on the engine inside it.
    out.AddMember("embedded", true, a);
    return out;
}

rj::Value health(Engine& e, const Request& r)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("status", "ok", r.a);
    out.AddMember("ready", true, r.a);
    out.AddMember("uptimeSeconds", uptime(e), r.a);
    return out;
}

rj::Value info(Engine& e, const Request& r)
{
    auto& a = r.a;
    rj::Value out(rj::kObjectType);
    out.AddMember("id", str(safe<std::string>([&] { return e.instance.getGlobalId().toStdString(); }, ""), a), a);
    out.AddMember("name", str(safe<std::string>([&] { return e.instance.getName().toStdString(); }, ""), a), a);
    out.AddMember("app", rj::StringRef(kAppName), a);
    out.AddMember("appVersion", rj::StringRef(kAppVersion), a);
    out.AddMember("apiVersion", rj::StringRef(kApiVersion), a);
    out.AddMember("sdkVersion", str(sdkVersion(), a), a);
    out.AddMember("readOnly", false, a);
    out.AddMember("allowShutdown", false, a);
    rj::Value discovery(rj::kArrayType);
    if (e.announcing)
        discovery.PushBack("mdns", a);
    out.AddMember("discoveryServers", discovery, a);
    rj::Value paths(rj::kArrayType);
    if (!e.moduleDirectory.empty())
        paths.PushBack(str(e.moduleDirectory, a), a);
    out.AddMember("modulePaths", paths, a);
    rj::Value streaming(rj::kObjectType);
    streaming.AddMember("maxPointsPerFrame", static_cast<uint64_t>(e.streamSettings.maxPoints), a);
    streaming.AddMember("bufferSamples", static_cast<uint64_t>(e.streamSettings.bufferSamples), a);
    streaming.AddMember("frameIntervalSeconds", e.streamSettings.interval, a);
    out.AddMember("streaming", streaming, a);
    out.AddMember("startedAt", e.startedAt, a);
    // The SDK is the one the app was built with; the UI offers no SDK page.
    out.AddMember("embedded", true, a);
    return out;
}

rj::Value diagnostics(Engine& e, const Request& r)
{
    auto& a = r.a;
    rj::Value out(rj::kObjectType);
    out.AddMember("loop", e.callStats(a), a);
    out.AddMember("streaming", e.streamStats(a), a);
    out.AddMember("eventSubscribers", e.eventSubscribers(), a);

    rj::Value sdk(rj::kObjectType);
    sdk.AddMember("version", str(sdkVersion(), a), a);
    sdk.AddMember("trackedObjects", static_cast<uint64_t>(daqGetTrackedObjectCount()), a);
    sdk.AddMember("moduleCount", static_cast<uint64_t>(safe<SizeT>([&] { return e.instance.getModuleManager().getModules().getCount(); }, 0)), a);
    // Which optional SDK interfaces this build has. The engine is built
    // against one SDK, which has both.
    rj::Value capabilities(rj::kObjectType);
    capabilities.AddMember("sdkVersion", str(sdkVersion(), a), a);
    capabilities.AddMember("developmentVersionInfo", true, a);
    capabilities.AddMember("deviceUpdateOptions", true, a);
    sdk.AddMember("capabilities", capabilities, a);
    out.AddMember("sdk", sdk, a);

    rj::Value process(rj::kObjectType);
#if defined(_WIN32)
    process.AddMember("pid", _getpid(), a);
#else
    process.AddMember("pid", static_cast<int>(getpid()), a);
#endif
    process.AddMember("platform", str(platformName(true), a), a);
    process.AddMember("uptimeSeconds", uptime(e), a);
    out.AddMember("process", process, a);

    rj::Value settings(rj::kObjectType);
    settings.AddMember("streamInterval", e.streamSettings.interval, a);
    settings.AddMember("readOnly", false, a);
    out.AddMember("settings", settings, a);
    return out;
}

rj::Value events(Engine& e, const Request& r)
{
    const auto limit = queryInteger(r.query, "limit", 100);
    rj::Value out(rj::kObjectType);
    out.AddMember("events", e.eventHistory(static_cast<size_t>(std::clamp<int64_t>(limit, 1, 500)), r.a), r.a);
    return out;
}

rj::Value levels(Alloc& a)
{
    rj::Value list(rj::kArrayType);
    for (const char* level : logs::kLevels)
        list.PushBack(rj::StringRef(level), a);
    return list;
}

/// Both streams merged, newest last. `since` makes polling cheap: the page
/// asks for what it has not seen.
rj::Value readLogs(Engine&, const Request& r)
{
    auto& a = r.a;
    const auto limit = queryInteger(r.query, "limit", 500, 1, 5000);
    const auto since = queryInteger(r.query, "since", 0, 0);
    const std::string level = r.query.HasMember("level") ? queryString(r.query, "level") : "info";
    logs::readSdkLog();
    rj::Value entries(rj::kArrayType);
    for (const auto& record : logs::entries(static_cast<size_t>(limit), level, queryString(r.query, "source"), queryString(r.query, "search"),
                                            static_cast<uint64_t>(since)))
    {
        rj::Value entry(rj::kObjectType);
        entry.AddMember("seq", record.seq, a);
        entry.AddMember("at", record.at, a);
        entry.AddMember("level", str(record.level, a), a);
        entry.AddMember("source", str(record.source, a), a);
        entry.AddMember("origin", str(record.origin, a), a);
        entry.AddMember("message", str(record.message, a), a);
        entries.PushBack(entry, a);
    }
    const std::string path = logs::sdkLogPath();
    rj::Value out(rj::kObjectType);
    out.AddMember("entries", entries, a);
    out.AddMember("levels", levels(a), a);
    out.AddMember("captured", static_cast<uint64_t>(logs::count()), a);
    out.AddMember("viewerLevel", str(logs::viewerLevel(), a), a);
    out.AddMember("sdkLevel", str(logs::storedLevel("sdkLevel"), a), a);
    out.AddMember("sdkLogPath", path.empty() ? rj::Value() : str(path, a), a);
    return out;
}

/// The engine's own level changes at once; the SDK's is stored for the next
/// start, because openDAQ's components take their level when they are made.
rj::Value setLogLevel(Engine& e, const Request& r)
{
    requireOnly(r.body, {"viewer", "sdk"});
    const auto level = [&](const char* name) -> std::string
    {
        if (!r.body.HasMember(name) || r.body[name].IsNull())
            return {};
        if (!r.body[name].IsString())
            fail(422, "invalid_request", std::string(name) + " must be a level name");
        const std::string value = r.body[name].GetString();
        if (!value.empty() && !logs::isLevel(value))
            fail(400, "bad_request", "unknown log level: " + value, "trace, debug, info, warning, error, critical");
        return value;
    };
    const std::string viewer = level("viewer");
    if (!viewer.empty())
    {
        logs::setViewerLevel(viewer);
        logs::storeLevels(viewer, "");
    }
    bool restartRequired = false;
    const std::string sdk = level("sdk");
    if (!sdk.empty())
    {
        restartRequired = sdk != logs::storedLevel("sdkLevel");
        logs::storeLevels("", sdk);
    }
    e.notify("Log level: Studio " + logs::viewerLevel() + ", SDK " + logs::storedLevel("sdkLevel"));

    auto& a = r.a;
    rj::Value out(rj::kObjectType);
    out.AddMember("viewerLevel", str(logs::viewerLevel(), a), a);
    out.AddMember("sdkLevel", str(logs::storedLevel("sdkLevel"), a), a);
    out.AddMember("restartRequired", restartRequired, a);
    // The engine cannot restart itself; its host starts it again.
    out.AddMember("restartSupported", false, a);
    return out;
}

/// The host stops the engine itself, so the API never does.
rj::Value shutdown(Engine&, const Request&)
{
    throw HttpError{403, "", "shutdown is not enabled on this backend", "", ""};
}

}  // namespace

void addSystemRoutes(Router& router)
{
    router.add("GET", "/api/system/version", version);
    router.add("GET", "/api/system/health", health);
    router.add("GET", "/api/system/info", info);
    router.add("GET", "/api/system/diagnostics", diagnostics);
    router.add("GET", "/api/system/events", events);
    router.add("GET", "/api/system/logs", readLogs);
    router.add("PUT", "/api/system/logs/level", setLogLevel);
    router.add("POST", "/api/system/shutdown", shutdown);
}

}  // namespace studio
