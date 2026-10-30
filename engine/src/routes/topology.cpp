// The instance's structure: the dataflow graph, component types, devices,
// function blocks and input ports.

#include "topology_support.h"

#include <algorithm>
#include <cctype>
#include <set>

namespace studio
{

namespace
{

std::string idOf(const ComponentPtr& component)
{
    return safe<std::string>([&] { return textOf(component.getGlobalId()); }, "");
}

std::string nameOf(const ComponentPtr& component)
{
    return safe<std::string>([&] { return textOf(component.getName()); }, "");
}

bool activeOf(const ComponentPtr& component)
{
    return safe<bool>([&] { return static_cast<bool>(component.getActive()); }, true);
}

rj::Value idOrNull(const std::string& id, Alloc& a)
{
    return id.empty() ? rj::Value() : str(id, a);
}

/// The root is "instance", unless it is a real device, such as the phone
/// device the phone app makes its root.
const char* rootKind(Engine& e)
{
    return e.rootIsDevice ? "device" : "instance";
}

// ------------------------------------------------------------------ graph

/// The instance as a dataflow graph for the topology diagram, built in one
/// walk: devices, channels, function blocks, signals and servers as nodes,
/// and their relations as edges. Input ports are not nodes but ports on
/// their function block, as every dataflow editor draws them.
struct Graph
{
    Engine& e;
    bool includeHidden;
    Alloc& a;
    std::string instanceId;
    rj::Value nodes{rj::kArrayType};
    rj::Value edges{rj::kArrayType};
    rj::Value groups{rj::kArrayType};
    std::set<std::string> seen;

    bool addNode(rj::Value node)
    {
        const std::string id = node["id"].GetString();
        if (id.empty() || !seen.insert(id).second)
            return false;
        nodes.PushBack(node, a);
        return true;
    }

    void addEdge(const std::string& source, const std::string& target, const char* kind, const std::string& label = "")
    {
        if (source.empty() || target.empty())
            return;
        rj::Value edge(rj::kObjectType);
        edge.AddMember("id", str(std::string(kind) + ":" + source + "->" + target, a), a);
        edge.AddMember("source", str(source, a), a);
        edge.AddMember("target", str(target, a), a);
        edge.AddMember("kind", rj::StringRef(kind), a);
        edge.AddMember("label", str(label, a), a);
        edges.PushBack(edge, a);
    }

    /// A component's statuses, or null when it has none.
    rj::Value status(const ComponentPtr& component)
    {
        rj::Value summary = statusSummary(component, a);
        if (summary["statuses"].ObjectEmpty())
            return rj::Value();
        rj::Value out(rj::kObjectType);
        out.AddMember("level", summary["level"], a);
        out.AddMember("statuses", summary["statuses"], a);
        return out;
    }

    rj::Value base(const ComponentPtr& component, const char* kind, const std::string& group)
    {
        rj::Value node(rj::kObjectType);
        node.AddMember("id", str(idOf(component), a), a);
        node.AddMember("kind", rj::StringRef(kind), a);
        node.AddMember("name", str(nameOf(component), a), a);
        node.AddMember("groupId", idOrNull(group, a), a);
        node.AddMember("active", activeOf(component), a);
        return node;
    }

    rj::Value signalNode(const SignalPtr& signal, const std::string& group)
    {
        const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
        const auto descriptor = safe<DataDescriptorPtr>([&] { return signal.getDescriptor(); }, nullptr);
        const auto domainDescriptor = domain.assigned() ? safe<DataDescriptorPtr>([&] { return domain.getDescriptor(); }, nullptr) : nullptr;
        rj::Value node = base(signal, "signal", group);
        node.AddMember("status", rj::Value(), a);
        rj::Value detail(rj::kObjectType);
        detail.AddMember("unit", descriptor.assigned() ? unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a) : rj::Value(), a);
        rj::Value sampleType;
        if (descriptor.assigned())
            isSafe([&] { sampleType = str(sampleTypeName(descriptor.getSampleType()), a); });
        detail.AddMember("sampleType", sampleType, a);
        detail.AddMember("sampleRate", sampleRateJson(domainDescriptor), a);
        detail.AddMember("public", safe<bool>([&] { return static_cast<bool>(signal.getPublic()); }, true), a);
        detail.AddMember("streamed", safe<bool>([&] { return static_cast<bool>(signal.getStreamed()); }, false), a);
        // A signal with no domain signal is one: it carries the timestamps.
        detail.AddMember("isDomain", !domain.assigned(), a);
        detail.AddMember("domainSignalId", domain.assigned() ? str(idOf(domain), a) : rj::Value(), a);
        detail.AddMember("domainSignalName", domain.assigned() ? str(nameOf(domain), a) : rj::Value(), a);
        node.AddMember("detail", detail, a);
        return node;
    }

