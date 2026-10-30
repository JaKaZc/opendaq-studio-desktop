// /api/components: the component tree, a component's detail, attributes and
// statuses, and switching components on and off.

#include "properties.h"
#include "routes.h"

#include <algorithm>
#include <map>
#include <set>

namespace studio
{

namespace
{

/// openDAQ's terse default folder IDs, and what a person wants to read.
const std::map<std::string, std::string> kFolderLabels = {
    {"Sig", "Signals"}, {"FB", "Function blocks"}, {"Dev", "Devices"},          {"IP", "Input ports"},
    {"IO", "Inputs/Outputs"}, {"Srv", "Servers"}, {"Sync", "Synchronization"},
};

std::string textOr(const std::function<BaseObjectPtr()>& getter, const std::string& fallback = "")
{
    return safe<std::string>([&] { return textOf(getter()); }, fallback);
}

rj::Value textOrNull(const std::function<BaseObjectPtr()>& getter, Alloc& a)
{
    rj::Value out;
    isSafe([&] { out = str(textOf(getter()), a); });
    return out;
}

bool flag(const std::function<Bool()>& getter, bool fallback)
{
    return safe<bool>([&] { return static_cast<bool>(getter()); }, fallback);
}

rj::Value textList(const std::function<ListPtr<IBaseObject>()>& getter, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    if (!isSafe([&] {
            for (const auto& item : getter())
                out.PushBack(str(textOf(item), a), a);
        }))
        out.SetArray();
    return out;
}

rj::Value tagsOf(const ComponentPtr& component, Alloc& a)
{
    return textList([&] { return component.getTags().getList(); }, a);
}

/// Function block types this instance has a module for. A device can hold
/// function blocks whose module lives only on the device; the UI says why
/// those cannot be built here.
std::set<std::string> knownFunctionBlockTypes(Engine& e)
{
    std::set<std::string> types;
    isSafe([&] {
        for (const auto& module : e.instance.getModuleManager().getModules())
            isSafe([&] {
                for (const auto& [id, type] : module.getAvailableFunctionBlockTypes())
                    types.insert(id.toStdString());
            });
    });
    return types;
}

/// One component without its children.
rj::Value componentNode(Engine& e, const ComponentPtr& component, const std::set<std::string>& knownTypes, Alloc& a)
{
    const std::string kind = kindOf(component, e.root, e.rootIsDevice);
    const std::string localId = textOr([&] { return component.getLocalId(); });
    std::string name = textOr([&] { return component.getName(); });
    if (name.empty())
        name = localId;
    const auto parent = safe<ComponentPtr>([&] { return component.getParent(); }, nullptr);
    const auto label = kFolderLabels.find(localId);
    const bool defaultFolder = kind == "folder" && label != kFolderLabels.end();

    rj::Value node(rj::kObjectType);
    node.AddMember("id", str(textOr([&] { return component.getGlobalId(); }), a), a);
    node.AddMember("localId", str(localId, a), a);
    node.AddMember("name", str(name, a), a);
    node.AddMember("displayName", str(defaultFolder ? label->second : name, a), a);
    node.AddMember("description", str(textOr([&] { return component.getDescription(); }), a), a);
    node.AddMember("kind", str(kind, a), a);
    node.AddMember("parentId", parent.assigned() ? textOrNull([&] { return parent.getGlobalId(); }, a) : rj::Value(), a);
    node.AddMember("active", flag([&] { return component.getActive(); }, true), a);
    node.AddMember("parentActive", flag([&] { return component.getParentActive(); }, true), a);
    node.AddMember("visible", flag([&] { return component.getVisible(); }, true), a);
    node.AddMember("updating", flag([&] { return component.getUpdating(); }, false), a);
    node.AddMember("tags", tagsOf(component, a), a);
    node.AddMember("lockedAttributes", textList([&] { return component.getLockedAttributes(); }, a), a);
    node.AddMember("isDefaultFolder", defaultFolder, a);
    node.AddMember("status", statusJson(component, a), a);
    node.AddMember("children", rj::Value(rj::kArrayType), a);

    if (kind == "device" || kind == "instance")
    {
        const DevicePtr device = component.asPtr<IDevice>();
        rj::Value facet(rj::kObjectType);
        facet.AddMember("locked", flag([&] { return device.isLocked(); }, false), a);
        facet.AddMember("connected", deviceConnected(device), a);
        rj::Value mode;
        isSafe([&] { mode = str(operationModeName(device.getOperationMode()), a); });
        facet.AddMember("operationMode", mode, a);
        rj::Value modes(rj::kArrayType);
        isSafe([&] {
            for (const auto& available : device.getAvailableOperationModes())
                modes.PushBack(str(operationModeName(static_cast<OperationModeType>(static_cast<Int>(available))), a), a);
        });
        facet.AddMember("availableOperationModes", modes, a);
        facet.AddMember("hasFunctionBlockTypes", safe<bool>([&] { return device.getAvailableFunctionBlockTypes().getCount() > 0; }, false), a);
        facet.AddMember("isRoot", component == e.root, a);
        node.AddMember("device", facet, a);
    }

    if (kind == "functionBlock" || kind == "channel" || kind == "recorder")
    {
        const FunctionBlockPtr block = component.asPtr<IFunctionBlock>();
        const auto recorder = component.asPtrOrNull<IRecorder>();
        rj::Value facet(rj::kObjectType);
        facet.AddMember("isRecorder", recorder.assigned(), a);
        facet.AddMember("isRecording", recorder.assigned() ? rj::Value(flag([&] { return recorder.getIsRecording(); }, false)) : rj::Value(), a);
        facet.AddMember("hasFunctionBlockTypes", safe<bool>([&] { return block.getAvailableFunctionBlockTypes().getCount() > 0; }, false), a);
        facet.AddMember("inputPortCount", safe<int64_t>([&] { return static_cast<int64_t>(block.getInputPorts().getCount()); }, 0), a);
        const std::string typeId = textOr([&] { return block.getFunctionBlockType().getId(); });
        facet.AddMember("typeId", textOrNull([&] { return block.getFunctionBlockType().getId(); }, a), a);
        facet.AddMember("typeName", textOrNull([&] { return block.getFunctionBlockType().getName(); }, a), a);
        // A channel of a type there is no module for comes with its device
        // and works; only standalone function blocks need the module.
        facet.AddMember("moduleAvailable", typeId.empty() || kind == "channel" ? rj::Value() : rj::Value(knownTypes.count(typeId) > 0), a);
        node.AddMember("functionBlock", facet, a);
    }

    if (kind == "signal")
    {
        const SignalPtr signal = component.asPtr<ISignal>();
        const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
        rj::Value facet(rj::kObjectType);
        facet.AddMember("public", flag([&] { return signal.getPublic(); }, true), a);
        facet.AddMember("streamed", flag([&] { return signal.getStreamed(); }, false), a);
        facet.AddMember("domainSignalId", domain.assigned() ? textOrNull([&] { return domain.getGlobalId(); }, a) : rj::Value(), a);
        facet.AddMember("hasDescriptor", safe<bool>([&] { return signal.getDescriptor().assigned(); }, false), a);
        node.AddMember("signal", facet, a);
    }

    if (kind == "inputPort")
    {
        const InputPortPtr port = component.asPtr<IInputPort>();
        const auto connected = safe<SignalPtr>([&] { return port.getSignal(); }, nullptr);
        rj::Value facet(rj::kObjectType);
        facet.AddMember("requiresSignal", flag([&] { return port.getRequiresSignal(); }, false), a);
        facet.AddMember("signalId", connected.assigned() ? textOrNull([&] { return connected.getGlobalId(); }, a) : rj::Value(), a);
        facet.AddMember("signalName", connected.assigned() ? textOrNull([&] { return connected.getName(); }, a) : rj::Value(), a);
        node.AddMember("inputPort", facet, a);
    }

    if (kind == "server")
    {
        const ServerPtr server = component.asPtr<IServer>();
        rj::Value facet(rj::kObjectType);
        facet.AddMember("typeId", textOrNull([&] { return server.getId(); }, a), a);
        node.AddMember("server", facet, a);
    }
    return node;
}

/// A component and everything below it. Hidden components are left out
/// unless asked for; a device's custom components are marked.
void walk(Engine& e, const ComponentPtr& component, bool includeHidden, bool custom, const std::set<std::string>& knownTypes,
          rj::Value& into, Alloc& a)
{
    if (!includeHidden && !flag([&] { return component.getVisible(); }, true))
        return;
    rj::Value node = componentNode(e, component, knownTypes, a);
    node.AddMember("isCustomComponent", custom, a);
    auto& children = node["children"];
    if (const auto folder = component.asPtrOrNull<IFolder>(); folder.assigned())
    {
        const auto items = safe<ListPtr<IComponent>>([&] { return folder.getItems(includeHidden ? search::Any() : nullptr); }, nullptr);
        if (items.assigned())
            for (const auto& item : items)
                walk(e, item, includeHidden, custom, knownTypes, children, a);
    }
    if (const auto device = component.asPtrOrNull<IDevice>(); device.assigned())
    {
        const auto items = safe<ListPtr<IComponent>>([&] { return device.getCustomComponents(); }, nullptr);
        if (items.assigned())
            for (const auto& item : items)
                walk(e, item, includeHidden, true, knownTypes, children, a);
    }
    if (into.IsArray())
        into.PushBack(node, a);
    else
        into = node;
}

/// The attributes the Attributes dialog shows, with what may be changed.
rj::Value attributesOf(const ComponentPtr& component, Alloc& a)
{
    std::set<std::string> locked;
    isSafe([&] {
        for (const auto& name : component.getLockedAttributes())
            locked.insert(name.toStdString());
    });
    rj::Value list(rj::kArrayType);
    const auto entry = [&](const char* key, const char* label, rj::Value value, const char* valueType, bool writable = true)
    {
        rj::Value item(rj::kObjectType);
        item.AddMember("key", rj::StringRef(key), a);
        item.AddMember("label", rj::StringRef(label), a);
        item.AddMember("value", value, a);
        item.AddMember("valueType", rj::StringRef(valueType), a);
        item.AddMember("locked", !writable || locked.count(key) > 0, a);
        list.PushBack(item, a);
    };
    const auto text = [&](const std::function<BaseObjectPtr()>& getter) { return str(textOr(getter), a); };

    entry("Name", "Name", text([&] { return component.getName(); }), "string");
    entry("Description", "Description", text([&] { return component.getDescription(); }), "string");
    entry("Active", "Active", rj::Value(flag([&] { return component.getActive(); }, true)), "bool");
    entry("Visible", "Visible", rj::Value(flag([&] { return component.getVisible(); }, true)), "bool");
    entry("Tags", "Tags", tagsOf(component, a), "list");
    entry("GlobalId", "Global ID", text([&] { return component.getGlobalId(); }), "string", false);
    entry("LocalId", "Local ID", text([&] { return component.getLocalId(); }), "string", false);

    if (const auto signal = component.asPtrOrNull<ISignal>(); signal.assigned())
    {
        const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
        rj::Value related(rj::kArrayType);
        isSafe([&] {
            for (const auto& other : signal.getRelatedSignals())
                related.PushBack(str(textOf(other.getGlobalId()), a), a);
        });
        entry("Public", "Public", rj::Value(flag([&] { return signal.getPublic(); }, true)), "bool");
        entry("DomainSignalId", "Domain signal", domain.assigned() ? text([&] { return domain.getGlobalId(); }) : str("", a), "string", false);
        entry("RelatedSignals", "Related signals", std::move(related), "list", false);
        entry("Streamed", "Streamed", rj::Value(flag([&] { return signal.getStreamed(); }, false)), "bool", false);
    }

    if (const auto port = component.asPtrOrNull<IInputPort>(); port.assigned())
    {
        const auto connected = safe<SignalPtr>([&] { return port.getSignal(); }, nullptr);
        entry("Public", "Public", rj::Value(flag([&] { return port.getPublic(); }, true)), "bool");
        entry("SignalId", "Connected signal", connected.assigned() ? text([&] { return connected.getGlobalId(); }) : str("", a), "string", false);
        entry("RequiresSignal", "Requires signal", rj::Value(flag([&] { return port.getRequiresSignal(); }, false)), "bool", false);
    }
    return list;
}

/// The texts in a JSON value: a list's items, a string's characters, an
/// object's keys.
std::set<std::string> tagsFrom(const rj::Value& value)
{
    std::set<std::string> out;
    if (!truthy(value))
        return out;
    if (value.IsArray())
        for (const auto& item : value.GetArray())
            out.insert(plainText(item));
    else if (value.IsObject())
        for (const auto& item : value.GetObject())
            out.insert(item.name.GetString());
    else if (value.IsString())
    {
        const std::string text = value.GetString();
        for (size_t i = 0; i < text.size();)
        {
            // One UTF-8 character at a time.
            size_t length = 1;
            const auto lead = static_cast<unsigned char>(text[i]);
            if (lead >= 0xf0)
                length = 4;
            else if (lead >= 0xe0)
                length = 3;
            else if (lead >= 0xc0)
                length = 2;
            out.insert(text.substr(i, length));
            i += length;
        }
    }
    else
        throw std::invalid_argument(std::string("'") + (value.IsBool() ? "bool" : value.IsInt64() ? "int" : "float") +
                                    "' object is not iterable");
    return out;
}

void setAttribute(const ComponentPtr& component, const std::string& key, const rj::Value& value)
{
    const auto locked = safe<ListPtr<IString>>([&] { return component.getLockedAttributes(); }, nullptr);
    if (locked.assigned())
        for (const auto& name : locked)
            if (name.toStdString() == key)
                fail(409, "conflict", "attribute " + reprText(key) + " is locked on this component");

    if (key == "Tags")
    {
        const auto tags = safe<TagsPtr>([&] { return component.getTags(); }, nullptr);
        if (!tags.assigned())
            fail(404, "not_found", "this component has no tag list");
        const auto wanted = tagsFrom(value);
        std::set<std::string> current;
        isSafe([&] {
            for (const auto& tag : tags.getList())
                current.insert(tag.toStdString());
        });
        const auto editable = tags.asPtr<ITagsPrivate>();
        for (const auto& tag : current)
            if (!wanted.count(tag))
                editable.remove(tag);
        for (const auto& tag : wanted)
            if (!current.count(tag))
                editable.add(tag);
        return;
    }

    if (key == "Name")
        component.setName(plainText(value));
    else if (key == "Description")
        component.setDescription(plainText(value));
    else if (key == "Active")
        component.setActive(truthy(value));
    else if (key == "Visible")
        component.setVisible(truthy(value));
    else if (key == "Public")
    {
        if (const auto signal = component.asPtrOrNull<ISignal>(); signal.assigned())
            signal.setPublic(truthy(value));
        else if (const auto port = component.asPtrOrNull<IInputPort>(); port.assigned())
            port.setPublic(truthy(value));
        else
            // The message the API gives for a component without the flag.
            throw std::runtime_error("'opendaq.opendaq.IComponent' object has no attribute 'public' and no __dict__ for setting new attributes");
    }
    else
        fail(404, "not_found", "attribute " + reprText(key) + " is not writable");
}

/// The signals of a device, function block or signal itself, not those of
/// what it holds.
ListPtr<ISignal> signalsOf(const ComponentPtr& component, bool includeHidden)
{
    const auto filter = includeHidden ? search::Any() : nullptr;
    if (const auto signal = component.asPtrOrNull<ISignal>(); signal.assigned())
        return List<ISignal>(signal);
    if (const auto device = component.asPtrOrNull<IDevice>(); device.assigned())
        return device.getSignals(filter);
    if (const auto block = component.asPtrOrNull<IFunctionBlock>(); block.assigned())
        return block.getSignals(filter);
    return List<ISignal>();
}

// ------------------------------------------------------------------ routes

rj::Value tree(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const bool hidden = check.queryFlag("includeHidden");
    check.done();
    return sdkCall("Build component tree", [&] {
        // Asked once for the whole walk: it asks every loaded module.
        const auto knownTypes = knownFunctionBlockTypes(e);
        rj::Value out(rj::kObjectType);
        rj::Value root;
        walk(e, e.root, hidden, false, knownTypes, root, r.a);
        if (root.IsNull())
            root = componentNode(e, e.root, knownTypes, r.a);
        out.AddMember("root", root, r.a);
        out.AddMember("includeHidden", hidden, r.a);
        return out;
    });
}

/// Everything the detail panel shows of a component, in one answer.
rj::Value detail(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    const bool hidden = check.queryFlag("includeHidden");
    check.done();
    return sdkCall("Read component detail", [&] {
        const auto component = lookupComponent(e.root, id);
        auto node = componentNode(e, component, knownFunctionBlockTypes(e), r.a);
        rj::Value signals(rj::kArrayType);
        for (const auto& signal : signalsOf(component, hidden))
        {
            auto info = signalInfoJson(signal, r.a);
            info.AddMember("lastValue", lastValueJson(signal, r.a), r.a);
            signals.PushBack(info, r.a);
        }
        rj::Value properties;
        if (std::string(node["kind"].GetString()) != "inputPort")
            properties = listProperties(component, hidden, r.a);
        else
        {
            properties.SetObject();
            properties.AddMember("componentId", rj::Value(node["id"], r.a), r.a);
            properties.AddMember("className", rj::Value(), r.a);
            properties.AddMember("updating", false, r.a);
            properties.AddMember("properties", rj::Value(rj::kArrayType), r.a);
        }
        rj::Value out(rj::kObjectType);
        out.AddMember("node", node, r.a);
        out.AddMember("attributes", attributesOf(component, r.a), r.a);
        out.AddMember("properties", properties, r.a);
        out.AddMember("inputPorts", inputPortsJson(component, r.a), r.a);
        out.AddMember("signals", signals, r.a);
        return out;
    });
}

rj::Value getAttributes(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.done();
    return sdkCall("Read component attributes", [&] {
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, r.a), r.a);
        out.AddMember("attributes", attributesOf(lookupComponent(e.root, id), r.a), r.a);
        return out;
    });
}

