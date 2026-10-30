// /api/time: every device's synchronization and clock, aligning devices to
// this computer's time in plots, and Studio as the devices' time master.

#include "routes.h"

#include "../platform.h"
#include "../timeserver.h"
#include "../timesync.h"

namespace studio
{

namespace
{

/// When a device serves its time, points the other devices that follow
/// NTP at it, once each: phones then follow one phone, such as this one.
/// The phone app's engine does this when asked for the time; on a computer
/// the time master does it.
void followTimeMaster(Engine& e, const std::vector<DevicePtr>& devices)
{
    const DevicePtr* master = nullptr;
    std::vector<std::string> addresses;
    for (const auto& device : devices)
    {
        addresses = servedAddresses(device);
        if (!addresses.empty())
        {
            master = &device;
            break;
        }
    }
    if (!master)
        return;
    for (const auto& device : devices)
    {
        if (device.getGlobalId() == master->getGlobalId())
            continue;
        isSafe([&] {
            if (!device.hasProperty("NtpServer") || !device.hasProperty("TimeSource"))
                return;
            // The master's address on the follower's network: the one
            // that shares the first three numbers with the follower's.
            const std::string host = hostOf(device.getInfo().getConnectionString().toStdString());
            std::string server = addresses.front();
            const auto prefix = host.substr(0, host.rfind('.') + 1);
            for (const auto& address : addresses)
                if (!prefix.empty() && address.rfind(prefix, 0) == 0)
                    server = address;
            const std::string id = device.getGlobalId().toStdString();
            if (e.pointedAt[id] == server)
                return;
            e.pointedAt[id] = server;
            device.setPropertyValue("NtpServer", String(server));
            device.setPropertyValue("TimeSource", 1);
            platform::log(platform::Level::Info, "openDAQ", "%s follows the time at %s", id.c_str(), server.c_str());
        });
    }
}

/// Every device's synchronization: whether it is locked, its source and
/// role, and its clock against this one's.
rj::Value timeState(Engine& e, Alloc& a)
{
    static const char* const modes[] = {"Input", "Output", "Auto", "Off"};
    static const char* const states[] = {"Ok", "Error", "Warning"};
    std::vector<DevicePtr> devices;
    collectDevices(e.root.asPtr<IDevice>(), devices);
    if (!e.timeMaster)
        isSafe([&] { followTimeMaster(e, devices); });

    rj::Value list(rj::kArrayType);
    for (const auto& device : devices)
    {
        rj::Value entry(rj::kObjectType);
        entry.AddMember("id", str(device.getGlobalId().toStdString(), a), a);
        entry.AddMember("name", str(device.getName().toStdString(), a), a);
        entry.AddMember("isRoot", device.getGlobalId() == e.root.getGlobalId(), a);

        isSafe([&] {
            const auto sync = device.getSyncComponent();
            if (!sync.assigned())
                return;
            rj::Value facet(rj::kObjectType);
            facet.AddMember("locked", static_cast<bool>(sync.getSyncLocked()), a);
            const Int selected = sync.getSelectedSource();
            rj::Value interfaces(rj::kArrayType);
            Int index = 0;
            const auto all = sync.getInterfaces();
            for (const auto& name : all.getKeyList())
            {
                const PropertyObjectPtr object = all.get(name);
                rj::Value item(rj::kObjectType);
                item.AddMember("name", str(name.toStdString(), a), a);
                item.AddMember("selected", index == selected, a);
                const auto mode = safe<Int>([&] { return static_cast<Int>(object.getPropertyValue("Mode")); }, 3);
                item.AddMember("mode", str(mode >= 0 && mode < 4 ? modes[mode] : "Off", a), a);
                isSafe([&] {
                    const PropertyObjectPtr status = object.getPropertyValue("Status");
                    const Int state = safe<Int>([&] { return static_cast<Int>(status.getPropertyValue("State")); }, 0);
                    item.AddMember("state", str(state >= 0 && state < 3 ? states[state] : "Ok", a), a);
                    if (status.hasProperty("Grandmaster"))
                        item.AddMember("grandmaster", str(static_cast<std::string>(status.getPropertyValue("Grandmaster").asPtr<IString>()), a), a);
                });
                interfaces.PushBack(item, a);
                index++;
            }
            facet.AddMember("interfaces", interfaces, a);
            entry.AddMember("sync", facet, a);
        });

        const auto serves = servedAddresses(device);
        if (!serves.empty())
        {
            rj::Value addresses(rj::kArrayType);
            for (const auto& address : serves)
                addresses.PushBack(str(address, a), a);
            entry.AddMember("serves", addresses, a);
        }

        // The phone device says in words what its time follows.
        isSafe([&] {
            if (device.hasProperty("TimeStatus"))
                entry.AddMember("detail", str(static_cast<std::string>(device.getPropertyValue("TimeStatus").asPtr<IString>()), a), a);
        });

        double offset = 0;
        double uncertainty = 0;
        if (safe<bool>([&] { return measureClock(device, offset, uncertainty); }, false))
        {
            rj::Value clock(rj::kObjectType);
            clock.AddMember("offsetMs", offset, a);
            clock.AddMember("uncertaintyMs", uncertainty, a);
            entry.AddMember("clock", clock, a);
        }
        list.PushBack(entry, a);
    }
    rj::Value out(rj::kObjectType);
    out.AddMember("devices", list, a);
    if (e.timeMaster)
        out.AddMember("master", e.timeMaster->state(a), a);
    rj::Value align(rj::kObjectType);
    align.AddMember("enabled", e.alignClocks.load(), a);
    out.AddMember("align", align, a);
    return out;
}

/// Whether a body's `enabled` is true: not null, false, zero or empty.
bool enabledIn(const rj::Value& body, bool fallback)
{
    if (!body.IsObject())
        fail(422, "invalid_request", "The request body must be a JSON object");
    if (!body.HasMember("enabled"))
        return fallback;
    const auto& value = body["enabled"];
    if (value.IsBool())
        return value.GetBool();
    if (value.IsNumber())
        return value.GetDouble() != 0;
    if (value.IsString())
        return value.GetStringLength() > 0;
    if (value.IsArray())
        return !value.Empty();
    return value.IsObject() && value.MemberCount() > 0;
}

/// With `enabled`, the times of each device's samples are shifted by its
/// clock's measured offset to this computer's, so devices that are not
/// synchronized line up in plots. The devices themselves are left as they are.
rj::Value setAlign(Engine& e, const Request& r)
{
    e.alignClocks = enabledIn(r.body, false);
    if (e.alignClocks)
    {
        const auto offsets = measureOffsets(e.root.asPtr<IDevice>());
        e.clearClockOffsets();
        e.setClockOffsets(offsets);
    }
    rj::Value out(rj::kObjectType);
    out.AddMember("enabled", e.alignClocks.load(), r.a);
    return out;
}

/// With `enabled`, Studio points the devices that follow NTP at its own time
/// server as they connect; without, it leaves them as they are.
rj::Value setMaster(Engine& e, const Request& r)
{
    const bool enabled = enabledIn(r.body, true);
    if (!e.timeMaster)
    {
        rj::Value out(rj::kObjectType);
        out.AddMember("enabled", false, r.a);
        return out;
    }
    e.timeMaster->enabled = enabled;
    if (enabled)
        e.timeMaster->follow(e.root.asPtr<IDevice>());
    return e.timeMaster->state(r.a);
}

}  // namespace

void addTimeRoutes(Router& router)
{
    router.add("GET", "/api/time", [](Engine& e, const Request& r) { return timeState(e, r.a); });
    router.add("PUT", "/api/time/align", setAlign);
    router.add("PUT", "/api/time/master", setMaster);
}

}  // namespace studio
