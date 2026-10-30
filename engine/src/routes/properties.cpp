// /api/properties: a component's properties, and changing them.
//
// A property is addressed by its component and a path, the property names to
// walk, so ["Protected", "Owner"] is the Owner property of the Protected
// object. Every answer about one property carries what the UI needs to pick
// an editor: selection options, limits, unit, struct fields, call arguments.

#include "properties.h"

#include "routes.h"

namespace studio
{

namespace
{

/// The metadata columns the UI can show next to a value.
const std::pair<const char*, const char*> kMetadataFields[] = {
    {"description", "Description"}, {"valueType", "Value type"}, {"itemType", "Item type"},
    {"keyType", "Key type"},         {"unit", "Unit"},             {"minValue", "Min"},
    {"maxValue", "Max"},             {"defaultValue", "Default"},  {"readOnly", "Read only"},
    {"visible", "Visible"},          {"isReferenced", "Referenced"}, {"hasCoercer", "Coercer"},
    {"hasValidator", "Validator"},   {"structTypeName", "Struct type"},
};

std::string joined(const std::vector<std::string>& path)
{
    std::string out;
    for (const auto& part : path)
        out += (out.empty() ? "" : ".") + part;
    return out;
}

rj::Value strings(const std::vector<std::string>& items, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    for (const auto& item : items)
        out.PushBack(str(item, a), a);
    return out;
}

/// A selection property's options as `[{key, label}]`; a list's keys are
/// its indices.
rj::Value selectionJson(const BaseObjectPtr& selection, Alloc& a)
{
    rj::Value options;
    const auto option = [&](rj::Value key, const BaseObjectPtr& label)
    {
        rj::Value entry(rj::kObjectType);
        entry.AddMember("key", key, a);
        entry.AddMember("label", str(plainText(valueToJson(label, a)), a), a);
        options.PushBack(entry, a);
    };
    if (const auto dict = selection.asPtrOrNull<IDict>(); dict.assigned())
    {
        options.SetArray();
        isSafe([&] {
            for (const auto& [key, label] : DictPtr<IBaseObject, IBaseObject>(dict))
                option(valueToJson(key, a), label);
        });
    }
    else if (const auto list = selection.asPtrOrNull<IList>(); list.assigned())
    {
        options.SetArray();
        int64_t index = 0;
        isSafe([&] {
            for (const auto& label : ListPtr<IBaseObject>(list))
                option(rj::Value(index++), label);
        });
    }
    return options;
}

rj::Value callableJson(const CallableInfoPtr& info, Alloc& a)
{
    rj::Value out;
    if (!info.assigned())
        return out;
    out.SetObject();
    out.AddMember("returnType", rj::StringRef(coreTypeName(safe<CoreType>([&] { return info.getReturnType(); }, ctUndefined))), a);
    rj::Value arguments(rj::kArrayType);
    const auto list = safe<ListPtr<IArgumentInfo>>([&] { return info.getArguments(); }, nullptr);
    if (list.assigned())
        for (const auto& argument : list)
        {
            rj::Value arg(rj::kObjectType);
            arg.AddMember("name", str(safe<std::string>([&] { return textOf(argument.getName()); }, ""), a), a);
            arg.AddMember("type", rj::StringRef(coreTypeName(safe<CoreType>([&] { return argument.getType(); }, ctUndefined))), a);
            arguments.PushBack(arg, a);
        }
    out.AddMember("arguments", arguments, a);
    return out;
}

/// A short rendering of a value for the grid, or null.
rj::Value displayText(const rj::Value& value, const rj::Value& unit, Alloc& a)
{
    if (value.IsNull())
        return rj::Value();
    std::string text;
    if (value.IsBool())
        text = value.GetBool() ? "Yes" : "No";
    else if (value.IsInt64() || value.IsUint64())
        text = plainText(value);
    else if (value.IsNumber())
        text = formatNumber(value.GetDouble());
    else if (value.IsString())
        text = value.GetString();
    else if (value.IsArray())
        return str("[" + std::to_string(value.Size()) + " items]", a);
    else
    {
        const std::string kind = value.HasMember("kind") && value["kind"].IsString() ? value["kind"].GetString() : "";
        if (kind == "struct")
        {
            std::string inner;
            int shown = 0;
            if (value.HasMember("fields") && value["fields"].IsObject())
                for (const auto& field : value["fields"].GetObject())
                {
                    if (shown++ == 4)
                        break;
                    const auto part = displayText(field.value, rj::Value(), a);
                    inner += (inner.empty() ? "" : ", ") + std::string(field.name.GetString()) + ": " +
                             (part.IsNull() ? "None" : part.GetString());
                }
            return str("{" + inner + "}", a);
        }
        if (kind == "enumeration")
            return str(value.HasMember("name") && truthy(value["name"]) ? plainText(value["name"]) : "", a);
        if (kind == "ratio")
            return str(plainText(value["numerator"]) + "/" + plainText(value["denominator"]), a);
        if (kind == "complex")
            return str(plainText(value["real"]) + " + " + plainText(value["imaginary"]) + "i", a);
        if (kind == "object")
            return rj::Value();
        return str("{" + std::to_string(value.MemberCount()) + " entries}", a);
    }
    const std::string symbol = unit.IsObject() && unit["symbol"].IsString() ? unit["symbol"].GetString() : "";
    return str(symbol.empty() ? text : text + " " + symbol, a);
}

ListPtr<IProperty> propertiesOf(const PropertyObjectPtr& object, bool includeHidden)
{
    return safe<ListPtr<IProperty>>([&] { return includeHidden ? object.getAllProperties() : object.getVisibleProperties(); },
                                    List<IProperty>());
}

/// One property, descending into nested objects.
rj::Value propertyNode(const PropertyObjectPtr& owner, const PropertyPtr& property, const std::vector<std::string>& path,
                       bool includeHidden, Alloc& a, int depth = 0)
{
    const std::string name = safe<std::string>([&] { return textOf(property.getName()); }, "");
    const auto typeOf = [&](auto getter) { return std::string(coreTypeName(safe<CoreType>(getter, ctUndefined))); };
    const std::string valueType = typeOf([&] { return property.getValueType(); });
    const std::string itemType = typeOf([&] { return property.getItemType(); });
    const std::string keyType = typeOf([&] { return property.getKeyType(); });
    const auto selection = safe<BaseObjectPtr>([&] { return property.getSelectionValues(); }, nullptr);
    const bool isSelection = selection.assigned() && itemType != "undefined";
    const bool isCallable = valueType == "func" || valueType == "proc";
    const auto flag = [&](auto getter, bool fallback) { return safe<bool>([&] { return static_cast<bool>(getter()); }, fallback); };
    const auto object = [&](auto getter) { return valueToJson(safe<BaseObjectPtr>([&] { return BaseObjectPtr(getter()); }, nullptr), a); };

    rj::Value node(rj::kObjectType);
    node.AddMember("name", str(name, a), a);
    node.AddMember("path", strings(path, a), a);
    node.AddMember("description", str(safe<std::string>([&] { return textOf(property.getDescription()); }, ""), a), a);
    node.AddMember("valueType", str(valueType, a), a);
    node.AddMember("itemType", str(itemType, a), a);
    node.AddMember("keyType", str(keyType, a), a);
    node.AddMember("readOnly", flag([&] { return property.getReadOnly(); }, false), a);
    node.AddMember("visible", flag([&] { return property.getVisible(); }, true), a);
    node.AddMember("isReferenced", flag([&] { return property.getIsReferenced(); }, false), a);
    node.AddMember("unit", unitJson(safe<UnitPtr>([&] { return property.getUnit(); }, nullptr), a), a);
    node.AddMember("minValue", object([&] { return property.getMinValue(); }), a);
    node.AddMember("maxValue", object([&] { return property.getMaxValue(); }), a);
    node.AddMember("defaultValue", object([&] { return property.getDefaultValue(); }), a);
    node.AddMember("suggestedValues", object([&] { return property.getSuggestedValues(); }), a);
    node.AddMember("selectionValues", isSelection ? selectionJson(selection, a) : rj::Value(), a);
    node.AddMember("hasCoercer", safe<bool>([&] { return property.getCoercer().assigned(); }, false), a);
    node.AddMember("hasValidator", safe<bool>([&] { return property.getValidator().assigned(); }, false), a);
    node.AddMember("callable", isCallable ? callableJson(safe<CallableInfoPtr>([&] { return property.getCallableInfo(); }, nullptr), a)
                                          : rj::Value(), a);
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
        // A device may refuse one read; the rest of the tree still shows.
        node["error"] = str(error.what(), a);
        return node;
    }