    rj::Value deviceNode(const DevicePtr& device, const std::string& group)
    {
        const auto info = safe<DeviceInfoPtr>([&] { return device.getInfo(); }, nullptr);
        const auto text = [&](auto getter) { return info.assigned() ? safe<std::string>([&] { return textOf(getter()); }, "") : ""; };
        const bool isRoot = idOf(device) == instanceId;
        rj::Value node = base(device, isRoot ? rootKind(e) : "device", group);
        node.AddMember("status", status(device), a);
        rj::Value detail(rj::kObjectType);
        detail.AddMember("connectionString", str(text([&] { return info.getConnectionString(); }), a), a);
        detail.AddMember("manufacturer", str(text([&] { return info.getManufacturer(); }), a), a);
        detail.AddMember("model", str(text([&] { return info.getModel(); }), a), a);
        detail.AddMember("serialNumber", str(text([&] { return info.getSerialNumber(); }), a), a);
        detail.AddMember("connected", isConnected(device), a);
        detail.AddMember("locked", safe<bool>([&] { return static_cast<bool>(device.isLocked()); }, false), a);
        rj::Value mode;
        isSafe([&] { mode = operationModeJson(static_cast<Int>(device.getOperationMode())); });
        detail.AddMember("operationMode", mode, a);
        rj::Value protocols(rj::kArrayType);
        if (info.assigned())
            for (const auto& capability : capabilitiesOf(info))
                if (!capability.protocolName.empty())
                    protocols.PushBack(str(capability.protocolName, a), a);
        detail.AddMember("protocols", protocols, a);
        node.AddMember("detail", detail, a);
        return node;
    }

    rj::Value blockNode(const FunctionBlockPtr& block, const std::string& group, const char* kind)
    {
        rj::Value node = base(block, kind, group);
        node.AddMember("status", status(block), a);
        rj::Value ports(rj::kArrayType);
        rj::Value all = inputPortsJson(block, a);
        for (auto& port : all.GetArray())
        {
            rj::Value entry(rj::kObjectType);
            entry.AddMember("id", port["id"], a);
            entry.AddMember("name", port["name"], a);
            entry.AddMember("requiresSignal", port["requiresSignal"], a);
            entry.AddMember("signalId", port["signalId"], a);
            ports.PushBack(entry, a);
        }
        node.AddMember("ports", ports, a);
        const auto type = safe<FunctionBlockTypePtr>([&] { return block.getFunctionBlockType(); }, nullptr);
        rj::Value detail(rj::kObjectType);
        detail.AddMember("typeId", str(type.assigned() ? safe<std::string>([&] { return textOf(type.getId()); }, "") : "", a), a);
        detail.AddMember("typeName", str(type.assigned() ? safe<std::string>([&] { return textOf(type.getName()); }, "") : "", a), a);
        const auto recorder = block.asPtrOrNull<IRecorder>();
        detail.AddMember("recording", recorder.assigned() ? rj::Value(safe<bool>([&] { return static_cast<bool>(recorder.getIsRecording()); }, false)) : rj::Value(), a);
        node.AddMember("detail", detail, a);
        return node;
    }

    /// A component's own signals, not its children's. Hidden ones need the
    /// search filter: a domain signal is not in the default listing at all.
    std::vector<SignalPtr> ownSignals(const ComponentPtr& owner)
    {
        std::vector<SignalPtr> out;
        const SearchFilterPtr filter = includeHidden ? search::Any() : nullptr;
        ListPtr<ISignal> list;
        isSafe([&] {
            if (const auto device = owner.asPtrOrNull<IDevice>(); device.assigned())
                list = device.getSignals(filter);
            else
                list = owner.asPtr<IFunctionBlock>().getSignals(filter);
        });
        if (list.assigned())
            for (const auto& signal : list)
                out.push_back(signal);
        return out;
    }

    void visitSignals(const ComponentPtr& owner, const std::string& ownerId, const std::string& group)
    {
        for (const auto& signal : ownSignals(owner))
        {
            if (addNode(signalNode(signal, group)))
                addEdge(ownerId, idOf(signal), "produces");
            const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
            if (domain.assigned())
                addEdge(idOf(signal), idOf(domain), "domain");
        }
    }

