// The engine's Node addon, for the desktop app's engine host.
//
// A thin binding of studio_engine.h. Requests and subscriptions, which may
// wait on a device, run on libuv's worker threads and answer a promise, so the
// host's event loop never blocks on the SDK. Polls, events and pictures only
// copy what the engine already holds and answer at once.

#define NAPI_VERSION 8
#include <napi.h>

#include <studio_engine.h>

#include <cstring>
#include <functional>
#include <string>

namespace
{

std::string take(char* text)
{
    std::string out = text ? text : "";
    studio_free(text);
    return out;
}

Napi::Value bytes(Napi::Env env, uint8_t* data, int length)
{
    if (!data)
        return env.Null();
    auto buffer = Napi::ArrayBuffer::New(env, static_cast<size_t>(length));
    std::memcpy(buffer.Data(), data, static_cast<size_t>(length));
    studio_free(data);
    return buffer;
}

std::string optionalString(const Napi::Value& value)
{
    return value.IsString() ? value.As<Napi::String>().Utf8Value() : std::string();
}

/// A call into the engine on a worker thread, answering {status, body}.
class Call : public Napi::AsyncWorker
{
public:
    using Work = std::function<std::string(int&)>;

    Call(Napi::Env env, Work work)
        : Napi::AsyncWorker(env)
        , deferred(Napi::Promise::Deferred::New(env))
        , work(std::move(work))
    {
    }

    Napi::Promise promise() const { return deferred.Promise(); }

protected:
    void Execute() override { body = work(status); }

    void OnOK() override
    {
        auto answer = Napi::Object::New(Env());
        answer.Set("status", status);
        answer.Set("body", body);
        deferred.Resolve(answer);
    }

    void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }

private:
    Napi::Promise::Deferred deferred;
    Work work;
    int status = 0;
    std::string body;
};

/// start(options JSON) -> {ok, error}
Napi::Value start(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const std::string options = optionalString(info[0]);
    auto answer = Napi::Object::New(env);
    const bool ok = studio_start(options.c_str()) == 0;
    answer.Set("ok", ok);
    if (!ok)
        answer.Set("error", take(studio_last_error()));
    return answer;
}

Napi::Value stop(const Napi::CallbackInfo& info)
{
    studio_stop();
    return info.Env().Undefined();
}

/// request(method, path, query JSON, body JSON) -> Promise<{status, body}>
Napi::Value request(const Napi::CallbackInfo& info)
{
    const std::string method = optionalString(info[0]);
    const std::string path = optionalString(info[1]);
    const std::string query = optionalString(info[2]);
    const std::string body = optionalString(info[3]);
    auto* call = new Call(info.Env(), [=](int& status) {
        return take(studio_request(method.c_str(), path.c_str(), query.c_str(), body.c_str(), &status));
    });
    auto promise = call->promise();
    call->Queue();
    return promise;
}

Napi::Value clientOpen(const Napi::CallbackInfo& info)
{
    return Napi::Number::New(info.Env(), studio_client_open());
}

Napi::Value clientClose(const Napi::CallbackInfo& info)
{
    studio_client_close(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
}

/// clientSubscribe(client, ids JSON, pointsPerSecond, primeSeconds) -> Promise<{status, body}>
Napi::Value clientSubscribe(const Napi::CallbackInfo& info)
{
    const int client = info[0].As<Napi::Number>().Int32Value();
    const std::string ids = optionalString(info[1]);
    const double pointsPerSecond = info[2].As<Napi::Number>().DoubleValue();
    const double primeSeconds = info[3].As<Napi::Number>().DoubleValue();
    auto* call = new Call(info.Env(), [=](int& status) {
        return take(studio_client_subscribe(client, ids.c_str(), pointsPerSecond, primeSeconds, &status));
    });
    auto promise = call->promise();
    call->Queue();
    return promise;
}

/// clientUnsubscribe(client, ids JSON or null for all)
Napi::Value clientUnsubscribe(const Napi::CallbackInfo& info)
{
    const int client = info[0].As<Napi::Number>().Int32Value();
    if (info[1].IsString())
        studio_client_unsubscribe(client, info[1].As<Napi::String>().Utf8Value().c_str());
    else
        studio_client_unsubscribe(client, nullptr);
    return info.Env().Undefined();
}

Napi::Value clientResolution(const Napi::CallbackInfo& info)
{
    studio_client_resolution(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Number>().DoubleValue());
    return info.Env().Undefined();
}

Napi::Value clientPause(const Napi::CallbackInfo& info)
{
    studio_client_pause(info[0].As<Napi::Number>().Int32Value(), info[1].ToBoolean().Value() ? 1 : 0);
    return info.Env().Undefined();
}

/// clientPoll(client) -> ArrayBuffer of one ODQV frame, or null
Napi::Value clientPoll(const Napi::CallbackInfo& info)
{
    int length = 0;
    uint8_t* frame = studio_client_poll(info[0].As<Napi::Number>().Int32Value(), &length);
    return bytes(info.Env(), frame, length);
}

/// events() -> JSON text of the queued events
Napi::Value events(const Napi::CallbackInfo& info)
{
    return Napi::String::New(info.Env(), take(studio_events()));
}

/// picture(signal ID, known sequence) -> {data: ArrayBuffer or null, sequence}
Napi::Value picture(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const std::string id = optionalString(info[0]);
    const auto known = static_cast<int64_t>(info[1].As<Napi::Number>().Int64Value());
    int length = 0;
    int64_t sequence = known;
    uint8_t* data = studio_image(id.c_str(), known, &length, &sequence);
    auto answer = Napi::Object::New(env);
    answer.Set("data", bytes(env, data, length));
    answer.Set("sequence", Napi::Number::New(env, static_cast<double>(sequence)));
    return answer;
}

Napi::Object init(Napi::Env env, Napi::Object exports)
{
    exports.Set("start", Napi::Function::New(env, start));
    exports.Set("stop", Napi::Function::New(env, stop));
    exports.Set("request", Napi::Function::New(env, request));
    exports.Set("clientOpen", Napi::Function::New(env, clientOpen));
    exports.Set("clientClose", Napi::Function::New(env, clientClose));
    exports.Set("clientSubscribe", Napi::Function::New(env, clientSubscribe));
    exports.Set("clientUnsubscribe", Napi::Function::New(env, clientUnsubscribe));
    exports.Set("clientResolution", Napi::Function::New(env, clientResolution));
    exports.Set("clientPause", Napi::Function::New(env, clientPause));
    exports.Set("clientPoll", Napi::Function::New(env, clientPoll));
    exports.Set("events", Napi::Function::New(env, events));
    exports.Set("picture", Napi::Function::New(env, picture));
    return exports;
}

}  // namespace

NODE_API_MODULE(studio_engine, init)
