// /api/modules: the loaded modules, the types each one offers, and loading
// another one at run time.

#include "properties.h"
#include "routes.h"
#include "signal_info.h"

#include <algorithm>
#include <cctype>

namespace studio
{

namespace
{

const char* const kKinds[] = {"device", "functionBlock", "server", "streaming"};

/// A module's component types of one kind, by key; empty when the module
/// does not offer that kind.
DictPtr<IString, IComponentType> typesOf(const ModulePtr& module, const std::string& kind)
{
    return safe<DictPtr<IString, IComponentType>>(
        [&]() -> DictPtr<IString, IComponentType>
        {
            if (kind == "device")
                return module.getAvailableDeviceTypes();
            if (kind == "functionBlock")
                return module.getAvailableFunctionBlockTypes();
            if (kind == "server")
                return module.getAvailableServerTypes();
            return module.getAvailableStreamingTypes();
        },
        nullptr);
}

rj::Value typeJson(const ComponentTypePtr& type, const std::string& key, const std::string& kind, Alloc& a)
{
    const auto text = [&](auto getter) { return safe<std::string>([&] { return getter().toStdString(); }, ""); };
    const std::string id = text([&] { return type.getId(); });
    const std::string name = text([&] { return type.getName(); });
    rj::Value out(rj::kObjectType);
    out.AddMember("id", str(id.empty() ? key : id, a), a);
    out.AddMember("key", str(key, a), a);
    out.AddMember("name", str(name.empty() ? key : name, a), a);
    out.AddMember("description", str(text([&] { return type.getDescription(); }), a), a);
    out.AddMember("kind", str(kind, a), a);
    rj::Value prefix;
    isSafe([&] {
        if (kind == "device" && type.supportsInterface<IDeviceType>())
            prefix = str(type.asPtr<IDeviceType>().getConnectionStringPrefix().toStdString(), a);
        else if (kind == "streaming" && type.supportsInterface<IStreamingType>())
            prefix = str(type.asPtr<IStreamingType>().getConnectionStringPrefix().toStdString(), a);
    });
    out.AddMember("connectionStringPrefix", prefix, a);
    return out;
}

/// The module's ID, or a stand-in for a module without one.
std::string moduleId(const ModulePtr& module, size_t index)
{
    const std::string id = safe<std::string>([&] { return module.getModuleInfo().getId().toStdString(); }, "");
    return id.empty() ? "__module_" + std::to_string(index) + "__" : id;
}

/// The version, and for a development build of a module its branch and
/// commit.
void addVersion(rj::Value& out, const ModuleInfoPtr& info, Alloc& a)
{
    const auto version = safe<VersionInfoPtr>([&] { return info.getVersionInfo(); }, nullptr);
    rj::Value number, branch, hash;
    bool development = false;
    if (version.assigned())
    {
        const auto part = [](auto getter) { return std::to_string(safe<SizeT>(getter, 0)); };
        std::string text = part([&] { return version.getMajor(); }) + "." + part([&] { return version.getMinor(); }) + "." +
                           part([&] { return version.getPatch(); });
        if (const auto dev = version.asPtrOrNull<IDevelopmentVersionInfo>(); dev.assigned())
        {
            development = true;
            text += "." + part([&] { return dev.getTweak(); });
            const std::string branchName = safe<std::string>([&] { return dev.getBranchName().toStdString(); }, "");
            const std::string digest = safe<std::string>([&] { return dev.getHashDigest().toStdString(); }, "");
            if (!branchName.empty())
                branch = str(branchName, a);
            if (!digest.empty())
                hash = str(digest, a);
        }
        number = str(text, a);
    }
    out.AddMember("version", number, a);
    out.AddMember("branch", branch, a);
    out.AddMember("hash", hash, a);
    out.AddMember("isDevelopment", development, a);
}

rj::Value moduleJson(const ModulePtr& module, size_t index, Alloc& a)
{
    const auto info = module.getModuleInfo();
    const std::string id = moduleId(module, index);
    const std::string name = safe<std::string>([&] { return info.getName().toStdString(); }, "");
    rj::Value out(rj::kObjectType);
    out.AddMember("id", str(id, a), a);
    out.AddMember("name", str(name.empty() ? id : name, a), a);
    addVersion(out, info, a);
    rj::Value types(rj::kObjectType);
    rj::Value counts(rj::kObjectType);
    for (const char* kind : kKinds)
    {
        rj::Value list(rj::kArrayType);
        isSafe([&] {
            if (const auto dict = typesOf(module, kind); dict.assigned())
                for (const auto& [key, type] : dict)
                    list.PushBack(typeJson(type, key.toStdString(), kind, a), a);
        });
        counts.AddMember(rj::StringRef(kind), list.Size(), a);
        types.AddMember(rj::StringRef(kind), list, a);
    }
    out.AddMember("typeCounts", counts, a);
    out.AddMember("types", types, a);
    return out;
}

rj::Value moduleList(Engine& e, Alloc& a)
{
    rj::Value list(rj::kArrayType);
    const auto modules = safe<ListPtr<IModule>>([&] { return e.instance.getModuleManager().getModules(); }, List<IModule>());
    size_t index = 0;
    for (const auto& module : modules)
    {
        // A module that cannot say what it is is left out.
        isSafe([&] { list.PushBack(moduleJson(module, index, a), a); });
        index++;
    }
    const auto lower = [](const rj::Value& entry)
    {
        std::string name = entry["name"].GetString();
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return name;
    };
    std::stable_sort(list.Begin(), list.End(), [&](const rj::Value& x, const rj::Value& y) { return lower(x) < lower(y); });
    return list;
}

rj::Value modules(Engine& e, const Request& r)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("modules", moduleList(e, r.a), r.a);
    return out;
}

/// One component type with its default configuration expanded, which tells
/// which settings a protocol has before connecting with it.
rj::Value typeDetail(Engine& e, const Request& r)
{
    for (const char* name : {"moduleId", "kind", "typeKey"})
        if (!r.query.HasMember(name))
            fail(422, "invalid_request", std::string("The request needs ") + name);
    const std::string id = queryString(r.query, "moduleId");
    const std::string kind = queryString(r.query, "kind");
    const std::string key = queryString(r.query, "typeKey");
    if (std::none_of(std::begin(kKinds), std::end(kKinds), [&](const char* k) { return kind == k; }))
        fail(404, "not_found", "unknown component type kind: " + kind);

    size_t index = 0;
    for (const auto& module : e.instance.getModuleManager().getModules())
    {
        if (moduleId(module, index++) != id)
            continue;
        const auto types = typesOf(module, kind);
        if (!types.assigned())
            fail(404, "not_found", "module " + id + " does not report " + kind + " types");
        if (!types.hasKey(key))
            fail(404, "not_found", kind + " type not found: " + key);
        const ComponentTypePtr type = types.get(key);
        auto out = typeJson(type, key, kind, r.a);
        out.AddMember("moduleId", str(id, r.a), r.a);
        rj::Value config;
        const auto defaults = safe<PropertyObjectPtr>([&] { return type.createDefaultConfig(); }, nullptr);
        if (defaults.assigned() && safe<SizeT>([&] { return defaults.getAllProperties().getCount(); }, 0) > 0)
            config = listProperties(defaults, true, r.a);
        out.AddMember("defaultConfig", config, r.a);
        return out;
    }
    fail(404, "not_found", "module not found: " + id);
}

rj::Value load(Engine& e, const Request& r)
{
    requireOnly(r.body, {"path"});
    const auto& path = member(r.body, "path");
    if (!path.IsString() || path.GetStringLength() == 0)
        fail(422, "invalid_request", "The path must be a file name");
    try
    {
        e.instance.getModuleManager().loadModule(path.GetString());
    }
    catch (const DaqException& error)
    {
        failSdk("Load module", error);
    }
    // A new module can bring new function block types and change old answers.
    forgetFunctionBlockFit();
    rj::Value ids(rj::kArrayType);
    for (const auto& module : moduleList(e, r.a).GetArray())
        ids.PushBack(rj::Value(module["id"], r.a), r.a);
    e.notify(std::string("Loaded module ") + path.GetString(), "success", "viewer");
    e.invalidateTree("moduleLoaded");
    rj::Value out(rj::kObjectType);
    out.AddMember("path", rj::Value(path, r.a), r.a);
    out.AddMember("modules", ids, r.a);
    return out;
}

}  // namespace

void addModuleRoutes(Router& router)
{
    router.add("GET", "/api/modules", modules);
    router.add("GET", "/api/modules/type", typeDetail);
    router.add("POST", "/api/modules/load", load);
}

}  // namespace studio