    void visitBlocks(const ComponentPtr& owner, const std::string& group)
    {
        ListPtr<IFunctionBlock> blocks;
        isSafe([&] {
            if (const auto device = owner.asPtrOrNull<IDevice>(); device.assigned())
                blocks = device.getFunctionBlocks();
            else
                blocks = owner.asPtr<IFunctionBlock>().getFunctionBlocks();
        });
        if (!blocks.assigned())
            return;
        for (const auto& block : blocks)
        {
            if (!includeHidden && !safe<bool>([&] { return static_cast<bool>(block.getVisible()); }, true))
                continue;
            if (!addNode(blockNode(block, group, block.supportsInterface<IRecorder>() ? "recorder" : "functionBlock")))
                continue;
            const auto blockId = idOf(block);
            const rj::Value ports = inputPortsJson(block, a);
            for (const auto& port : ports.GetArray())
                if (port["signalId"].IsString())
                    addEdge(port["signalId"].GetString(), blockId, "signal", port["name"].GetString());
            visitSignals(block, blockId, group);
            // Nested function blocks are how the SDK composes processing.
            visitBlocks(block, group);
        }
    }

    void visitDevice(const DevicePtr& device, const std::string& parentId)
    {
        const auto deviceId = idOf(device);
        if (!addNode(deviceNode(device, parentId)))
            return;
        rj::Value group(rj::kObjectType);
        group.AddMember("id", str(deviceId, a), a);
        group.AddMember("name", str(nameOf(device), a), a);
        group.AddMember("parentId", idOrNull(parentId, a), a);
        group.AddMember("kind", rj::StringRef(deviceId == instanceId ? rootKind(e) : "device"), a);
        groups.PushBack(group, a);
        if (!parentId.empty())
            addEdge(parentId, deviceId, "contains");

        visitSignals(device, deviceId, deviceId);
        const auto channels = safe<ListPtr<IChannel>>([&] { return device.getChannels(); }, nullptr);
        if (channels.assigned())
            for (const auto& channel : channels)
            {
                if (!includeHidden && !safe<bool>([&] { return static_cast<bool>(channel.getVisible()); }, true))
                    continue;
                const auto channelId = idOf(channel);
                if (addNode(blockNode(channel, deviceId, "channel")))
                {
                    addEdge(deviceId, channelId, "contains");
                    visitSignals(channel, channelId, deviceId);
                }
            }
        visitBlocks(device, deviceId);
        const auto children = safe<ListPtr<IDevice>>([&] { return device.getDevices(); }, nullptr);
        if (children.assigned())
            for (const auto& child : children)
                visitDevice(child, deviceId);
    }

