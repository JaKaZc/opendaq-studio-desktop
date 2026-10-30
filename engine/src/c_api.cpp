// The engine's C interface, studio_engine.h. Starting and stopping hold the
// engine exclusively; requests, polls and events share it.

#include "engine.h"

#include "logs.h"
#include "platform.h"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <shared_mutex>

#if defined(_WIN32)
#define STUDIO_API extern "C" __declspec(dllexport)
#else
#define STUDIO_API extern "C" __attribute__((visibility("default")))
#endif

using namespace studio;

namespace
{

std::shared_mutex engineLock;
std::unique_ptr<Engine> engine;
std::string lastError;

char* copy(const std::string& text)
{
    auto* out = static_cast<char*>(std::malloc(text.size() + 1));
    std::memcpy(out, text.c_str(), text.size() + 1);
    return out;
}

/// A poll's frame, counted as one of the host's calls for the diagnostics.
std::vector<uint8_t> timedPoll(int client)
{
    const auto started = std::chrono::steady_clock::now();
    auto frame = engine->poll(client);
    engine->recordCall(std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count(), false);
    return frame;
}

/// Connects a device the options name, and says so in the event log.
void connectAtStart(const std::string& connection)
{
    rj::Document body(rj::kObjectType);
    body.AddMember("connectionString", rj::Value(connection.c_str(), body.GetAllocator()), body.GetAllocator());
    int status = 0;
    const rj::Value query(rj::kObjectType);
    const auto result = engine->handle("POST", "/api/devices", query, body, status);
    rj::Document answer;
    answer.Parse(result.c_str());
    const auto text = [&](const char* key) -> std::string
    { return answer.IsObject() && answer.HasMember(key) && answer[key].IsString() ? answer[key].GetString() : ""; };
    if (status == 200)
    {
        platform::log(platform::Level::Info, kTag, "Connected %s as %s", connection.c_str(), text("componentId").c_str());
        engine->notify("Connected " + (text("name").empty() ? connection : text("name")), "success");
    }
    else
    {
        platform::log(platform::Level::Error, kTag, "Connecting %s failed: %s", connection.c_str(), result.c_str());
        engine->notify("Connecting " + connection + " failed", "error", "backend", text("message"));
    }
}

}  // namespace

// ---------------------------------------------------------------------- C interface

/// Starts the instance. `options` is JSON: `{"moduleDirectory": "...",
/// "modules": ["lib....so"], "rootDeviceConnection": "android://", "devices":
/// ["daq.nd://..."], "rootDevice": {"localId", "name", "manufacturer",
/// "model", "serialNumber"}, "dataDirectory": "...", "streamInterval":
/// 0.05, "maxPoints": 4000}`. The data directory
/// keeps the logs and their levels; without one, a computer uses the
/// per-user folder openDAQ Studio has always used. Returns 0 on success, or
/// -1 with the reason in `studio_last_error`.
STUDIO_API int studio_start(const char* options)
{
    std::unique_lock lock(engineLock);
    try
    {
        rj::Document doc;
        doc.Parse(options);
        if (doc.HasParseError() || !doc.IsObject())
            throw std::runtime_error("The engine options are not valid JSON");
        engine.reset();
        logs::setDataDirectory(doc.HasMember("dataDirectory") && doc["dataDirectory"].IsString() ? doc["dataDirectory"].GetString()
                                                                                                  : platform::dataDirectory());
        logs::setViewerLevel(logs::storedLevel("viewerLevel"));
        platform::log(platform::Level::Info, kTag, "%s %s starting (API %s)", kAppName, kAppVersion, kApiVersion);
        const std::string directory = doc.HasMember("moduleDirectory") ? doc["moduleDirectory"].GetString() : "";
        static const rj::Value none;
        engine = std::make_unique<Engine>(directory, doc.HasMember("rootDevice") ? doc["rootDevice"] : none);
        // How live samples are delivered, as the start options set it.
        if (doc.HasMember("streamInterval") && doc["streamInterval"].IsNumber() && doc["streamInterval"].GetDouble() > 0)
            engine->streamSettings.interval = doc["streamInterval"].GetDouble();
        if (doc.HasMember("maxPoints") && doc["maxPoints"].IsNumber() && doc["maxPoints"].GetDouble() >= 1)
            engine->streamSettings.maxPoints = static_cast<size_t>(doc["maxPoints"].GetDouble());
        if (doc.HasMember("modules"))
            for (const auto& library : doc["modules"].GetArray())
                engine->loadModule(library.GetString());
        // The phone device becomes the root, before anything else is added.
        if (doc.HasMember("rootDeviceConnection") && doc["rootDeviceConnection"].IsString())
        {
            const std::string connection = doc["rootDeviceConnection"].GetString();
            try
            {
                engine->useAsRoot(connection, doc.HasMember("rootDevice") ? doc["rootDevice"] : none);
            }
            catch (const std::exception& error)
            {
                platform::log(platform::Level::Warn, kTag, "%s could not be the root device: %s", connection.c_str(), error.what());
            }
        }
        if (doc.HasMember("devices") && !doc["devices"].Empty())
        {
            for (const auto& connection : doc["devices"].GetArray())
                connectAtStart(connection.GetString());
            engine->invalidateTree("startup");
        }
        engine->notify(std::string(kAppName) + " ready", "success");
        lastError.clear();
        return 0;
    }
    catch (const std::exception& error)
    {
        lastError = error.what();
        engine.reset();
        platform::log(platform::Level::Error, kTag, "Start failed: %s", error.what());
        return -1;
    }
}

