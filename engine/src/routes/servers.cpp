// /api/servers, /api/server-types, /api/streaming-types: the instance's servers.

#include "topology_support.h"

namespace studio
{

namespace
{

rj::Value serverTypes(Engine& e, const Request& r)
{
    return sdkCall("List server types", [&] {
        rj::Value out(rj::kObjectType);
        out.AddMember("types", serverTypesJson(e, r.a), r.a);
        return out;
    });
}

rj::Value streamingTypes(Engine& e, const Request& r)
{
    return sdkCall("List streaming types", [&] {
        rj::Value out(rj::kObjectType);
        out.AddMember("types", streamingTypesJson(e, r.a), r.a);
        return out;
    });
}

rj::Value servers(Engine& e, const Request& r)
{
    return sdkCall("List servers", [&] {
        auto& a = r.a;
        rj::Value list(rj::kArrayType);
        const auto running = safe<ListPtr<IServer>>([&] { return e.instance.getServers(); }, nullptr);
        if (running.assigned())
            for (const auto& server : running)
            {
                rj::Value entry(rj::kObjectType);
                entry.AddMember("componentId", str(safe<std::string>([&] { return textOf(server.getGlobalId()); }, ""), a), a);
                entry.AddMember("name", str(safe<std::string>([&] { return textOf(server.getName()); }, ""), a), a);
                entry.AddMember("typeId", str(safe<std::string>([&] { return textOf(server.getId()); }, ""), a), a);
                entry.AddMember("active", safe<bool>([&] { return static_cast<bool>(server.getActive()); }, true), a);
                list.PushBack(entry, a);
            }
        rj::Value out(rj::kObjectType);
        out.AddMember("servers", list, a);
        return out;
    });
}

/// Starts a server, with a flat map of settings applied to the default
/// config of its type.
rj::Value addServer(Engine& e, const Request& r)
{
    auto& a = r.a;
    const auto& body = bodyOf(r, {"typeId", "config"});
    const std::string typeId = textMember(body, "typeId", true);
    const auto* values = configValues(body);
    rj::Value out = sdkCall("Add server " + typeId, [&] {
        PropertyObjectPtr config;
        std::vector<std::string> ignored;
        if (values)
        {
            isSafe([&] {
                const auto types = e.instance.getAvailableServerTypes();
                if (types.hasKey(String(typeId)))
                    config = types.get(String(typeId)).createDefaultConfig();
            });
            if (config.assigned())
                ignored = applyConfig(config, *values, e.context.getTypeManager());
        }
        const auto server = e.instance.addServer(typeId, config);
        if (!server.assigned())
            fail(400, "bad_request", "server could not be added: " + typeId);
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(textOf(server.getGlobalId()), a), a);
        result.AddMember("name", str(safe<std::string>([&] { return textOf(server.getName()); }, ""), a), a);
        result.AddMember("typeId", str(typeId, a), a);
        rj::Value keys(rj::kArrayType);
        for (const auto& key : ignored)
            keys.PushBack(str(key, a), a);
        result.AddMember("ignoredConfigKeys", keys, a);
        return result;
    });
    const std::string name = out["name"].GetString();
    notify(e, "success", "Started server " + (name.empty() ? typeId : name), "", out["componentId"].GetString());
    e.invalidateTree("serverAdded");
    return out;
}

ServerPtr serverAt(Engine& e, const std::string& id)
{
    const auto server = componentAt(e, id).asPtrOrNull<IServer>();
    if (!server.assigned())
        fail(400, "bad_request", "component is not a server");
    return server;
}

rj::Value removeServer(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    rj::Value out = sdkCall("Remove server", [&] {
        e.instance.removeServer(serverAt(e, id));
        rj::Value result(rj::kObjectType);
        result.AddMember("removedId", str(id, r.a), r.a);
        return result;
    });
    notify(e, "warning", "Server stopped", id, "");
    e.invalidateTree("serverRemoved");
    return out;
}

rj::Value setDiscovery(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const bool enabled = flagMember(bodyOf(r, {"enabled"}), "enabled");
    return sdkCall("Set server discovery", [&] {
        const auto server = serverAt(e, id);
        if (enabled)
            server.enableDiscovery();
        else
            server.disableDiscovery();
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(id, r.a), r.a);
        result.AddMember("discoveryEnabled", enabled, r.a);
        return result;
    });
}

}  // namespace

void addServerRoutes(Router& router)
{
    router.add("GET", "/api/server-types", serverTypes);
    router.add("GET", "/api/streaming-types", streamingTypes);
    router.add("GET", "/api/servers", servers);
    router.add("POST", "/api/servers", addServer);
    router.add("DELETE", "/api/servers", removeServer);
    router.add("PUT", "/api/servers/discovery", setDiscovery);
}

}  // namespace studio
