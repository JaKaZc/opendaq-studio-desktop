// /api/signals: signal listings, descriptors, last values, and the checks of
// the picture route, whose pictures themselves come from Engine::latestImage.

#include "routes.h"
#include "signal_info.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>

namespace studio
{

namespace
{

/// A required query parameter, or a 422 refusal naming it.
std::string requiredQuery(const Request& r, const char* name)
{
    if (!r.query.IsObject() || !r.query.HasMember(name))
        fail(422, "invalid_request", std::string("The request needs ") + name);
    return queryString(r.query, name);
}

/// A boolean query parameter such as "true", "1", "yes" or "on", in any case.
bool queryFlag(const Request& r, const char* name)
{
    if (!r.query.IsObject() || !r.query.HasMember(name))
        return false;
    std::string text = queryString(r.query, name);
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const char* yes : {"1", "true", "t", "yes", "y", "on"})
        if (text == yes)
            return true;
    for (const char* no : {"0", "false", "f", "no", "n", "off"})
        if (text == no)
            return false;
    fail(422, "invalid_request", std::string(name) + " must be a boolean");
}

/// The component a listing covers: the one `name` names, or the root.
ComponentPtr scopeOf(Engine& e, const Request& r, const char* name)
{
    const std::string id = queryString(r.query, name);
    return id.empty() ? ComponentPtr(e.root) : componentOf(e, id);
}

rj::Value signalList(Engine& e, const Request& r)
{
    auto& a = r.a;
    const bool includeHidden = queryFlag(r, "includeHidden");
    const bool chartableOnly = queryFlag(r, "chartableOnly");
    const bool withDescriptor = queryFlag(r, "withDescriptor");
    const auto scope = scopeOf(e, r, "id");

    std::vector<rj::Value> entries;
    for (const auto& signal : collectSignals(scope, includeHidden))
    {
        rj::Value info = signalInfo(signal, withDescriptor, a);
        if (chartableOnly && !info["chartable"].GetBool())
            continue;
        entries.push_back(std::move(info));
    }
    const auto key = [](const rj::Value& info)
    {
        std::string name = info["name"].GetString();
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return name;
    };
    std::stable_sort(entries.begin(), entries.end(), [&](const rj::Value& x, const rj::Value& y) { return key(x) < key(y); });

    rj::Value list(rj::kArrayType);
    for (auto& entry : entries)
        list.PushBack(entry, a);
    rj::Value out(rj::kObjectType);
    out.AddMember("scopeId", r.query.IsObject() && r.query.HasMember("id") ? str(queryString(r.query, "id"), a) : rj::Value(), a);
    out.AddMember("signals", list, a);
    return out;
}

rj::Value signalDetail(Engine& e, const Request& r)
{
    const auto signal = signalOf(e, requiredQuery(r, "id"));
    rj::Value out = signalInfo(signal, true, r.a);
    out.AddMember("lastValue", lastValueJson(signal, r.a), r.a);
    return out;
}

rj::Value descriptor(Engine& e, const Request& r)
{
    auto& a = r.a;
    const std::string id = requiredQuery(r, "id");
    const auto signal = signalOf(e, id);
    const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
    rj::Value out(rj::kObjectType);
    out.AddMember("signalId", str(id, a), a);
    out.AddMember("descriptor", descriptorJson(descriptorOf(signal), a), a);
    out.AddMember("domainDescriptor", domain.assigned() ? descriptorJson(descriptorOf(domain), a) : rj::Value(), a);
    return out;
}

/// Backs the live signal table: one request for many signals keeps the poll
/// cheap, a table of 200 signals is one round trip rather than 200.
rj::Value lastValues(Engine& e, const Request& r)
{
    auto& a = r.a;
    std::vector<SignalPtr> signals;
    const auto ids = queryList(r.query, "id");
    if (!ids.empty())
        for (const auto& id : ids)
            signals.push_back(signalOf(e, id));
    else
        signals = collectSignals(scopeOf(e, r, "scopeId"), queryFlag(r, "includeHidden"));
    rj::Value values(rj::kArrayType);
    for (const auto& signal : signals)
        values.PushBack(lastValueJson(signal, a), a);
    rj::Value out(rj::kObjectType);
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    out.AddMember("at", str(isoTimestamp(std::chrono::duration_cast<std::chrono::microseconds>(now).count()), a), a);
    out.AddMember("values", values, a);
    return out;
}

/// The checks of GET /api/signals/picture. Whoever serves that route asks
/// here when it has no picture to answer: the refusal, or the media type the
/// signal's format names.
rj::Value pictureCheck(Engine& e, const Request& r)
{
    auto& a = r.a;
    const std::string id = requiredQuery(r, "id");
    const std::string after = queryString(r.query, "after");
    if (!after.empty())
    {
        char* end = nullptr;
        std::strtoll(after.c_str(), &end, 10);
        if (*end)
            fail(422, "invalid_request", "after must be an integer");
    }
    const auto signal = signalOf(e, id);
    const std::string format = imageFormat(descriptorOf(signal));
    if (format.empty())
        fail(400, "bad_request", "Read picture failed", "The signal does not carry pictures.");
    rj::Value out(rj::kObjectType);
    out.AddMember("format", str(format, a), a);
    out.AddMember("mediaType", str(imageMediaType(format), a), a);
    return out;
}

}  // namespace

void addSignalRoutes(Router& router)
{
    router.add("GET", "/api/signals", signalList);
    router.add("GET", "/api/signals/detail", signalDetail);
    router.add("GET", "/api/signals/descriptor", descriptor);
    router.add("GET", "/api/signals/last-values", lastValues);
    router.add("GET", "/api/signals/picture", pictureCheck);
}

}  // namespace studio