    rj::Value build()
    {
        instanceId = idOf(e.root);
        visitDevice(e.root, "");
        const auto servers = safe<ListPtr<IServer>>([&] { return e.instance.getServers(); }, nullptr);
        if (servers.assigned())
            for (const auto& server : servers)
            {
                rj::Value node = base(server, "server", instanceId);
                node.AddMember("status", rj::Value(), a);
                rj::Value detail(rj::kObjectType);
                detail.AddMember("typeId", str(safe<std::string>([&] { return textOf(server.getId()); }, ""), a), a);
                node.AddMember("detail", detail, a);
                if (addNode(std::move(node)))
                    addEdge(instanceId, idOf(server), "publishes");
            }

        // Only edges whose ends are both present: a signal can point at a
        // hidden domain signal, or at one on a device the walk did not reach.
        rj::Value kept(rj::kArrayType);
        int64_t connections = 0;
        for (auto& edge : edges.GetArray())
            if (seen.count(edge["source"].GetString()) && seen.count(edge["target"].GetString()))
            {
                connections += std::string(edge["kind"].GetString()) == "signal";
                kept.PushBack(edge, a);
            }
        rj::Value byKind(rj::kObjectType);
        for (const auto& node : nodes.GetArray())
        {
            const auto& kind = node["kind"];
            if (byKind.HasMember(kind))
                byKind[kind].SetInt64(byKind[kind].GetInt64() + 1);
            else
                byKind.AddMember(rj::Value(kind, a), rj::Value(int64_t{1}), a);
        }
        rj::Value stats(rj::kObjectType);
        stats.AddMember("nodes", nodes.Size(), a);
        stats.AddMember("edges", kept.Size(), a);
        stats.AddMember("byKind", byKind, a);
        stats.AddMember("connections", connections, a);

        rj::Value out(rj::kObjectType);
        out.AddMember("instanceId", str(instanceId, a), a);
        out.AddMember("nodes", nodes, a);
        out.AddMember("edges", kept, a);
        out.AddMember("groups", groups, a);
        out.AddMember("stats", stats, a);
        return out;
    }
};

rj::Value graph(Engine& e, const Request& r)
{
    return sdkCall("Build topology graph", [&] { return Graph{e, queryFlag(r, "includeHidden"), r.a}.build(); });
}

// ------------------------------------------------------------------ types

rj::Value deviceTypes(Engine& e, const Request& r)
{
    return sdkCall("List device types", [&] {
        rj::Value out(rj::kObjectType);
        out.AddMember("types", deviceTypesJson(deviceAt(e, queryString(r.query, "id")), r.a), r.a);
        return out;
    });
}

rj::Value functionBlockTypes(Engine& e, const Request& r)
{
    return sdkCall("List function block types", [&] {
        const std::string id = queryString(r.query, "id");
        const ComponentPtr host = id.empty() ? ComponentPtr(e.root) : componentAt(e, id);
        rj::Value out(rj::kObjectType);
        out.AddMember("hostId", str(idOf(host), r.a), r.a);
        out.AddMember("types", functionBlockTypesJson(host, r.a), r.a);
        return out;
    });
}

/// The settings a type offers, so a dialog can show them before anything
/// is created.
rj::Value typeConfig(Engine& e, const Request& r)
{
    const std::string kind = requiredQuery(r, "kind");
    const std::string typeId = requiredQuery(r, "typeId");
    return sdkCall("Read type default config", [&] {
        auto& a = r.a;
        const std::string hostId = queryString(r.query, "hostId");
        const ComponentPtr host = hostId.empty() ? ComponentPtr(e.root) : componentAt(e, hostId);
        rj::Value entries;
        DictPtr<IBaseObject, IBaseObject> raw;
        if (kind == "device")
        {
            entries = deviceTypesJson(host, a);
            raw = deviceAt(e, hostId).getAvailableDeviceTypes().asPtr<IDict>();
        }
        else if (kind == "functionBlock")
        {
            entries = functionBlockTypesJson(host, a);
            // A component that holds no function blocks offers no types.
            if (const auto device = host.asPtrOrNull<IDevice>(); device.assigned())
                raw = device.getAvailableFunctionBlockTypes().asPtr<IDict>();
            else if (const auto block = host.asPtrOrNull<IFunctionBlock>(); block.assigned())
                raw = block.getAvailableFunctionBlockTypes().asPtr<IDict>();
        }
        else if (kind == "server")
        {
            entries = serverTypesJson(e, a);
            raw = e.instance.getAvailableServerTypes().asPtr<IDict>();
        }
        else
            entries = streamingTypesJson(e, a);

        rj::Value type;
        for (auto& entry : entries.GetArray())
            if (typeId == entry["id"].GetString())
                type = entry;
        rj::Value out(rj::kObjectType);
        out.AddMember("kind", str(kind, a), a);
        out.AddMember("typeId", str(typeId, a), a);
        out.AddMember("type", type, a);
        out.AddMember("config", raw.assigned() && raw.hasKey(String(typeId)) ? defaultConfigJson(raw.get(String(typeId)).asPtr<IComponentType>(), a) : rj::Value(), a);
        return out;
    });
}

// ------------------------------------------------------------------ devices

/// Discovery: the devices a device can see, each marked when it is this
/// instance itself, so the dialog can say so rather than only refuse.
rj::Value discover(Engine& e, const Request& r)
{
    return sdkCall("Discover devices", [&] {
        auto& a = r.a;
        const auto parent = deviceAt(e, queryString(r.query, "id"));
        rj::Value devices(rj::kArrayType);
        const auto available = safe<ListPtr<IDeviceInfo>>([&] { return parent.getAvailableDevices(); }, nullptr);
        if (available.assigned())
            for (const auto& info : available)
            {
                rj::Value device = deviceInfoJson(info, false, a);
                const std::string reason = selfRefusal(e, device["connectionString"].GetString());
                // The phone, as the root, is found by its own discovery.
                device.AddMember("isSelf", !reason.empty() || (e.rootIsDevice && e.isSelf(info)), a);
                if (!reason.empty())
                    device.AddMember("selfReason", str(reason, a), a);
                devices.PushBack(device, a);
            }
        rj::Value out(rj::kObjectType);
        out.AddMember("parentId", hasQuery(r, "id") ? str(queryString(r.query, "id"), a) : rj::Value(), a);
        out.AddMember("devices", devices, a);
        return out;
    });
}

/// The protocol a connection string selects, or empty when nothing loaded
/// offers its prefix.
std::string impliedProtocol(Engine& e, const DevicePtr& parent, const std::string& connection, Alloc& a)
{
    const auto separator = connection.find("://");
    if (separator == std::string::npos || separator == 0 || separator + 3 == connection.size())
        return "";
    const std::string prefix = connection.substr(0, separator);
    if (prefix == "daq")
        return "SmartConnectionString";
    const rj::Value lists[] = {deviceTypesJson(parent, a), streamingTypesJson(e, a)};
    for (const auto& list : lists)
        for (const auto& entry : list.GetArray())
            if (entry["connectionStringPrefix"].IsString() && prefix == entry["connectionStringPrefix"].GetString())
                return entry["id"].GetString();
    return "";
}

std::vector<std::string> sectionNames(const PropertyObjectPtr& config, const char* section)
{
    std::vector<std::string> out;
    isSafe([&] {
        if (!config.hasProperty(section))
            return;
        const auto object = config.getPropertyValue(section).asPtrOrNull<IPropertyObject>();
        if (object.assigned())
            for (const auto& property : object.getAllProperties())
                out.push_back(textOf(property.getName()));
    });
    return out;
}

/// Everything the "Add with config" dialog needs for one connection string:
/// the protocols and address types that apply and the default config tree.
/// The config is built fresh again when the device is added, so a stale
/// dialog never refers to a config object that no longer exists.
rj::Value connectionPlan(Engine& e, const Request& r)
{
    return sdkCall("Build connection plan", [&] {
        auto& a = r.a;
        const std::string connection = trimmed(queryString(r.query, "connectionString"));
        const auto parent = deviceAt(e, queryString(r.query, "id"));
        const std::string protocol = connection.empty() ? "" : impliedProtocol(e, parent, connection, a);
        const auto discovered = connection.empty() ? nullptr : findAvailableDevice(parent, connection);
        const auto config = parent.createDefaultAddDeviceConfig();
        const auto deviceProtocols = sectionNames(config, "Device");
        const auto streamingProtocols = sectionNames(config, "Streaming");
        const auto offers = [](const std::vector<std::string>& list, const std::string& id) { return std::find(list.begin(), list.end(), id) != list.end(); };

        std::vector<Capability> capabilities;
        bool hasStreaming = true;
        bool hasTcpIp = true;
        std::vector<std::string> configProtocols;
        std::vector<std::string> streaming;
        if (discovered.assigned())
        {
            capabilities = capabilitiesOf(discovered);
            hasTcpIp = std::any_of(capabilities.begin(), capabilities.end(), [](const auto& c) { return c.connectionType == "TCP/IP"; });
            hasStreaming = std::any_of(capabilities.begin(), capabilities.end(),
                                       [](const auto& c) { return c.protocolType == "Streaming" || c.protocolType == "ConfigurationAndStreaming"; });
            for (const auto& capability : capabilities)
            {
                if (offers(deviceProtocols, capability.protocolId))
                    configProtocols.push_back(capability.protocolId);
                if (offers(streamingProtocols, capability.protocolId))
                    streaming.push_back(capability.protocolId);
            }
            // A local device, such as the reference device, is discoverable
            // but advertises no server; its config section is the one its
            // connection string names.
            if (configProtocols.empty() && offers(deviceProtocols, protocol))
                configProtocols.push_back(protocol);
        }
        else
        {
            // Not discoverable: the protocol the string implies, and every
            // streaming protocol the modules provide.
            if (offers(deviceProtocols, protocol))
                configProtocols.push_back(protocol);
            streaming = offers(streamingProtocols, protocol) ? std::vector<std::string>{protocol} : streamingProtocols;
        }

        rj::Value errors(rj::kArrayType);
        if (!connection.empty() && protocol.empty())
            errors.PushBack(rj::StringRef("Connection string does not match any loaded device or streaming protocol."), a);
        if (protocol == "SmartConnectionString" && !discovered.assigned())
            errors.PushBack(rj::StringRef("'daq://' connection strings only work for discoverable devices."), a);

        const auto list = [&](const std::vector<std::string>& items) {
            rj::Value out(rj::kArrayType);
            for (const auto& item : items)
                out.PushBack(str(item, a), a);
            return out;
        };
        std::set<std::string> addressTypes;
        for (const auto& capability : capabilities)
            for (const auto& address : capability.addresses)
                addressTypes.insert(address.first);

        rj::Value out(rj::kObjectType);
        out.AddMember("connectionString", str(connection, a), a);
        out.AddMember("impliedProtocol", protocol.empty() ? rj::Value() : str(protocol, a), a);
        out.AddMember("discoverable", discovered.assigned(), a);
        out.AddMember("deviceInfo", discovered.assigned() ? deviceInfoJson(discovered, true, a) : rj::Value(), a);
        out.AddMember("serverCapabilities", capabilitiesJson(capabilities, a), a);
        out.AddMember("hasStreaming", hasStreaming, a);
        out.AddMember("hasTcpIp", hasTcpIp, a);
        out.AddMember("configProtocols", list(configProtocols), a);
        out.AddMember("streamingProtocols", list(streaming), a);
        out.AddMember("addressTypes", list(std::vector<std::string>(addressTypes.begin(), addressTypes.end())), a);
        out.AddMember("generalWidgetKeys", list({"AllowedStreamingProtocols", "AutomaticallyConnectStreaming", "PrimaryAddressType"}), a);
        out.AddMember("config", configJson(config, a), a);
        out.AddMember("errors", errors, a);
        return out;
    });
}

rj::Value deviceInfo(Engine& e, const Request& r)
{
    const std::string connection = requiredQuery(r, "connectionString");
    return sdkCall("Read device info", [&] {
        const auto info = findAvailableDevice(deviceAt(e, queryString(r.query, "id")), connection);
        if (!info.assigned())
            fail(404, "not_found", "no discovered device matches " + connection);
        return deviceInfoJson(info, true, r.a);
    });
}

/// Connects a device below a parent device, with a flat map of settings
/// applied to a fresh default config.
rj::Value addDevice(Engine& e, const Request& r)
{
    auto& a = r.a;
    const auto& body = bodyOf(r, {"connectionString", "parentId", "allowSelfConnection", "config"});
    const std::string requested = textMember(body, "connectionString", true);
    const std::string parentId = textMember(body, "parentId", false);
    const bool allowSelf = flagMember(body, "allowSelfConnection", false);
    const auto* values = configValues(body);
    rj::Value out = sdkCall("Add device " + requested, [&] {
        const auto parent = deviceAt(e, parentId);
        const std::string connection = trimmed(requested);
        if (connection.empty())
            fail(400, "bad_request", "connection string is required");
        if (!allowSelf)
            if (const auto refusal = selfRefusal(e, connection); !refusal.empty())
                fail(409, "conflict", "this would connect openDAQ Studio to itself", refusal);

        PropertyObjectPtr config;
        std::vector<std::string> ignored;
        if (values)
        {
            config = parent.createDefaultAddDeviceConfig();
            ignored = applyConfig(config, *values, e.context.getTypeManager());
        }
        const auto device = parent.addDevice(connection, config);
        if (!device.assigned())
            fail(400, "bad_request", "device could not be added: " + connection);
        // A phone that shares itself is found by its own discovery. Added to
        // itself, it would contain itself without end.
        if (e.rootIsDevice && !allowSelf && e.isSelf(device.getInfo()))
        {
            parent.removeDevice(device);
            fail(409, "self", "This is the phone itself. Other computers can add it while it is shared, but it cannot add itself.");
        }
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(idOf(device), a), a);
        result.AddMember("name", str(nameOf(device), a), a);
        result.AddMember("connectionString", str(connection, a), a);
        rj::Value keys(rj::kArrayType);
        for (const auto& key : ignored)
            keys.PushBack(str(key, a), a);
        result.AddMember("ignoredConfigKeys", keys, a);
        return result;
    });
    const std::string name = out["name"].GetString();
    notify(e, "success", "Connected " + (name.empty() ? requested : name), requested, out["componentId"].GetString());
    e.invalidateTree("deviceAdded");
    return out;
}