STUDIO_API char* studio_last_error()
{
    std::shared_lock lock(engineLock);
    return copy(lastError);
}

STUDIO_API void studio_stop()
{
    std::unique_lock lock(engineLock);
    engine.reset();
}

/// One request, answered as JSON. `status` receives the HTTP-style status.
STUDIO_API char* studio_request(const char* method, const char* path, const char* query, const char* body, int* status)
{
    std::shared_lock lock(engineLock);
    if (!engine)
    {
        *status = 503;
        return copy(R"({"code":"not_ready","message":"The openDAQ engine is not running"})");
    }
    rj::Document q, b;
    q.Parse(query && *query ? query : "{}");
    b.Parse(body && *body ? body : "null");
    if (q.HasParseError())
        q.SetObject();
    if (b.HasParseError())
        b.SetNull();
    return copy(engine->handle(method, path, q, b, *status));
}

namespace
{

std::vector<std::string> idList(const char* ids)
{
    rj::Document doc;
    doc.Parse(ids ? ids : "[]");
    std::vector<std::string> list;
    if (!doc.HasParseError() && doc.IsArray())
        for (const auto& id : doc.GetArray())
            if (id.IsString())
                list.emplace_back(id.GetString());
    return list;
}

uint8_t* frameCopy(const std::vector<uint8_t>& frame, int* length)
{
    *length = 0;
    if (frame.empty())
        return nullptr;
    auto* out = static_cast<uint8_t*>(std::malloc(frame.size()));
    std::memcpy(out, frame.data(), frame.size());
    *length = static_cast<int>(frame.size());
    return out;
}

}  // namespace

/// Replaces the phone app's set of streamed signals. `ids` is a JSON list.
/// Signals it already streams carry on without a reset.
STUDIO_API void studio_subscribe(const char* ids, int pointsPerSecond)
{
    std::shared_lock lock(engineLock);
    if (!engine)
        return;
    int status = 0;
    engine->subscribe(0, idList(ids), pointsPerSecond, 1.0, true, true, status);
}

STUDIO_API void studio_set_resolution(int pointsPerSecond)
{
    std::shared_lock lock(engineLock);
    if (engine)
        engine->setResolution(0, pointsPerSecond);
}

/// The phone app's samples since its last poll as one ODQV frame, or null.
/// The caller frees the result with `studio_free`.
STUDIO_API uint8_t* studio_poll(int* length)
{
    std::shared_lock lock(engineLock);
    *length = 0;
    if (!engine)
        return nullptr;
    return frameCopy(timedPoll(0), length);
}

/// A new client of live data, such as a desktop window, or -1.
STUDIO_API int studio_client_open()
{
    std::shared_lock lock(engineLock);
    return engine ? engine->openClient() : -1;
}

STUDIO_API void studio_client_close(int client)
{
    std::shared_lock lock(engineLock);
    if (engine)
        engine->closeClient(client);
}

/// Attaches a client to the signals in the JSON list `ids` and answers their
/// metadata, `{"signals": [...]}`, or an error with its status.
STUDIO_API char* studio_client_subscribe(int client, const char* ids, double pointsPerSecond, double primeSeconds, int* status)
{
    std::shared_lock lock(engineLock);
    if (!engine)
    {
        *status = 503;
        return copy(R"({"code":"not_ready","message":"The openDAQ engine is not running"})");
    }
    return copy(engine->subscribe(client, idList(ids), pointsPerSecond, primeSeconds, false, false, *status));
}

/// Detaches a client from the signals in the JSON list `ids`, or from all of
/// them when `ids` is null.
STUDIO_API void studio_client_unsubscribe(int client, const char* ids)
{
    std::shared_lock lock(engineLock);
    if (!engine)
        return;
    if (!ids)
    {
        engine->unsubscribe(client, nullptr);
        return;
    }
    const auto list = idList(ids);
    engine->unsubscribe(client, &list);
}

STUDIO_API void studio_client_resolution(int client, double pointsPerSecond)
{
    std::shared_lock lock(engineLock);
    if (engine)
        engine->setResolution(client, pointsPerSecond);
}

STUDIO_API void studio_client_pause(int client, int paused)
{
    std::shared_lock lock(engineLock);
    if (engine)
        engine->setPaused(client, paused != 0);
}

/// The client's samples since its last frame as one ODQV frame, or null.
STUDIO_API uint8_t* studio_client_poll(int client, int* length)
{
    std::shared_lock lock(engineLock);
    *length = 0;
    if (!engine)
        return nullptr;
    return frameCopy(timedPoll(client), length);
}

/// Core events since the last call, as a JSON list of `{type, payload}`.
STUDIO_API char* studio_events()
{
    std::shared_lock lock(engineLock);
    if (!engine)
        return copy("[]");
    return copy(engine->takeEvents());
}

/// The newest picture of an image signal, if it is newer than the one
/// numbered `known`; otherwise null. `sequence` receives the newest number.
/// The caller frees the result with `studio_free`.
STUDIO_API uint8_t* studio_image(const char* id, int64_t known, int* length, int64_t* sequence)
{
    std::shared_lock lock(engineLock);
    *length = 0;
    *sequence = known;
    if (!engine)
        return nullptr;
    std::vector<uint8_t> picture;
    if (!engine->latestImage(id, known, picture, *sequence))
        return nullptr;
    auto* out = static_cast<uint8_t*>(std::malloc(picture.size()));
    std::memcpy(out, picture.data(), picture.size());
    *length = static_cast<int>(picture.size());
    return out;
}

STUDIO_API void studio_free(void* pointer)
{
    std::free(pointer);
}
