// Helpers every part of the engine uses: errors that become HTTP-style
// answers, JSON building, openDAQ values to JSON and back, and the facts the
// API reports about components and signals.

#pragma once

#include <opendaq/opendaq.h>

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <functional>
#include <initializer_list>
#include <string>
#include <vector>

namespace studio
{

using namespace daq;
namespace rj = rapidjson;
using Alloc = rj::Document::AllocatorType;

/// The tag of the engine's own log lines.
extern const char* const kTag;

// ------------------------------------------------------------------ errors

/// A refused request: the status and the `{code, message, detail}` body it
/// answers. `extra` holds further
/// members of the body as a JSON object's text, or is empty.
struct HttpError
{
    int status;
    std::string code;
    std::string message;
    std::string detail;
    std::string extra;
};

[[noreturn]] void fail(int status, const std::string& code, const std::string& message, const std::string& detail = "");

/// The answer to an exception the SDK threw while doing `action`, classified
/// as not found, a conflict, a value that cannot be used
/// (std::invalid_argument) or the SDK refusing.
HttpError sdkError(const std::string& action, const std::exception& error);
[[noreturn]] void failSdk(const std::string& action, const std::exception& error);

/// Runs `work`, answering an exception with `label`: "<label> failed", with
/// the exception's text as detail.
template <typename F>
auto sdkCall(const std::string& label, F&& work) -> decltype(work())
{
    try
    {
        return work();
    }
    catch (const HttpError&)
    {
        throw;
    }
    catch (const std::exception& error)
    {
        throw sdkError(label, error);
    }
}

// ------------------------------------------------------------------ JSON

rj::Value str(const std::string& text, Alloc& a);
std::string toText(const rj::Value& value);

/// `{"ok": true}`, the answer of a change that has nothing else to say.
rj::Value ok(Alloc& a);

/// Any openDAQ object's text, as its toString gives it.
std::string textOf(const BaseObjectPtr& object);
std::string formatNumber(double value);

bool isSafe(const std::function<void()>& action);

template <typename T, typename F>
T safe(F&& getter, T fallback)
{
    try
    {
        return getter();
    }
    catch (...)
    {
        return fallback;
    }
}

// ------------------------------------------------------------------ requests

/// A query parameter's first value, or empty.
std::string queryString(const rj::Value& query, const char* name);
/// Every value of a repeated query parameter.
std::vector<std::string> queryList(const rj::Value& query, const char* name);
/// A member of the request body, or a 422 refusal naming it, as Check gives.
const rj::Value& member(const rj::Value& body, const char* name);

/// A request checked against the API's request contract. The problems
/// collect in a list of validation errors, and done() answers 422 with all
/// of them as `detail`. Fields are checked in the contract's order.
class Check
{
public:
    Check(const rj::Value& query, const rj::Value& body);

    /// A required query parameter; its last value when it is given more than once.
    std::string query(const char* name);
    /// An optional boolean query parameter.
    bool queryFlag(const char* name, bool fallback = false);

    /// The body must be an object.
    void object();
    /// The body must be an object with no members but `fields`.
    void fields(std::initializer_list<const char*> fields);
    /// A required member of any type, or null when it is missing.
    const rj::Value* any(const char* name);
    /// A required list of strings, at least one: a property path.
    std::vector<std::string> path(const char* name = "path");
    /// A required string, at least one character.
    std::string text(const char* name);
    /// A required boolean.
    bool flag(const char* name);
    /// An optional list, or null when it is missing.
    const rj::Value* list(const char* name);

    void done();

private:
    const rj::Value& queryValues;
    const rj::Value& body;
    bool bodyUsable = false;
    rj::Document errors;
    std::vector<std::string> extra;