rj::Value removeDevice(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    rj::Value out = sdkCall("Remove device", [&] {
        const auto device = deviceAt(e, id);
        if (idOf(device) == idOf(e.root))
            fail(400, "bad_request", "the root device cannot be removed");
        const auto parent = nearestDevice(safe<ComponentPtr>([&] { return device.getParent(); }, nullptr));
        if (!parent.assigned())
            fail(404, "not_found", "parent device not found");
        const std::string parentId = idOf(parent);
        parent.removeDevice(device);
        rj::Value result(rj::kObjectType);
        result.AddMember("removedId", str(id, r.a), r.a);
        result.AddMember("parentId", str(parentId, r.a), r.a);
        return result;
    });
    // Readers under a removed device can never produce samples again.
    e.pruneStreams();
    notify(e, "warning", "Device removed", id, "");
    e.invalidateTree("deviceRemoved");
    return out;
}

rj::Value setLock(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const auto& body = bodyOf(r, {"locked", "force"});
    const bool locked = flagMember(body, "locked");
    const bool force = flagMember(body, "force", false);
    rj::Value out = sdkCall("Set device lock", [&] {
        const auto device = deviceAt(e, id);
        if (locked)
            device.lock();
        else if (force)
            device.asPtr<IDevicePrivate>().forceUnlock();
        else
            device.unlock();
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(id, r.a), r.a);
        result.AddMember("locked", safe<bool>([&] { return static_cast<bool>(device.isLocked()); }, locked), r.a);
        return result;
    });
    notify(e, force ? "warning" : "info", std::string("Device ") + (locked ? "locked" : "unlocked") + (force && !locked ? " (forced)" : ""), "", id);
    e.invalidateTree("deviceLock");
    return out;
}

