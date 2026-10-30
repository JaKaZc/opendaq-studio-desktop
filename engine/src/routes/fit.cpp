// /api/signals/function-block-fit: which function block types work on a
// signal, answered by the SDK.
//
// The input port's acceptsSignal says yes for every reference block and every
// signal, so it cannot tell a Statistics block from a Struct decoder. What
// does tell them apart is the block's own status once the signal is
// connected: a block checks the descriptor when it is connected and reports,
// for example, "Invalid sample type" or "Port Current is not connected!".
//
// So the check adds each type, connects the signal to the block's first input
// port, reads the status the block sets, and removes the block again. Results
// are cached per type and per kind of signal, the parts of its descriptors a
// block can react to, so a signal is only probed the first time its kind is
// seen.

#include "routes.h"
#include "signal_info.h"

#include "../platform.h"

#include <mutex>

namespace studio
{

namespace
{

/// Types that are never added for a check, and why. Both open a native window
/// on the machine that runs openDAQ Studio as soon as they exist.
const std::map<std::string, std::string> kNotProbed = {
    {"RefFBModuleRenderer", "It opens a window on the machine that runs openDAQ Studio."},
    {"RefFBModuleVideoPlayer", "It opens a window on the machine that runs openDAQ Studio."},
};

struct Verdict
{
    bool works = false;
    std::string reason;
    /// Each output signal's name and shape.
    std::vector<std::pair<std::string, std::string>> outputs;
};

std::mutex cacheLock;
std::map<std::pair<std::string, std::string>, Verdict> cache;

/// The parts of a signal's descriptors that decide whether a block can use it.
std::string fingerprint(const SignalPtr& signal)
{
    const auto describe = [](const DataDescriptorPtr& descriptor) -> std::string
    {
        if (!descriptor.assigned())
            return "-";
        std::string fields;
        isSafe([&] {
            for (const DataDescriptorPtr& field : descriptor.getStructFields())
                fields += (fields.empty() ? "" : ",") + textOf(field.getName());
        });
        const auto range = safe<RangePtr>([&] { return descriptor.getValueRange(); }, nullptr);
        return sampleTypeText(descriptor) + "|" +
               safe<std::string>([&] { return textOf(descriptor.getUnit().getSymbol()); }, "") + "|" +
               std::to_string(safe<int>([&] { return static_cast<int>(descriptor.getRule().getType()); }, -1)) + "|" +
               std::to_string(safe<size_t>([&] { return descriptor.getDimensions().getCount(); }, 0)) + "|" + fields + "|" +
               (range.assigned() ? safe<std::string>([&] { return textOf(range.getLowValue()) + ":" + textOf(range.getHighValue()); }, "") : "");
    };
    return describe(descriptorOf(signal)) + "#" + describe(domainDescriptorOf(signal));
}

std::string statusName(const ComponentStatusContainerPtr& container, const char* name)
{
    return safe<std::string>(
        [&] {
            const auto statuses = container.getStatuses();
            return statuses.hasKey(name) ? textOf(statuses.get(name).getValue()) : std::string();
        },
        "");
}

/// Adds one block, connects the signal, reads its verdict, removes it.
Verdict probe(Engine& e, const SignalPtr& signal, const std::string& typeId)
{
    Verdict verdict;
    FunctionBlockPtr block;
    // The probe stays out of the event stream.
    e.beginProbe(textOf(e.root.getGlobalId()) + "/FB");
    try
    {
        block = e.instance.addFunctionBlock(typeId);
    }
    catch (const std::exception& error)
    {
        e.endProbe();
        verdict.reason = std::string("It cannot be added here: ") + error.what();
        return verdict;
    }
    e.endProbe();
    e.ignoreComponents({safe<std::string>([&] { return textOf(block.getGlobalId()); }, "")});
    const auto ports = safe<ListPtr<IInputPort>>([&] { return block.getInputPorts(); }, nullptr);
    bool connected = false;
    if (!ports.assigned() || ports.getCount() == 0)
        verdict.reason = "It has no input port.";
    else
    {
        try
        {
            InputPortPtr(ports[0]).connect(signal);
            connected = true;
        }
        catch (const std::exception& error)
        {
            verdict.reason = std::string("Its input port refused the signal: ") + error.what();
        }
    }
    if (connected)
    {
        const auto container = safe<ComponentStatusContainerPtr>([&] { return block.getStatusContainer(); }, nullptr);
        const std::string component = container.assigned() ? statusName(container, "ComponentStatus") : "";
        const std::string input = container.assigned() ? statusName(container, "InputStatus") : "";
        std::string message = safe<std::string>([&] { return textOf(container.getStatusMessage("ComponentStatus")); }, "");
        if (message.empty() && !input.empty())
            message = safe<std::string>([&] { return textOf(container.getStatusMessage("InputStatus")); }, "");

        verdict.works = (component.empty() || component == "Ok") && input != "Invalid";
        isSafe([&] {
            for (const auto& output : block.getSignalsRecursive())
            {
                const auto descriptor = descriptorOf(output);
                if (descriptor.assigned())
                    verdict.outputs.emplace_back(safe<std::string>([&] { return output.getName().toStdString(); }, ""),
                                                 signalShape(descriptor, domainDescriptorOf(output)));
            }
        });
        if (!verdict.works)
            verdict.reason = message.empty() ? "It reports " + (component.empty() ? input : component) + "." : message;
    }
    if (!isSafe([&] { e.instance.removeFunctionBlock(block); }))
        platform::log(platform::Level::Warn, kTag, "Could not remove the probe block of %s", typeId.c_str());
    return verdict;
}

/// Every function block type of the instance, with whether it works when the
/// signal is connected.
rj::Value functionBlockFit(Engine& e, const Request& r)
{
    auto& a = r.a;
    if (!r.query.IsObject() || !r.query.HasMember("id"))
        fail(422, "invalid_request", "The request needs id");
    const std::string id = queryString(r.query, "id");
    const auto signal = signalOf(e, id);
    const std::string kind = fingerprint(signal);
    const auto types = safe<DictPtr<IString, IFunctionBlockType>>([&] { return e.instance.getAvailableFunctionBlockTypes(); }, nullptr);

    rj::Value entries(rj::kArrayType);
    if (types.assigned())
        for (const auto& [key, value] : types)
        {
            const std::string typeId = key.toStdString();
            const FunctionBlockTypePtr type = value;
            std::string name = safe<std::string>([&] { return textOf(type.getName()); }, "");
            rj::Value entry(rj::kObjectType);
            entry.AddMember("id", str(typeId, a), a);
            entry.AddMember("name", str(name.empty() ? typeId : name, a), a);
            entry.AddMember("description", str(safe<std::string>([&] { return textOf(type.getDescription()); }, ""), a), a);

            Verdict verdict;
            const auto skipped = kNotProbed.find(typeId);
            if (skipped != kNotProbed.end())
                verdict.reason = skipped->second;
            else
            {
                std::lock_guard guard(cacheLock);
                const auto cached = cache.find({typeId, kind});
                verdict = cached != cache.end() ? cached->second : (cache[{typeId, kind}] = probe(e, signal, typeId));
            }
            entry.AddMember("works", verdict.works, a);
            entry.AddMember("reason", verdict.works ? rj::Value() : str(verdict.reason, a), a);
            rj::Value outputs(rj::kArrayType);
            for (const auto& [output, shape] : verdict.outputs)
            {
                rj::Value o(rj::kObjectType);
                o.AddMember("name", str(output, a), a);
                o.AddMember("shape", str(shape, a), a);
                outputs.PushBack(o, a);
            }
            entry.AddMember("outputs", outputs, a);
            entries.PushBack(entry, a);
        }
    rj::Value out(rj::kObjectType);
    out.AddMember("signalId", str(id, a), a);
    out.AddMember("types", entries, a);
    return out;
}

}  // namespace

void forgetFunctionBlockFit()
{
    std::lock_guard guard(cacheLock);
    cache.clear();
}

void addFitRoutes(Router& router)
{
    router.add("GET", "/api/signals/function-block-fit", functionBlockFit);
}

}  // namespace studio