    void add(const char* type, std::initializer_list<const char*> loc, const char* message, const rj::Value* input,
             rj::Value context = rj::Value(), int index = -1);
    bool parseBool(const rj::Value& value, bool& out) const;
};

// ------------------------------------------------------------------ value texts

/// A float as the shortest text that reads back the same, such as "0.1".
std::string floatRepr(double value);
/// A JSON value in its literal form, with quoted strings, None, True and
/// False, and as plain text, where a string is itself. The API's messages
/// and labels are built with them.
std::string reprText(const rj::Value& value);
std::string plainText(const rj::Value& value);
std::string reprText(const std::string& text);
/// Whether a JSON value counts as true: not null, false, zero or empty.
bool truthy(const rj::Value& value);

// ------------------------------------------------------------------ values

const char* coreTypeName(CoreType type);
CoreType coreTypeOf(const BaseObjectPtr& value);

/// An openDAQ value as the API writes it: scalars as themselves, richer
/// values with a `kind` discriminator.
rj::Value valueToJson(const BaseObjectPtr& value, Alloc& a, int depth = 0);
/// JSON to an openDAQ value. `hint` is the wire name of the core type the
/// target expects, such as "int", which decides scalars; structs and
/// enumerations need the type manager. A value that cannot be made throws
/// std::invalid_argument with the message the API reports.
BaseObjectPtr fromJson(const rj::Value& value, const std::string& hint, const TypeManagerPtr& types);
/// A unit as `{id, symbol, name, quantity}`, or null when it says nothing.
rj::Value unitJson(const UnitPtr& unit, Alloc& a);

// ------------------------------------------------------------------ components

/// The component an API id names: the first part of the id is the root,
/// whatever it says; the rest is looked up from the root. Answers 404 when
/// nothing has the id.
ComponentPtr lookupComponent(const DevicePtr& root, const std::string& id);

/// The kind of a component for the UI. The root is "instance", unless it is
/// a real device, such as the phone device the phone app makes its root.
std::string kindOf(const ComponentPtr& component, const ComponentPtr& root, bool rootIsDevice);
std::string operationModeName(OperationModeType mode);
OperationModeType operationModeFrom(const std::string& name);
/// `{level, message, statuses}`: every status of a component, and the level
/// and message of its ComponentStatus, which colour the tree.
rj::Value statusJson(const ComponentPtr& component, Alloc& a);
/// Whether a device is connected. Local devices have no ConnectionStatus,
/// which counts as connected.
bool deviceConnected(const DevicePtr& device);
ComponentPtr owningDevice(ComponentPtr component);
/// A function block's input ports and the signals connected to them.
rj::Value inputPortsJson(const ComponentPtr& component, Alloc& a);

/// The text of a `notification` event, an entry of the UI's event log.
std::string notificationEvent(const std::string& message, const char* level, const std::string& componentId,
                              const std::string* detail = nullptr);

// ------------------------------------------------------------------ signals

bool isNumeric(SampleType type);
/// A sample type's name as openDAQ calls it, such as "Float64".
std::string sampleTypeName(SampleType type);
/// Seconds since the Unix epoch of a domain origin such as
/// "1970-01-01T00:00:00Z" or "2024-01-01T00:00:00.5+01:00", or false.
bool originSeconds(const std::string& text, double& out);
/// Seconds per tick of a domain descriptor, or 0 when it has none.
double tickSeconds(const DataDescriptorPtr& domain);
/// Samples per second from a linear domain rule, or 0.
double sampleRate(const SignalPtr& signal);

struct SignalFacts
{
    bool chartable = false;
    std::string shape = "scalar";
    std::string unit;
    /// The picture format of an image signal, such as "jpeg", or empty.
    /// openDAQ's video convention: Binary samples, one picture each, with the
    /// format as the unit's symbol. "plot" is the Universal renderer's plot
    /// data, which the UI draws; it is fetched the same way.
    std::string image;
};

SignalFacts factsOf(const SignalPtr& signal);

/// What the signal list and the detail panel show of a signal: its signal
/// info without the descriptors.
rj::Value signalInfoJson(const SignalPtr& signal, Alloc& a);
/// A signal's last value, rendered as the signal list shows it.
rj::Value lastValueJson(const SignalPtr& signal, Alloc& a);

}  // namespace studio
