#include "topology_support.h"

#include <optional>

#include "../platform.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace studio
{

namespace
{

/// The text of a getter's string, or empty when it fails or has none.
template <typename F>
std::string textOr(F&& getter)
{
    return safe<std::string>([&] { return textOf(getter()); }, "");
}

std::string lower(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

rj::Value textOrNull(const std::string& text, Alloc& a)
{
    return text.empty() ? rj::Value() : str(text, a);
}

/// A double as the shortest text that reads back, with ".0" on a whole number.
std::string floatRepr(double value)
{
    char text[32] = "";
    for (int precision = 1; precision <= 17; precision++)
    {
        std::snprintf(text, sizeof text, "%.*g", precision, value);
        if (std::strtod(text, nullptr) == value)
            break;
    }
    std::string out = text;
    if (out.find_first_of(".e") == std::string::npos)
        out += ".0";
    return out;
}

/// A JSON value as plain text: a string is itself, and a list or an object is
/// its JSON.
std::string valueText(const rj::Value& value)
{
    if (value.IsNull())
        return "None";
    if (value.IsBool())
        return value.GetBool() ? "True" : "False";
    if (value.IsString())
        return value.GetString();
    if (value.IsInt64())
        return std::to_string(value.GetInt64());
    if (value.IsNumber())
        return floatRepr(value.GetDouble());
    return toText(value);
}

/// The short text the property grid shows for a value, or false when it
/// shows none.
bool displayText(const rj::Value& value, const rj::Value& unit, std::string& out)
{
    if (value.IsNull())
        return false;
    if (value.IsArray())
    {
        out = "[" + std::to_string(value.Size()) + " items]";
        return true;
    }
    if (value.IsObject())
    {
        const std::string kind = value.HasMember("kind") && value["kind"].IsString() ? value["kind"].GetString() : "";
        if (kind == "struct")
        {
            std::string inner;
            int count = 0;
            if (value.HasMember("fields") && value["fields"].IsObject())
                for (const auto& field : value["fields"].GetObject())
                {
                    if (count++ == 4)
                        break;
                    std::string text;
                    if (!displayText(field.value, rj::Value(), text))
                        text = "None";
                    inner += (inner.empty() ? "" : ", ") + std::string(field.name.GetString()) + ": " + text;
                }
            out = "{" + inner + "}";
        }
        else if (kind == "enumeration")
            out = value.HasMember("name") && value["name"].IsString() ? value["name"].GetString() : "";
        else if (kind == "ratio")
            out = valueText(value["numerator"]) + "/" + valueText(value["denominator"]);
        else if (kind == "complex")
            out = valueText(value["real"]) + " + " + valueText(value["imaginary"]) + "i";
        else if (kind == "object")
            return false;
        else
            out = "{" + std::to_string(value.MemberCount()) + " entries}";
        return true;
    }
    if (value.IsBool())
        out = value.GetBool() ? "Yes" : "No";
    else if (value.IsInt64())
        out = std::to_string(value.GetInt64());
    else if (value.IsNumber())
    {
        char text[64];
        std::snprintf(text, sizeof text, "%.6g", value.GetDouble());
        out = text;
    }
    else
        out = valueText(value);
    if (unit.IsObject() && unit.HasMember("symbol") && unit["symbol"].IsString() && *unit["symbol"].GetString())
        out += std::string(" ") + unit["symbol"].GetString();
    return true;
}

rj::Value selectionJson(const BaseObjectPtr& selection, Alloc& a)
{
    rj::Value options(rj::kArrayType);
    if (const auto dict = selection.asPtrOrNull<IDict>(); dict.assigned())
    {
        const DictPtr<IBaseObject, IBaseObject> entries = dict;
        for (const auto& [key, label] : entries)
        {
            rj::Value option(rj::kObjectType);
            option.AddMember("key", toJson(key, a), a);
            option.AddMember("label", str(valueText(toJson(label, a)), a), a);
            options.PushBack(option, a);
        }
    }
    else if (const auto list = selection.asPtrOrNull<IList>(); list.assigned())
    {
        int64_t index = 0;
        for (const auto& label : list)
        {
            rj::Value option(rj::kObjectType);
            option.AddMember("key", index++, a);
            option.AddMember("label", str(valueText(toJson(label, a)), a), a);
            options.PushBack(option, a);
        }
    }
    else
        return rj::Value();
    return options;
}

rj::Value callableJson(const CallableInfoPtr& info, Alloc& a)
{
    if (!info.assigned())
        return rj::Value();
    rj::Value arguments(rj::kArrayType);
    isSafe([&] {
        const auto list = info.getArguments();
        if (list.assigned())
            for (const auto& argument : list)
            {
                rj::Value entry(rj::kObjectType);
                entry.AddMember("name", str(textOr([&] { return argument.getName(); }), a), a);
                entry.AddMember("type", rj::StringRef(coreTypeName(safe<CoreType>([&] { return argument.getType(); }, ctUndefined))), a);
                arguments.PushBack(entry, a);
            }
    });
    rj::Value out(rj::kObjectType);
    out.AddMember("returnType", rj::StringRef(coreTypeName(safe<CoreType>([&] { return info.getReturnType(); }, ctUndefined))), a);
    out.AddMember("arguments", arguments, a);
    return out;
}

/// One property of a configuration object, descending into nested objects.
rj::Value propertyNode(const PropertyObjectPtr& owner, const PropertyPtr& property, const std::vector<std::string>& parent, int depth, Alloc& a)
{
    const std::string name = textOr([&] { return property.getName(); });
    const CoreType valueType = safe<CoreType>([&] { return property.getValueType(); }, ctUndefined);
    const CoreType itemType = safe<CoreType>([&] { return property.getItemType(); }, ctUndefined);
    const auto selection = safe<BaseObjectPtr>([&] { return property.getSelectionValues(); }, nullptr);
    const bool isSelection = selection.assigned() && itemType != ctUndefined;
    const bool isCallable = valueType == ctFunc || valueType == ctProc;
    std::vector<std::string> path = parent;
    path.push_back(name);

    rj::Value node(rj::kObjectType);
    node.AddMember("name", str(name, a), a);
    rj::Value pathJson(rj::kArrayType);
    for (const auto& part : path)
        pathJson.PushBack(str(part, a), a);
    node.AddMember("path", pathJson, a);
    node.AddMember("description", str(textOr([&] { return property.getDescription(); }), a), a);
    node.AddMember("valueType", rj::StringRef(coreTypeName(valueType)), a);
    node.AddMember("itemType", rj::StringRef(coreTypeName(itemType)), a);
    node.AddMember("keyType", rj::StringRef(coreTypeName(safe<CoreType>([&] { return property.getKeyType(); }, ctUndefined))), a);
    node.AddMember("readOnly", safe<bool>([&] { return static_cast<bool>(property.getReadOnly()); }, false), a);
    node.AddMember("visible", safe<bool>([&] { return static_cast<bool>(property.getVisible()); }, true), a);
    node.AddMember("isReferenced", safe<bool>([&] { return static_cast<bool>(property.getIsReferenced()); }, false), a);
    node.AddMember("unit", unitJson(safe<UnitPtr>([&] { return property.getUnit(); }, nullptr), a), a);
    node.AddMember("minValue", toJson(safe<BaseObjectPtr>([&] { return property.getMinValue(); }, nullptr), a), a);
    node.AddMember("maxValue", toJson(safe<BaseObjectPtr>([&] { return property.getMaxValue(); }, nullptr), a), a);
    node.AddMember("defaultValue", toJson(safe<BaseObjectPtr>([&] { return property.getDefaultValue(); }, nullptr), a), a);
    node.AddMember("suggestedValues", toJson(safe<BaseObjectPtr>([&] { return property.getSuggestedValues(); }, nullptr), a), a);
    node.AddMember("selectionValues", isSelection ? selectionJson(selection, a) : rj::Value(), a);
    node.AddMember("hasCoercer", safe<bool>([&] { return property.getCoercer().assigned(); }, false), a);
    node.AddMember("hasValidator", safe<bool>([&] { return property.getValidator().assigned(); }, false), a);
    node.AddMember("callable", isCallable ? callableJson(safe<CallableInfoPtr>([&] { return property.getCallableInfo(); }, nullptr), a) : rj::Value(), a);
    node.AddMember("structTypeName", rj::Value(), a);
    node.AddMember("value", rj::Value(), a);
    node.AddMember("displayValue", rj::Value(), a);
    node.AddMember("selectionKey", rj::Value(), a);
    node.AddMember("children", rj::Value(), a);
    node.AddMember("error", rj::Value(), a);

    // A callable's value is the callable itself; there is nothing to show.
    if (isCallable)
        return node;

    BaseObjectPtr raw;
    try
    {
        raw = owner.getPropertyValue(name);
    }
    catch (const std::exception& error)
    {
        node["error"] = str(error.what(), a);
        return node;
    }

    std::string display;
    if (isSelection)
    {
        node["selectionKey"] = toJson(raw, a);
        node["value"] = toJson(safe<BaseObjectPtr>([&] { return owner.getPropertySelectionValue(name); }, nullptr), a);
        if (displayText(node["value"], node["unit"], display))
            node["displayValue"] = str(display, a);
        return node;
    }

    if (valueType == ctObject)
    {
        rj::Value value(rj::kObjectType);
        value.AddMember("kind", "object", a);
        node["value"] = value;
        rj::Value children(rj::kArrayType);
        if (depth < 8)
            if (const auto nested = raw.asPtrOrNull<IPropertyObject>(); nested.assigned())
                isSafe([&] {
                    for (const auto& child : nested.getAllProperties())
                        children.PushBack(propertyNode(nested, child, path, depth + 1, a), a);
                });
        node["children"] = children;
        return node;
    }

    node["value"] = toJson(raw, a);
    if (valueType == ctStruct && node["value"].IsObject() && node["value"].HasMember("typeName"))
        node["structTypeName"] = rj::Value(node["value"]["typeName"], a);
    if (displayText(node["value"], node["unit"], display))
        node["displayValue"] = str(display, a);
    return node;
}

rj::Value typeJson(const ComponentTypePtr& type, const std::string& key, const std::string& kind, Alloc& a)
{
    const auto orKey = [&](const std::string& text) { return text.empty() ? key : text; };
    rj::Value entry(rj::kObjectType);
    entry.AddMember("id", str(orKey(textOr([&] { return type.getId(); })), a), a);
    entry.AddMember("key", str(key, a), a);
    entry.AddMember("name", str(orKey(textOr([&] { return type.getName(); })), a), a);
    entry.AddMember("description", str(textOr([&] { return type.getDescription(); }), a), a);
    entry.AddMember("kind", str(kind, a), a);
    rj::Value prefix;
    isSafe([&] {
        if (const auto device = type.asPtrOrNull<IDeviceType>(); kind == "device" && device.assigned())
            prefix = str(textOf(device.getConnectionStringPrefix()), a);
        else if (const auto streaming = type.asPtrOrNull<IStreamingType>(); kind == "streaming" && streaming.assigned())
            prefix = str(textOf(streaming.getConnectionStringPrefix()), a);
    });
    entry.AddMember("connectionStringPrefix", prefix, a);
    return entry;
}

bool numericSampleType(const DataDescriptorPtr& descriptor)
{
    const auto name = sampleTypeName(descriptor.getSampleType());
    return name.rfind("Float", 0) == 0 || name.rfind("Int", 0) == 0 || name.rfind("UInt", 0) == 0;
}

template <typename List>
size_t countOf(const List& list)
{
    return list.assigned() ? list.getCount() : 0;
}

bool isChartable(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain)
{
    if (!descriptor.assigned() || !domain.assigned())
        return false;
    return safe<bool>([&] { return numericSampleType(descriptor); }, false) &&
           safe<size_t>([&] { return countOf(descriptor.getDimensions()); }, 0) == 0 &&
           safe<size_t>([&] { return countOf(descriptor.getStructFields()); }, 0) == 0;
}

/// "scalar" for one number per sample, "array" for a one-dimensional numeric
/// value per sample, such as a spectrum, else "other".
std::string shapeOf(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain)
{
    if (!descriptor.assigned() || !domain.assigned() || !safe<bool>([&] { return numericSampleType(descriptor); }, false))
        return "other";
    if (safe<size_t>([&] { return countOf(descriptor.getStructFields()); }, 0) != 0)
        return "other";
    const size_t dimensions = safe<size_t>([&] { return countOf(descriptor.getDimensions()); }, 0);
    return dimensions == 0 ? "scalar" : dimensions == 1 ? "array" : "other";
}

/// The picture format of an image signal, by its unit's symbol, or empty.
std::string imageFormat(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return "";
    return safe<std::string>(
        [&]() -> std::string {
            if (descriptor.getSampleType() != SampleType::Binary)
                return "";
            const auto unit = descriptor.getUnit();
            const std::string symbol = unit.assigned() ? lower(textOf(unit.getSymbol())) : "";
            return symbol == "jpeg" || symbol == "jpg" || symbol == "png" || symbol == "bmp" || symbol == "plot" ? symbol : "";
        },
        "");
}

rj::Value imageSize(const DataDescriptorPtr& descriptor, Alloc& a)
{
    rj::Value out;
    if (imageFormat(descriptor).empty())
        return out;
    isSafe([&] {
        const auto metadata = descriptor.getMetadata();
        const int64_t width = std::stoll(textOf(metadata.get("width")));
        const int64_t height = std::stoll(textOf(metadata.get("height")));
        out.SetObject();
        out.AddMember("width", width, a);
        out.AddMember("height", height, a);
    });
    return out;
}

/// Whether a domain descriptor carries wall-clock time rather than counts.
bool isTimeDomain(const DataDescriptorPtr& domain)
{
    if (!domain.assigned())
        return false;
    return safe<bool>(
        [&] {
            if (!domain.getTickResolution().assigned())
                return false;
            const auto unit = domain.getUnit();
            if (!unit.assigned() || lower(textOf(unit.getQuantity())) != "time" || lower(textOf(unit.getSymbol())) != "s")
                return false;
            return !textOf(domain.getOrigin()).empty();
        },
        false);
}

}  // namespace

// ------------------------------------------------------------------ lookups

ComponentPtr componentAt(Engine& e, const std::string& id)
{
    return lookupComponent(e.root, id);
}

DevicePtr deviceAt(Engine& e, const std::string& id)
{
    if (id.empty())
        return e.root;
    const auto device = componentAt(e, id).asPtrOrNull<IDevice>();
    if (!device.assigned())
        throw HttpError{404, "not_found", "not a device: " + id, "", "{\"componentId\":" + quote(id) + "}"};
    return device;
}

DevicePtr nearestDevice(ComponentPtr component)
{
    while (component.assigned())
    {
        if (const auto device = component.asPtrOrNull<IDevice>(); device.assigned())
            return device;
        component = safe<ComponentPtr>([&] { return component.getParent(); }, nullptr);
    }
    return nullptr;
}

// ------------------------------------------------------------------ requests

const rj::Value& bodyOf(const Request& r, std::initializer_list<const char*> allowed)
{
    if (!r.body.IsObject())
        fail(422, "invalid_request", "The request needs a JSON object");
    for (const auto& entry : r.body.GetObject())
        if (std::none_of(allowed.begin(), allowed.end(), [&](const char* name) { return entry.name == name; }))
            fail(422, "invalid_request", std::string("The request does not take ") + entry.name.GetString());
    return r.body;
}

std::string textMember(const rj::Value& body, const char* name, bool required)
{
    if (!body.HasMember(name) || body[name].IsNull())
    {
        if (required)
            fail(422, "invalid_request", std::string("The request needs ") + name);
        return "";
    }
    if (!body[name].IsString())
        fail(422, "invalid_request", std::string(name) + " must be a string");
    const std::string text = body[name].GetString();
    if (required && text.empty())
        fail(422, "invalid_request", std::string(name) + " must not be empty");
    return text;
}

bool flagMember(const rj::Value& body, const char* name, bool fallback)
{
    if (!body.HasMember(name))
        return fallback;
    const auto& value = body[name];
    if (value.IsBool())
        return value.GetBool();
    if (value.IsInt64() && (value.GetInt64() == 0 || value.GetInt64() == 1))
        return value.GetInt64() == 1;
    fail(422, "invalid_request", std::string(name) + " must be true or false");
}

bool flagMember(const rj::Value& body, const char* name)
{
    if (!body.HasMember(name))
        fail(422, "invalid_request", std::string("The request needs ") + name);
    return flagMember(body, name, false);
}

std::string trimmed(const std::string& text)
{
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos)
        return "";
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

std::string requiredQuery(const Request& r, const char* name)
{
    if (!hasQuery(r, name))
        fail(422, "invalid_request", std::string("The request needs the query parameter ") + name);
    return queryString(r.query, name);
}

bool queryFlag(const Request& r, const char* name)
{
    const std::string value = lower(queryString(r.query, name));
    return value == "true" || value == "1" || value == "yes" || value == "on";
}

bool hasQuery(const Request& r, const char* name)
{
    return r.query.IsObject() && r.query.HasMember(name);
}

void notify(Engine& e, const std::string& level, const std::string& message, const std::string& detail,
            const std::string& componentId)
{
    const auto optional = [](const std::string& text) { return text.empty() ? std::nullopt : std::optional<std::string>(text); };
    e.notify(message, level, "viewer", optional(detail), optional(componentId));
}

// ------------------------------------------------------------------ values

rj::Value toJson(const BaseObjectPtr& value, Alloc& a, int depth)
{
    rj::Value out;
    if (!value.assigned())
        return out;
    const CoreType type = coreTypeOf(value);
    if (depth >= 12 && (type == ctList || type == ctDict || type == ctStruct))
    {
        out.SetObject();
        out.AddMember("kind", "truncated", a);
        out.AddMember("text", str(safe<std::string>([&] { return textOf(value); }, ""), a), a);
        return out;
    }
    switch (type)
    {
        case ctList:
        {
            out.SetArray();
            for (const auto& item : value.asPtr<IList>())
                out.PushBack(toJson(item, a, depth + 1), a);
            return out;
        }
        case ctDict:
        {
            out.SetObject();
            const DictPtr<IBaseObject, IBaseObject> dict = value.asPtr<IDict>();
            for (const auto& [key, item] : dict)
            {
                const auto name = toJson(key, a, depth + 1);
                out.AddMember(str(valueText(name), a), toJson(item, a, depth + 1), a);
            }
            return out;
        }
        case ctObject:
            if (const auto object = value.asPtrOrNull<IPropertyObject>(); object.assigned())
            {
                out.SetObject();
                out.AddMember("kind", "object", a);
                out.AddMember("className", str(textOr([&] { return object.getClassName(); }), a), a);
                return out;
            }
            return str(safe<std::string>([&] { return textOf(value); }, ""), a);
        case ctFunc:
        case ctProc:
            out.SetObject();
            out.AddMember("kind", "callable", a);
            return out;
        default:
            return valueToJson(value, a, depth);
    }
}


rj::Value statusSummary(const ComponentPtr& component, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    rj::Value statuses(rj::kObjectType);
    std::string level = "none";
    std::string message;
    const auto container = safe<ComponentStatusContainerPtr>([&] { return component.getStatusContainer(); }, nullptr);
    if (container.assigned())
        isSafe([&] {
            for (const auto& status : container.getStatuses())
            {
                const auto& name = status.first;
                const auto& value = status.second;
                const std::string key = textOf(name);
                const std::string text = textOr([&] { return container.getStatusMessage(name); });
                rj::Value entry(rj::kObjectType);
                entry.AddMember("value", toJson(value, a), a);
                entry.AddMember("message", str(text, a), a);
                statuses.AddMember(str(key, a), entry, a);
                if (key == "ComponentStatus")
                {
                    const std::string state = textOr([&] { return value.getValue(); });
                    level = state == "Ok" ? "ok" : state == "Warning" ? "warning" : state == "Error" ? "error" : "none";
                    message = text;
                }
            }
        });
    out.AddMember("level", str(level, a), a);
    out.AddMember("message", textOrNull(message, a), a);
    out.AddMember("statuses", statuses, a);
    return out;
}

bool isConnected(const DevicePtr& device)
{
    return safe<bool>(
        [&] {
            const auto container = device.getStatusContainer();
            if (!container.assigned())
                return true;
            const auto status = safe<EnumerationPtr>([&] { return container.getStatus("ConnectionStatus"); }, nullptr);
            return !status.assigned() || safe<std::string>([&] { return textOf(status.getValue()); }, "Connected") == "Connected";
        },
        true);
}

rj::Value operationModeJson(Int mode)
{
    static const char* const names[] = {"Unknown", "Idle", "Operation", "SafeOperation"};
    return mode >= 0 && mode < 4 ? rj::Value(rj::StringRef(names[mode])) : rj::Value();
}

// ------------------------------------------------------------------ types

rj::Value typesJson(const std::function<BaseObjectPtr()>& getter, const char* kind, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    DictPtr<IString, IBaseObject> types;
    // Modules need not implement every family of types.
    if (!isSafe([&] { types = getter().asPtr<IDict>(); }) || !types.assigned())
        return out;
    for (const auto& [key, type] : types)
        out.PushBack(typeJson(type.asPtr<IComponentType>(), textOf(key), kind, a), a);
    return out;
}

rj::Value deviceTypesJson(const ComponentPtr& host, Alloc& a)
{
    return typesJson([&]() -> BaseObjectPtr { return host.asPtr<IDevice>().getAvailableDeviceTypes(); }, "device", a);
}

rj::Value functionBlockTypesJson(const ComponentPtr& host, Alloc& a)
{
    return typesJson(
        [&]() -> BaseObjectPtr {
            if (const auto device = host.asPtrOrNull<IDevice>(); device.assigned())
                return device.getAvailableFunctionBlockTypes();
            return host.asPtr<IFunctionBlock>().getAvailableFunctionBlockTypes();
        },
        "functionBlock", a);
}

rj::Value serverTypesJson(Engine& e, Alloc& a)
{
    return typesJson([&]() -> BaseObjectPtr { return e.instance.getAvailableServerTypes(); }, "server", a);
}

rj::Value streamingTypesJson(Engine& e, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    std::vector<std::string> seen;
    const auto modules = safe<ListPtr<IModule>>([&] { return e.instance.getModuleManager().getModules(); }, nullptr);
    if (!modules.assigned())
        return out;
    for (const auto& module : modules)
    {
        // Some modules answer that they do not implement streaming types.
        DictPtr<IString, IStreamingType> types;
        if (!isSafe([&] { types = module.getAvailableStreamingTypes(); }) || !types.assigned())
            continue;
        for (const auto& [key, type] : types)
        {
            const std::string id = textOf(key);
            if (std::find(seen.begin(), seen.end(), id) != seen.end())
                continue;
            seen.push_back(id);
            out.PushBack(typeJson(type.template asPtr<IComponentType>(), id, "streaming", a), a);
        }
    }
    return out;
}

rj::Value defaultConfigJson(const ComponentTypePtr& type, Alloc& a)
{
    const auto config = safe<PropertyObjectPtr>([&] { return type.createDefaultConfig(); }, nullptr);
    if (!config.assigned() || safe<size_t>([&] { return config.getAllProperties().getCount(); }, 0) == 0)
        return rj::Value();
    return configJson(config, a);
}

// ------------------------------------------------------------------ configuration

rj::Value configJson(const PropertyObjectPtr& config, Alloc& a)
{
    rj::Value properties(rj::kArrayType);
    isSafe([&] {
        for (const auto& property : config.getAllProperties())
            properties.PushBack(propertyNode(config, property, {}, 0, a), a);
    });
    rj::Value out(rj::kObjectType);
    out.AddMember("componentId", "", a);
    out.AddMember("className", textOrNull(textOr([&] { return config.getClassName(); }), a), a);
    out.AddMember("updating", false, a);
    out.AddMember("properties", properties, a);
    return out;
}

std::vector<std::string> applyConfig(const PropertyObjectPtr& config, const rj::Value& values, const TypeManagerPtr& types)
{
    std::vector<std::string> ignored;
    for (const auto& entry : values.GetObject())
    {
        const std::string dotted = entry.name.GetString();
        std::vector<std::string> segments;
        size_t start = 0;
        while (start <= dotted.size())
        {
            const size_t end = std::min(dotted.find('.', start), dotted.size());
            if (end > start)
                segments.push_back(dotted.substr(start, end - start));
            start = end + 1;
        }
        if (segments.empty())
            continue;
        PropertyObjectPtr owner = config;
        for (size_t i = 0; i + 1 < segments.size() && owner.assigned(); i++)
            owner = safe<PropertyObjectPtr>(
                [&]() -> PropertyObjectPtr {
                    return owner.hasProperty(segments[i]) ? owner.getPropertyValue(segments[i]).asPtrOrNull<IPropertyObject>() : nullptr;
                },
                nullptr);
        const std::string& leaf = segments.back();
        if (!owner.assigned() || !safe<bool>([&] { return static_cast<bool>(owner.hasProperty(leaf)); }, false))
        {
            ignored.push_back(dotted);
            continue;
        }
        try
        {
            const auto property = owner.getProperty(leaf);
            if (safe<bool>([&] { return static_cast<bool>(property.getReadOnly()); }, false))
            {
                ignored.push_back(dotted);
                continue;
            }
            owner.setPropertyValue(leaf, fromJson(entry.value, coreTypeName(property.getValueType()), types));
        }
        // One bad field must not abort the rest.
        catch (const std::exception& error)
        {
            platform::log(platform::Level::Warn, kTag, "Ignoring config value %s=%s: %s", dotted.c_str(), toText(entry.value).c_str(), error.what());
            ignored.push_back(dotted);
        }
        catch (const HttpError& error)
        {
            platform::log(platform::Level::Warn, kTag, "Ignoring config value %s=%s: %s", dotted.c_str(), toText(entry.value).c_str(), error.message.c_str());
            ignored.push_back(dotted);
        }
    }
    return ignored;
}

const rj::Value* configValues(const rj::Value& body)
{
    if (!body.HasMember("config") || body["config"].IsNull())
        return nullptr;
    if (!body["config"].IsObject())
        fail(422, "invalid_request", "config must be an object");
    return body["config"].MemberCount() ? &body["config"] : nullptr;
}

// ------------------------------------------------------------------ devices

rj::Value deviceInfoJson(const DeviceInfoPtr& info, bool full, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("name", str(textOr([&] { return info.getName(); }), a), a);
    out.AddMember("connectionString", str(textOr([&] { return info.getConnectionString(); }), a), a);
    out.AddMember("location", str(textOr([&] { return info.getLocation(); }), a), a);
    out.AddMember("manufacturer", str(textOr([&] { return info.getManufacturer(); }), a), a);
    out.AddMember("model", str(textOr([&] { return info.getModel(); }), a), a);
    out.AddMember("serialNumber", str(textOr([&] { return info.getSerialNumber(); }), a), a);
    out.AddMember("deviceClass", str(textOr([&] { return info.getDeviceClass(); }), a), a);
    const auto type = safe<DeviceTypePtr>([&] { return info.getDeviceType(); }, nullptr);
    out.AddMember("deviceType", type.assigned() ? str(textOr([&] { return type.getId(); }), a) : rj::Value(), a);
    out.AddMember("sdkVersion", str(textOr([&] { return info.getSdkVersion(); }), a), a);
    out.AddMember("macAddress", str(textOr([&] { return info.getMacAddress(); }), a), a);
    out.AddMember("serverCapabilities", capabilitiesJson(capabilitiesOf(info), a), a);
    if (full)
    {
        rj::Value properties(rj::kObjectType);
        isSafe([&] {
            for (const auto& property : info.getAllProperties())
            {
                const std::string name = textOr([&] { return property.getName(); });
                if (!name.empty())
                    properties.AddMember(str(name, a), toJson(safe<BaseObjectPtr>([&] { return info.getPropertyValue(name); }, nullptr), a), a);
            }
        });
        out.AddMember("properties", properties, a);
    }
    return out;
}

std::vector<Capability> capabilitiesOf(const DeviceInfoPtr& info)
{
    std::vector<Capability> out;
    const auto list = safe<ListPtr<IServerCapability>>([&] { return info.getServerCapabilities(); }, nullptr);
    if (!list.assigned())
        return out;
    for (const auto& capability : list)
    {
        Capability entry;
        entry.protocolId = textOr([&] { return capability.getProtocolId(); });
        entry.protocolName = textOr([&] { return capability.getProtocolName(); });
        entry.connectionString = textOr([&] { return capability.getConnectionString(); });
        entry.connectionType = textOr([&] { return capability.getPropertyValue("ConnectionType"); });
        entry.protocolType = textOr([&] { return capability.getPropertyValue("ProtocolType"); });
        isSafe([&] {
            if (!capability.hasProperty("AddressInfo"))
                return;
            const PropertyObjectPtr addresses = capability.getPropertyValue("AddressInfo");
            for (const auto& property : addresses.getVisibleProperties())
                isSafe([&] {
                    const PropertyObjectPtr address = property.getValue();
                    const std::string type = textOr([&] { return address.getPropertyValue("Type"); });
                    const std::string connection = textOr([&] { return address.getPropertyValue("ConnectionString"); });
                    if (type.empty() || connection.empty())
                        return;
                    const auto known = std::find_if(entry.addresses.begin(), entry.addresses.end(), [&](const auto& item) { return item.first == type; });
                    if (known != entry.addresses.end())
                        known->second = connection;
                    else
                        entry.addresses.emplace_back(type, connection);
                });
        });
        out.push_back(std::move(entry));
    }
    return out;
}

rj::Value capabilitiesJson(const std::vector<Capability>& capabilities, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    for (const auto& capability : capabilities)
    {
        rj::Value entry(rj::kObjectType);
        entry.AddMember("protocolId", str(capability.protocolId, a), a);
        entry.AddMember("protocolName", str(capability.protocolName, a), a);
        entry.AddMember("connectionString", str(capability.connectionString, a), a);
        entry.AddMember("connectionType", str(capability.connectionType, a), a);
        entry.AddMember("protocolType", str(capability.protocolType, a), a);
        rj::Value addresses(rj::kObjectType);
        for (const auto& [type, connection] : capability.addresses)
            addresses.AddMember(str(type, a), str(connection, a), a);
        entry.AddMember("addresses", addresses, a);
        out.PushBack(entry, a);
    }
    return out;
}

DeviceInfoPtr findAvailableDevice(const DevicePtr& parent, const std::string& connection)
{
    const auto available = safe<ListPtr<IDeviceInfo>>([&] { return parent.getAvailableDevices(); }, nullptr);
    if (!available.assigned())
        return nullptr;
    for (const auto& info : available)
    {
        if (textOr([&] { return info.getConnectionString(); }) == connection)
            return info;
        for (const auto& capability : capabilitiesOf(info))
        {
            if (capability.connectionString == connection)
                return info;
            for (const auto& address : capability.addresses)
                if (address.second == connection)
                    return info;
        }
    }
    return nullptr;
}

// ------------------------------------------------------------------ signals and ports

rj::Value signalInfo(const SignalPtr& signal, Alloc& a)
{
    const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
    const auto descriptor = safe<DataDescriptorPtr>([&] { return signal.getDescriptor(); }, nullptr);
    const auto domainDescriptor = domain.assigned() ? safe<DataDescriptorPtr>([&] { return domain.getDescriptor(); }, nullptr) : nullptr;
    const auto parent = safe<ComponentPtr>([&] { return signal.getParent(); }, nullptr);
    const auto device = nearestDevice(signal);

    rj::Value out(rj::kObjectType);
    out.AddMember("id", str(textOr([&] { return signal.getGlobalId(); }), a), a);
    out.AddMember("localId", str(textOr([&] { return signal.getLocalId(); }), a), a);
    out.AddMember("name", str(textOr([&] { return signal.getName(); }), a), a);
    out.AddMember("description", str(textOr([&] { return signal.getDescription(); }), a), a);
    out.AddMember("parentId", parent.assigned() ? str(textOf(parent.getGlobalId()), a) : rj::Value(), a);
    out.AddMember("deviceId", device.assigned() ? str(textOf(device.getGlobalId()), a) : rj::Value(), a);
    out.AddMember("active", safe<bool>([&] { return static_cast<bool>(signal.getActive()); }, true), a);
    out.AddMember("public", safe<bool>([&] { return static_cast<bool>(signal.getPublic()); }, true), a);
    out.AddMember("visible", safe<bool>([&] { return static_cast<bool>(signal.getVisible()); }, true), a);
    out.AddMember("streamed", safe<bool>([&] { return static_cast<bool>(signal.getStreamed()); }, false), a);
    out.AddMember("domainSignalId", domain.assigned() ? str(textOf(domain.getGlobalId()), a) : rj::Value(), a);
    out.AddMember("domainSignalName", domain.assigned() ? str(textOf(domain.getName()), a) : rj::Value(), a);
    out.AddMember("unit", descriptor.assigned() ? unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a) : rj::Value(), a);
    rj::Value sampleType;
    if (descriptor.assigned())
        isSafe([&] { sampleType = str(sampleTypeName(descriptor.getSampleType()), a); });
    out.AddMember("sampleType", sampleType, a);
    out.AddMember("sampleRate", sampleRateJson(domainDescriptor), a);
    out.AddMember("chartable", isChartable(descriptor, domainDescriptor), a);
    out.AddMember("shape", str(shapeOf(descriptor, domainDescriptor), a), a);
    out.AddMember("image", textOrNull(imageFormat(descriptor), a), a);
    out.AddMember("imageSize", imageSize(descriptor, a), a);
    out.AddMember("timeDomain", isTimeDomain(domainDescriptor), a);
    rj::Value related(rj::kArrayType);
    isSafe([&] {
        for (const auto& item : signal.getRelatedSignals())
            related.PushBack(str(textOf(item.getGlobalId()), a), a);
    });
    out.AddMember("relatedSignalIds", related, a);
    return out;
}

rj::Value sampleRateJson(const DataDescriptorPtr& domain)
{
    rj::Value out;
    if (!domain.assigned())
        return out;
    isSafe([&] {
        const auto resolution = domain.getTickResolution();
        const auto rule = domain.getRule();
        if (!resolution.assigned() || !rule.assigned())
            return;
        const auto numerator = static_cast<double>(resolution.getNumerator());
        const auto denominator = static_cast<double>(resolution.getDenominator());
        const auto parameters = rule.getParameters();
        if (numerator == 0 || denominator == 0 || !parameters.assigned() || !parameters.hasKey("delta"))
            return;
        const double delta = static_cast<double>(parameters.get("delta"));
        const double period = delta * numerator / denominator;
        if (delta != 0 && period > 0)
            out.SetDouble(1.0 / period);
    });
    return out;
}


}  // namespace studio
