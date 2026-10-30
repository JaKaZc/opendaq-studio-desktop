// /api/fleet: every connected device at a glance. For each device the
// instance holds: who it is, whether it is connected, its operation mode and
// status, how many of its channels run, its time, and for a phone with the
// Android device module its battery, temperature, processor and Wi-Fi from its
// System channel and the address of its Dashboard.

#include "topology_support.h"

#include <algorithm>
#include <cmath>
#include <iterator>

namespace studio
{

namespace
{

/// The System channel's signals the Fleet page shows.
const char* const kSystemSignals[] = {"BatteryLevel", "Charging", "BatteryTemperature", "BatteryPower",
                                      "Cpu", "WifiSignal", "ThermalHeadroom", "MemoryUsed"};

std::string textOr(const std::function<BaseObjectPtr()>& getter)
{
    return safe<std::string>([&] { return textOf(getter()); }, "");
}

rj::Value status(const DevicePtr& device, Alloc& a)
{
    std::string level = "Ok";
    std::string message;
    isSafe([&] {
        const auto container = device.getStatusContainer();
        const auto value = safe<EnumerationPtr>([&] { return container.getStatus("ComponentStatus"); }, nullptr);
        message = textOr([&] { return container.getStatusMessage("ComponentStatus"); });
        if (value.assigned())
            level = safe<std::string>([&] { return textOf(value.getValue()); }, "Ok");
    });
    rj::Value out(rj::kObjectType);
    out.AddMember("level", str(level, a), a);
    out.AddMember("message", message.empty() ? rj::Value() : str(message, a), a);
    return out;
}

/// The phone's System channel readings, or null for a device without one.
rj::Value system(const DevicePtr& device, Alloc& a)
{
    ChannelPtr channel;
    isSafe([&] {
        for (const auto& item : device.getChannels())
            if (textOf(item.getLocalId()) == "System")
                channel = item;
    });
    if (!channel.assigned())
        return rj::Value();
    rj::Value out(rj::kObjectType);
    isSafe([&] {
        for (const auto& signal : channel.getSignals())
        {
            const std::string name = textOr([&] { return signal.getLocalId(); });
            if (std::find(std::begin(kSystemSignals), std::end(kSystemSignals), name) == std::end(kSystemSignals))
                continue;
            rj::Value value;
            isSafe([&] {
                const auto last = signal.getLastValue();
                const auto type = coreTypeOf(last);
                // A reading the phone does not have, such as the Wi-Fi
                // signal without Wi-Fi, comes as NaN and is shown as null.
                if (type == ctBool || type == ctInt || type == ctFloat)
                    if (const double number = static_cast<double>(last); std::isfinite(number))
                        value.SetDouble(number);
            });
            out.AddMember(str(name, a), value, a);
        }
    });
    return out;
}

/// The addresses and PIN of the device's Dashboard, or null.
rj::Value dashboard(const DevicePtr& device, Alloc& a)
{
    rj::Value out;
    isSafe([&] {
        for (const auto& block : device.getFunctionBlocks())
        {
            if (textOr([&] { return block.getFunctionBlockType().getId(); }) != "UniversalDashboard")
                continue;
            rj::Value addresses(rj::kArrayType);
            const std::string text = textOr([&] { return block.getPropertyValue("WebAddress"); });
            size_t start = 0;
            while (start < text.size())
            {
                size_t end = text.find('\n', start);
                if (end == std::string::npos)
                    end = text.size();
                std::string line = text.substr(start, end - start);
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                if (line.rfind("http", 0) == 0)
                    addresses.PushBack(str(line, a), a);
                start = end + 1;
            }
            out.SetObject();
            out.AddMember("addresses", addresses, a);
            out.AddMember("pin", str(textOr([&] { return block.getPropertyValue("Pin"); }), a), a);
            return;
        }
    });
    return out;
}

/// Each device's time, as GET /api/time answers it, by device ID.
rj::Value timeByDevice(Engine& e, Alloc& a)
{
    rj::Value byId(rj::kObjectType);
    rj::Document query(rj::kObjectType);
    rj::Value body;
    int code = 0;
    const std::string text = e.handle("GET", "/api/time", query, body, code);
    rj::Document state;
    state.Parse(text.c_str());
    if (code != 200 || !state.IsObject() || !state.HasMember("devices") || !state["devices"].IsArray())
        return byId;
    for (const auto& entry : state["devices"].GetArray())
        if (entry.HasMember("id") && entry["id"].IsString() && !byId.HasMember(entry["id"].GetString()))
            byId.AddMember(rj::Value(entry["id"], a), rj::Value(entry, a), a);
    return byId;
}

rj::Value fleet(Engine& e, const Request& r)
{
    return sdkCall("Read the fleet", [&] {
        auto& a = r.a;
        rj::Value times = timeByDevice(e, a);
        rj::Value list(rj::kArrayType);
        const auto devices = safe<ListPtr<IDevice>>([&] { return e.root.getDevices(); }, nullptr);
        if (devices.assigned())
            for (const auto& device : devices)
            {
                const std::string id = textOr([&] { return device.getGlobalId(); });
                const auto info = safe<DeviceInfoPtr>([&] { return device.getInfo(); }, nullptr);
                const auto infoText = [&](const std::function<BaseObjectPtr()>& getter) { return info.assigned() ? textOr(getter) : ""; };
                const auto channels = safe<ListPtr<IChannel>>([&] { return device.getChannels(); }, nullptr);
                int64_t total = 0;
                int64_t active = 0;
                if (channels.assigned())
                    for (const auto& channel : channels)
                    {
                        total++;
                        active += safe<bool>([&] { return static_cast<bool>(channel.getActive()); }, false);
                    }

                rj::Value entry(rj::kObjectType);
                entry.AddMember("id", str(id, a), a);
                entry.AddMember("name", str(textOr([&] { return device.getName(); }), a), a);
                entry.AddMember("model", str(infoText([&] { return info.getModel(); }), a), a);
                entry.AddMember("manufacturer", str(infoText([&] { return info.getManufacturer(); }), a), a);
                entry.AddMember("connectionString", str(infoText([&] { return info.getConnectionString(); }), a), a);
                entry.AddMember("connected", isConnected(device), a);
                rj::Value mode;
                isSafe([&] { mode = operationModeJson(static_cast<Int>(device.getOperationMode())); });
                entry.AddMember("operationMode", mode, a);
                rj::Value modes(rj::kArrayType);
                isSafe([&] {
                    for (const auto& item : device.getAvailableOperationModes())
                        if (auto name = operationModeJson(static_cast<Int>(item)); !name.IsNull())
                            modes.PushBack(name, a);
                });
                entry.AddMember("operationModes", modes, a);
                entry.AddMember("status", status(device, a), a);
                rj::Value counts(rj::kObjectType);
                counts.AddMember("total", total, a);
                counts.AddMember("active", active, a);
                entry.AddMember("channels", counts, a);
                entry.AddMember("system", system(device, a), a);
                entry.AddMember("time", times.HasMember(id.c_str()) ? rj::Value(times[id.c_str()], a) : rj::Value(), a);
                entry.AddMember("dashboard", dashboard(device, a), a);
                list.PushBack(entry, a);
            }
        rj::Value out(rj::kObjectType);
        out.AddMember("devices", list, a);
        return out;
    });
}

}  // namespace

void addFleetRoutes(Router& router)
{
    router.add("GET", "/api/fleet", fleet);
}

}  // namespace studio