OperationModeType modeNamed(const std::string& name)
{
    if (name == "Unknown")
        return OperationModeType::Unknown;
    if (name == "Idle")
        return OperationModeType::Idle;
    if (name == "Operation")
        return OperationModeType::Operation;
    if (name == "SafeOperation")
        return OperationModeType::SafeOperation;
    fail(404, "not_found", "unknown operation mode: " + name);
}

rj::Value setOperationMode(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const auto& body = bodyOf(r, {"mode", "recursive"});
    if (!body.HasMember("mode") || !body["mode"].IsString())
        fail(422, "invalid_request", "The request needs mode");
    const std::string mode = body["mode"].GetString();
    const bool recursive = flagMember(body, "recursive", false);
    return sdkCall("Set operation mode", [&] {
        const auto device = deviceAt(e, id);
        const auto value = modeNamed(mode);
        if (recursive)
            device.setOperationModeRecursive(value);
        else
            device.setOperationMode(value);
        e.invalidateTree("operationMode");
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(id, r.a), r.a);
        result.AddMember("operationMode", str(mode, r.a), r.a);
        return result;
    });
}

// ------------------------------------------------------------------ function blocks

/// The nearest function block at or above a component, or null.
FunctionBlockPtr nearestFunctionBlock(ComponentPtr component)
{
    while (component.assigned())
    {
        if (const auto block = component.asPtrOrNull<IFunctionBlock>(); block.assigned())
            return block;
        component = safe<ComponentPtr>([&] { return component.getParent(); }, nullptr);
    }
    return nullptr;
}