    if (isSelection)
    {
        node["selectionKey"] = valueToJson(raw, a);
        node["value"] = valueToJson(safe<BaseObjectPtr>([&] { return owner.getPropertySelectionValue(name); }, nullptr), a);
        node["displayValue"] = displayText(node["value"], node["unit"], a);
        return node;
    }

    if (valueType == "object")
    {
        rj::Value value(rj::kObjectType);
        value.AddMember("kind", "object", a);
        node["value"] = value;
        rj::Value children(rj::kArrayType);
        if (const auto nested = raw.assigned() ? raw.asPtrOrNull<IPropertyObject>() : nullptr; depth < 8 && nested.assigned())
            for (const auto& child : propertiesOf(nested, includeHidden))
            {
                auto childPath = path;
                childPath.push_back(textOf(child.getName()));
                children.PushBack(propertyNode(nested, child, childPath, includeHidden, a, depth + 1), a);
            }
        node["children"] = children;
        return node;
    }

    node["value"] = valueToJson(raw, a);
    if (valueType == "struct" && node["value"].IsObject())
        node["structTypeName"] = rj::Value(node["value"]["typeName"], a);
    node["displayValue"] = displayText(node["value"], node["unit"], a);
    return node;
}

/// The object that owns the last property of a path, and that name.
PropertyObjectPtr ownerOf(const ComponentPtr& component, const std::vector<std::string>& path, std::string& leaf)
{
    const auto missing = [&]
    {
        rj::Document extra(rj::kObjectType);
        extra.AddMember("path", strings(path, extra.GetAllocator()), extra.GetAllocator());
        throw HttpError{404, "not_found", "property not found: " + joined(path), "", toText(extra)};
    };
    PropertyObjectPtr owner = component;
    for (size_t i = 0; i + 1 < path.size(); i++)
    {
        if (!safe<bool>([&] { return static_cast<bool>(owner.hasProperty(path[i])); }, false))
            missing();
        const auto value = owner.getPropertyValue(path[i]);
        const auto nested = value.assigned() ? value.asPtrOrNull<IPropertyObject>() : nullptr;
        if (!nested.assigned())
            fail(400, "bad_request", reprText(path[i]) + " is not a nested property object");
        owner = nested;
    }
    leaf = path.back();
    if (!safe<bool>([&] { return static_cast<bool>(owner.hasProperty(leaf)); }, false))
        missing();
    return owner;
}

rj::Value readProperty(const ComponentPtr& component, const std::vector<std::string>& path, Alloc& a)
{
    std::string leaf;
    const auto owner = ownerOf(component, path, leaf);
    return propertyNode(owner, owner.getProperty(leaf), path, true, a);
}

bool readOnly(const PropertyPtr& property)
{
    return safe<bool>([&] { return static_cast<bool>(property.getReadOnly()); }, false);
}

std::string valueTypeOf(const PropertyPtr& property)
{
    return coreTypeName(safe<CoreType>([&] { return property.getValueType(); }, ctUndefined));
}

// ------------------------------------------------------------------ routes

rj::Value getProperties(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    const bool hidden = check.queryFlag("includeHidden");
    check.done();
    return sdkCall("List properties", [&] { return listProperties(lookupComponent(e.root, id), hidden, r.a); });
}

rj::Value postRead(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path"});
    const auto path = check.path();
    check.done();
    return sdkCall("Read property", [&] { return readProperty(lookupComponent(e.root, id), path, r.a); });
}

rj::Value postMetadata(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path"});
    const auto path = check.path();
    check.done();
    return sdkCall("Read property metadata", [&] {
        auto node = readProperty(lookupComponent(e.root, id), path, r.a);
        rj::Value metadata(rj::kObjectType);
        for (const auto& [key, label] : kMetadataFields)
            metadata.AddMember(rj::StringRef(key), rj::Value(node[key], r.a), r.a);
        node.AddMember("metadata", metadata, r.a);
        return node;
    });
}

rj::Value putValue(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path", "value"});
    const auto path = check.path();
    const auto* value = check.any("value");
    check.done();
    return sdkCall("Set property " + joined(path), [&] {
        const auto component = lookupComponent(e.root, id);
        std::string leaf;
        const auto owner = ownerOf(component, path, leaf);
        const auto property = owner.getProperty(leaf);
        const std::string valueType = valueTypeOf(property);
        if (readOnly(property))
            fail(409, "conflict", "property " + reprText(leaf) + " is read-only");
        if (valueType == "func" || valueType == "proc")
            fail(400, "bad_request", "property " + reprText(leaf) + " is callable - use the execute endpoint");
        // A selection property stores the key of its option, whatever its type.
        const bool isSelection = safe<bool>([&] { return property.getSelectionValues().assigned(); }, false) &&
                                 safe<CoreType>([&] { return property.getItemType(); }, ctUndefined) != ctUndefined;
        if (!isSelection && valueType == "object")
            fail(400, "bad_request", "property " + reprText(leaf) + " is an object - assign its children instead");
        owner.setPropertyValue(leaf, fromJson(*value, valueType, e.context.getTypeManager()));
        return readProperty(component, path, r.a);
    });
}

rj::Value putStructField(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path", "field", "value"});
    const auto path = check.path();
    const std::string field = check.text("field");
    const auto* value = check.any("value");
    check.done();
    // openDAQ structs are immutable: one field is changed by building the
    // struct again with the other fields as they are.
    return sdkCall("Set struct field " + joined(path) + "." + field, [&] {
        const auto component = lookupComponent(e.root, id);
        std::string leaf;
        const auto owner = ownerOf(component, path, leaf);
        if (readOnly(owner.getProperty(leaf)))
            fail(409, "conflict", "property " + reprText(leaf) + " is read-only");
        const auto current = owner.getPropertyValue(leaf);
        const auto structure = current.assigned() ? current.asPtrOrNull<IStruct>() : nullptr;
        if (!structure.assigned())
            fail(400, "bad_request", "property " + reprText(leaf) + " is not a struct");
        const auto fields = safe<DictPtr<IString, IBaseObject>>([&] { return structure.getAsDictionary(); }, Dict<IString, IBaseObject>());
        if (!fields.hasKey(field))
            fail(404, "not_found", "struct field not found: " + field);

        rj::Document payload(rj::kObjectType);
        auto& pa = payload.GetAllocator();
        rj::Value values(rj::kObjectType);
        for (const auto& [name, item] : fields)
            values.AddMember(str(name.toStdString(), pa), name.toStdString() == field ? rj::Value(*value, pa) : valueToJson(item, pa), pa);
        const auto structType = safe<StructTypePtr>([&] { return structure.getStructType(); }, nullptr);
        payload.AddMember("kind", "struct", pa);
        payload.AddMember("typeName", structType.assigned() ? str(textOf(structType.getName()), pa) : rj::Value(), pa);
        payload.AddMember("fields", values, pa);
        owner.setPropertyValue(leaf, fromJson(payload, "struct", e.context.getTypeManager()));
        return readProperty(component, path, r.a);
    });
}

rj::Value putContainer(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path", "items"});
    const auto path = check.path();
    const auto* items = check.any("items");
    check.done();
    // A list or dict is replaced whole, as the UI's editor submits it.
    return sdkCall("Set container " + joined(path), [&] {
        const auto component = lookupComponent(e.root, id);
        std::string leaf;
        const auto owner = ownerOf(component, path, leaf);
        const auto property = owner.getProperty(leaf);
        const std::string valueType = valueTypeOf(property);
        if (valueType != "list" && valueType != "dict")
            fail(400, "bad_request", "property " + reprText(leaf) + " is not a list or dict");
        if (readOnly(property))
            fail(409, "conflict", "property " + reprText(leaf) + " is read-only");
        const std::string itemType = coreTypeName(safe<CoreType>([&] { return property.getItemType(); }, ctUndefined));
        const std::string keyType = coreTypeName(safe<CoreType>([&] { return property.getKeyType(); }, ctUndefined));
        const auto types = e.context.getTypeManager();
        BaseObjectPtr collection;
        if (valueType == "list")
        {
            if (!items->IsArray())
                fail(400, "bad_request", "expected a list of items");
            auto list = List<IBaseObject>();
            for (const auto& item : items->GetArray())
                list.pushBack(fromJson(item, itemType, types));
            collection = list;
        }
        else
        {
            if (!items->IsObject())
                fail(400, "bad_request", "expected an object of key/value pairs");
            auto dict = Dict<IBaseObject, IBaseObject>();
            for (const auto& item : items->GetObject())
                dict.set(fromJson(item.name, keyType, types), fromJson(item.value, itemType, types));
            collection = dict;
        }
        owner.setPropertyValue(leaf, collection);
        return readProperty(component, path, r.a);
    });
}

rj::Value postClear(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path"});
    const auto path = check.path();
    check.done();
    return sdkCall("Clear property value", [&] {
        const auto component = lookupComponent(e.root, id);
        std::string leaf;
        ownerOf(component, path, leaf).clearPropertyValue(leaf);
        return readProperty(component, path, r.a);
    });
}

rj::Value postExecute(Engine& e, const Request& r)
{
    Check check(r.query, r.body);
    const std::string id = check.query("id");
    check.fields({"path", "arguments"});
    const auto path = check.path();
    const auto* supplied = check.list("arguments");
    check.done();
    auto out = sdkCall("Execute " + joined(path), [&] {
        std::string leaf;
        const auto owner = ownerOf(lookupComponent(e.root, id), path, leaf);
        const auto property = owner.getProperty(leaf);
        const std::string valueType = valueTypeOf(property);
        if (valueType != "func" && valueType != "proc")
            fail(400, "bad_request", "property " + reprText(leaf) + " is not callable");

        const auto info = safe<CallableInfoPtr>([&] { return property.getCallableInfo(); }, nullptr);
        const auto expected = info.assigned() ? safe<ListPtr<IArgumentInfo>>([&] { return info.getArguments(); }, nullptr) : nullptr;
        const size_t count = expected.assigned() ? expected.getCount() : 0;
        const size_t given = supplied ? supplied->Size() : 0;
        if (given != count)
        {
            std::string signature;
            for (size_t i = 0; i < count; i++)
                signature += (i ? ", " : "") + textOf(expected[i].getName()) + ": " + coreTypeName(expected[i].getType());
            throw HttpError{400, "bad_request",
                            reprText(leaf) + " expects " + std::to_string(count) + " argument(s), got " + std::to_string(given),
                            signature.empty() ? "no arguments" : signature, ""};
        }
        // One argument is passed as itself, several as a list, as the SDK's
        // own bindings call.
        const auto types = e.context.getTypeManager();
        auto arguments = List<IBaseObject>();
        for (size_t i = 0; i < count; i++)
            arguments.pushBack(fromJson((*supplied)[static_cast<rj::SizeType>(i)], coreTypeName(expected[i].getType()), types));
        const BaseObjectPtr parameters = count == 0 ? nullptr : count == 1 ? arguments[0] : BaseObjectPtr(arguments);

        rj::Value result(rj::kObjectType);
        result.AddMember("name", str(leaf, r.a), r.a);
        result.AddMember("path", strings(path, r.a), r.a);
        result.AddMember("returned", valueType == "func", r.a);
        if (valueType == "func")
        {
            const FunctionPtr function = owner.getPropertyValue(leaf);
            BaseObjectPtr returned;
            checkErrorInfo(function->call(parameters, &returned));
            result.AddMember("result", valueToJson(returned, r.a), r.a);
        }
        else
        {
            const ProcedurePtr procedure = owner.getPropertyValue(leaf);
            checkErrorInfo(procedure->dispatch(parameters));
            result.AddMember("result", rj::Value(), r.a);
        }
        return result;
    });
    const std::string detail = plainText(out["result"]);
    e.pushEvent(notificationEvent("Executed " + joined(path), "info", id, &detail));
    return out;
}

}  // namespace

