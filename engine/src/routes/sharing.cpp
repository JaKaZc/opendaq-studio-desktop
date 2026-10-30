// /api/sharing: the phone app serves its instance to openDAQ clients on the
// network, such as openDAQ Studio on a computer.

#include "routes.h"

#include "../platform.h"

namespace studio
{

namespace
{

constexpr int kNativePort = 7420;

/// Serves the whole instance over openDAQ's native streaming protocol and
/// announces it with mDNS, so openDAQ clients on the network can find and
/// add it.
void share(Engine& e, bool enabled)
{
    if (enabled == e.server.assigned())
        return;
    if (enabled)
    {
        // The server collects and sends the signals' packets every 20 ms by
        // default, which delivers a renderer's plots in clumps, about 50 a
        // second whatever its frame rate. Every 2 ms keeps up with 240.
        auto config = e.instance.getAvailableServerTypes().get("OpenDAQNativeStreaming").createDefaultConfig();
        config.setPropertyValue("StreamingDataPollingPeriod", static_cast<Int>(2));
        e.server = e.instance.addServer("OpenDAQNativeStreaming", config);
        if (e.announcing)
            e.server.enableDiscovery();
        platform::log(platform::Level::Info, kTag, "Sharing on port %d", kNativePort);
    }
    else
    {
        e.instance.removeServer(e.server);
        e.server = nullptr;
        platform::log(platform::Level::Info, kTag, "Sharing stopped");
    }
}

rj::Value sharing(Engine& e, const Request& r)
{
    if (r.method == "PUT")
        share(e, member(r.body, "enabled").GetBool());
    rj::Value out(rj::kObjectType);
    out.AddMember("enabled", e.server.assigned(), r.a);
    out.AddMember("port", kNativePort, r.a);
    out.AddMember("announced", e.announcing, r.a);
    out.AddMember("name", str(textOf(e.root.getName()), r.a), r.a);
    return out;
}

}  // namespace

void addSharingRoutes(Router& router)
{
    router.add("GET", "/api/sharing", sharing);
    router.add("PUT", "/api/sharing", sharing);
}

}  // namespace studio