/// Adds a function block to a device, to another function block, or to the
/// device that holds any other component.
rj::Value addFunctionBlock(Engine& e, const Request& r)
{
    auto& a = r.a;
    const auto& body = bodyOf(r, {"typeId", "parentId", "config"});
    const std::string typeId = textMember(body, "typeId", true);
    const std::string parentId = textMember(body, "parentId", false);
    const auto* values = configValues(body);
    rj::Value out = sdkCall("Add function block " + typeId, [&] {
        const ComponentPtr parent = parentId.empty() ? ComponentPtr(e.root) : componentAt(e, parentId);
        ComponentPtr owner = parent;
        if (!parent.supportsInterface<IDevice>() && !parent.supportsInterface<IFunctionBlock>())
        {
            owner = nearestDevice(parent);
            if (!owner.assigned())
                owner = e.root;
        }
        const auto device = owner.asPtrOrNull<IDevice>();

        PropertyObjectPtr config;
        std::vector<std::string> ignored;
        if (values)
        {
            isSafe([&] {
                const auto types = device.assigned() ? device.getAvailableFunctionBlockTypes() : owner.asPtr<IFunctionBlock>().getAvailableFunctionBlockTypes();
                if (types.hasKey(String(typeId)))
                    config = types.get(String(typeId)).createDefaultConfig();
            });
            if (config.assigned())
                ignored = applyConfig(config, *values, e.context.getTypeManager());
        }
        const auto block = device.assigned() ? device.addFunctionBlock(typeId, config) : owner.asPtr<IFunctionBlock>().addFunctionBlock(typeId, config);
        if (!block.assigned())
            fail(400, "bad_request", "function block could not be added: " + typeId);
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(idOf(block), a), a);
        result.AddMember("name", str(nameOf(block), a), a);
        result.AddMember("typeId", str(typeId, a), a);
        result.AddMember("parentId", str(idOf(owner), a), a);
        rj::Value keys(rj::kArrayType);
        for (const auto& key : ignored)
            keys.PushBack(str(key, a), a);
        result.AddMember("ignoredConfigKeys", keys, a);
        return result;
    });
    const std::string name = out["name"].GetString();
    notify(e, "success", "Added " + (name.empty() ? typeId : name), "", out["componentId"].GetString());
    e.invalidateTree("functionBlockAdded");
    return out;
}

rj::Value removeFunctionBlock(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    rj::Value out = sdkCall("Remove function block", [&] {
        const auto component = componentAt(e, id);
        const auto block = component.asPtrOrNull<IFunctionBlock>();
        if (!block.assigned())
            fail(400, "bad_request", "component is not a function block");
        if (component.supportsInterface<IChannel>())
            fail(409, "conflict", "channels are provided by the device and cannot be removed");
        const auto parent = safe<ComponentPtr>([&] { return block.getParent(); }, nullptr);
        ComponentPtr owner = nearestFunctionBlock(parent);
        if (!owner.assigned())
            owner = nearestDevice(parent);
        if (!owner.assigned())
            owner = e.root;
        const std::string ownerId = idOf(owner);
        if (const auto device = owner.asPtrOrNull<IDevice>(); device.assigned())
            device.removeFunctionBlock(block);
        else
            owner.asPtr<IFunctionBlock>().removeFunctionBlock(block);
        rj::Value result(rj::kObjectType);
        result.AddMember("removedId", str(id, r.a), r.a);
        result.AddMember("parentId", str(ownerId, r.a), r.a);
        return result;
    });
    e.pruneStreams();
    notify(e, "warning", "Function block removed", id, "");
    e.invalidateTree("functionBlockRemoved");
    return out;
}