rj::Value listProperties(const PropertyObjectPtr& object, bool includeHidden, Alloc& a)
{
    rj::Value list(rj::kArrayType);
    for (const auto& property : propertiesOf(object, includeHidden))
        list.PushBack(propertyNode(object, property, {textOf(property.getName())}, includeHidden, a), a);
    // A plain property object, such as a default configuration, has no ID
    // and is never updating.
    const auto component = object.asPtrOrNull<IComponent>();
    const std::string className = safe<std::string>([&] { return textOf(object.getClassName()); }, "");
    rj::Value out(rj::kObjectType);
    out.AddMember("componentId",
                  str(component.assigned() ? safe<std::string>([&] { return textOf(component.getGlobalId()); }, "") : "", a), a);
    out.AddMember("className", className.empty() ? rj::Value() : str(className, a), a);
    out.AddMember("updating", component.assigned() && safe<bool>([&] { return static_cast<bool>(component.getUpdating()); }, false), a);
    out.AddMember("properties", list, a);
    return out;
}

rj::Value metadataFields(Alloc& a)
{
    rj::Value list(rj::kArrayType);
    for (const auto& [key, label] : kMetadataFields)
    {
        rj::Value field(rj::kObjectType);
        field.AddMember("key", rj::StringRef(key), a);
        field.AddMember("label", rj::StringRef(label), a);
        list.PushBack(field, a);
    }
    rj::Value out(rj::kObjectType);
    out.AddMember("fields", list, a);
    return out;
}

void addPropertyRoutes(Router& router)
{
    router.add("GET", "/api/properties", getProperties);
    router.add("POST", "/api/properties/read", postRead);
    router.add("POST", "/api/properties/metadata", postMetadata);
    router.add("PUT", "/api/properties/value", putValue);
    router.add("PUT", "/api/properties/struct-field", putStructField);
    router.add("PUT", "/api/properties/container", putContainer);
    router.add("POST", "/api/properties/clear", postClear);
    router.add("POST", "/api/properties/execute", postExecute);
}

}  // namespace studio