rj::Value putAttribute(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"key", "value"});
    const std::string key = check.text("key");
    const auto* value = check.any("value");
    check.done();
    auto out = sdkCall("Set attribute " + key, [&] {
        const auto component = lookupComponent(e.root, id);
        setAttribute(component, key, *value);
        rj::Value result(rj::kObjectType);
        result.AddMember("componentId", str(id, r.a), r.a);
        result.AddMember("attributes", attributesOf(component, r.a), r.a);
        return result;
    });
    e.pushEvent(R"({"type":"component.updated","payload":{"componentId":)" + quote(id) + R"(,"event":"AttributeWritten"}})");
    return out;
}

rj::Value setActive(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"active"});
    const bool active = check.flag("active");
    check.done();
    return sdkCall("Set active", [&] {
        const auto component = lookupComponent(e.root, id);
        component.setActive(active);
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, r.a), r.a);
        out.AddMember("active", flag([&] { return component.getActive(); }, active), r.a);
        return out;
    });
}

rj::Value statuses(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.done();
    return sdkCall("Read component statuses", [&] {
        auto status = statusJson(lookupComponent(e.root, id), r.a);
        rj::Value out(rj::kObjectType);
        out.AddMember("componentId", str(id, r.a), r.a);
        for (auto& m : status.GetObject())
            out.AddMember(m.name, m.value, r.a);
        return out;
    });
}