rj::Value setRecording(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const bool recording = flagMember(bodyOf(r, {"recording"}), "recording");
    rj::Value out = sdkCall("Set recording", [&] {
        const auto recorder = componentAt(e, id).asPtrOrNull<IRecorder>();
        if (!recorder.assigned())
            fail(400, "bad_request", "component is not a recorder");
        if (recording)
            recorder.startRecording();
        else
            recorder.stopRecording();
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(id, r.a), r.a);
        result.AddMember("recording", safe<bool>([&] { return static_cast<bool>(recorder.getIsRecording()); }, recording), r.a);
        return result;
    });
    notify(e, recording ? "success" : "info", recording ? "Recording started" : "Recording stopped", "", id);
    return out;
}

// ------------------------------------------------------------------ input ports

rj::Value inputPorts(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    return sdkCall("List input ports", [&] {
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, r.a), r.a);
        out.AddMember("ports", inputPortsJson(componentAt(e, id), r.a), r.a);
        return out;
    });
}

std::string lowerName(const rj::Value& signal)
{
    std::string name = signal["name"].GetString();
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return name;
}

/// The signals a port may read: every one in the instance, as openDAQ
/// connects across devices, with the port's own device's first.
rj::Value portCandidates(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const bool includeHidden = queryFlag(r, "includeHidden");
    return sdkCall("List connectable signals", [&] {
        auto& a = r.a;
        const auto component = componentAt(e, id);
        if (!component.supportsInterface<IInputPort>())
            fail(400, "bad_request", "component is not an input port");
        const auto device = nearestDevice(component);
        const std::string ownDevice = idOf(device.assigned() ? device : e.root);

        std::vector<rj::Value> entries;
        const SearchFilterPtr filter = includeHidden ? search::Any() : nullptr;
        for (const auto& signal : e.instance.getSignalsRecursive(filter))
        {
            rj::Value info = signalInfo(signal, a);
            if (!includeHidden && !info["public"].GetBool())
                continue;
            info.AddMember("local", info["deviceId"].IsString() && ownDevice == info["deviceId"].GetString(), a);
            entries.push_back(std::move(info));
        }
        std::stable_sort(entries.begin(), entries.end(), [](const rj::Value& x, const rj::Value& y) {
            const bool xLocal = x["local"].GetBool();
            const bool yLocal = y["local"].GetBool();
            if (xLocal != yLocal)
                return xLocal;
            return lowerName(x) < lowerName(y);
        });
        rj::Value signals(rj::kArrayType);
        for (auto& entry : entries)
            signals.PushBack(entry, a);
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, a), a);
        out.AddMember("signals", signals, a);
        return out;
    });
}

/// Connects a signal to an input port, or disconnects the port for a null
/// signal.
rj::Value connectPort(Engine& e, const Request& r)
{
    const std::string id = requiredQuery(r, "id");
    const std::string signalId = textMember(bodyOf(r, {"signalId"}), "signalId", false);
    return sdkCall("Connect input port", [&] {
        auto& a = r.a;
        const auto port = componentAt(e, id).asPtrOrNull<IInputPort>();
        if (!port.assigned())
            fail(400, "bad_request", "component is not an input port");
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, a), a);
        e.invalidateTree("portConnection");
        if (signalId.empty())
        {
            port.disconnect();
            out.AddMember("signalId", rj::Value(), a);
            return out;
        }
        const auto signal = componentAt(e, signalId).asPtrOrNull<ISignal>();
        if (!signal.assigned())
            fail(400, "bad_request", "target is not a signal");
        port.connect(signal);
        const auto connected = safe<SignalPtr>([&] { return port.getSignal(); }, nullptr);
        out.AddMember("signalId", connected.assigned() ? str(idOf(connected), a) : rj::Value(), a);
        return out;
    });
}

}  // namespace

void addTopologyRoutes(Router& router)
{
    router.add("GET", "/api/topology/graph", graph);
    router.add("GET", "/api/device-types", deviceTypes);
    router.add("GET", "/api/function-block-types", functionBlockTypes);
    router.add("GET", "/api/type-config", typeConfig);
    router.add("GET", "/api/devices/discover", discover);
    router.add("GET", "/api/devices/connection-plan", connectionPlan);
    router.add("GET", "/api/devices/info", deviceInfo);
    router.add("POST", "/api/devices", addDevice);
    router.add("DELETE", "/api/devices", removeDevice);
    router.add("PUT", "/api/devices/lock", setLock);
    router.add("PUT", "/api/devices/operation-mode", setOperationMode);
    router.add("POST", "/api/function-blocks", addFunctionBlock);
    router.add("DELETE", "/api/function-blocks", removeFunctionBlock);
    router.add("PUT", "/api/function-blocks/recording", setRecording);
    router.add("GET", "/api/input-ports", inputPorts);
    router.add("GET", "/api/input-ports/candidates", portCandidates);
    router.add("PUT", "/api/input-ports/connection", connectPort);
}

}  // namespace studio