/// A route that changes a component as a whole and says so in the event log.
template <typename Change>
void addChangeRoute(Router& router, const char* path, const char* label, const char* message, const char* level, Change change)
{
    router.add("POST", path, [=](Engine& e, const Request& r) {
        Check check(r.query, r.body);
        const std::string id = check.query("id");
        check.done();
        sdkCall(label, [&] { change(PropertyObjectPtr(lookupComponent(e.root, id))); });
        e.pushEvent(notificationEvent(message, level, id));
        return ok(r.a);
    });
}

}  // namespace

void addComponentRoutes(Router& router)
{
    router.add("GET", "/api/components/tree", tree);
    router.add("GET", "/api/components/metadata-fields", [](Engine&, const Request& r) { return metadataFields(r.a); });
    router.add("GET", "/api/components/detail", detail);
    router.add("GET", "/api/components/attributes", getAttributes);
    router.add("PUT", "/api/components/attributes", putAttribute);
    router.add("PUT", "/api/components/active", setActive);
    router.add("GET", "/api/components/statuses", statuses);
    addChangeRoute(router, "/api/components/begin-update", "Begin update", "Update block opened", "info",
                   [](const PropertyObjectPtr& object) { object.beginUpdate(); });
    addChangeRoute(router, "/api/components/end-update", "End update", "Update block committed", "info",
                   [](const PropertyObjectPtr& object)
                   {
                       // Ending an update that was never begun throws. That
                       // passes when the SDK's message says "update".
                       try
                       {
                           object.endUpdate();
                       }
                       catch (const std::exception& error)
                       {
                           std::string text = error.what();
                           std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                           if (text.find("update") == std::string::npos)
                               throw;
                       }
                   });
    addChangeRoute(router, "/api/components/clear-properties", "Clear property values", "Property values cleared", "warning",
                   [](const PropertyObjectPtr& object) { object.clearPropertyValues(); });
}

}  // namespace studio
