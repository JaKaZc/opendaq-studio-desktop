// What the topology, server and fleet routes share: looking components up,
// reading request bodies strictly, and the JSON they write for component
// types, device infos, configuration objects and signals.

#pragma once

#include "routes.h"

#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

namespace studio
{

// ------------------------------------------------------------------ lookups

/// The component with a global ID, or a 404 naming it. The root's own
/// segment is dropped and the rest is found below the root, so "/" and the
/// root's ID are the root.
ComponentPtr componentAt(Engine& e, const std::string& id);
/// The device with a global ID, or the root for an empty ID.
DevicePtr deviceAt(Engine& e, const std::string& id);
/// The nearest device at or above a component, or null.
DevicePtr nearestDevice(ComponentPtr component);

// ------------------------------------------------------------------ requests

/// The request body, refused with 422 unless it is an object whose members
/// are all among `allowed`.
const rj::Value& bodyOf(const Request& r, std::initializer_list<const char*> allowed);
/// A string member of the body: required ones are refused when missing or
/// empty; optional ones are empty when missing or null.
std::string textMember(const rj::Value& body, const char* name, bool required);
/// A bool member of the body, or `fallback` when it is missing.
bool flagMember(const rj::Value& body, const char* name, bool fallback);
/// A bool member the body must have.
bool flagMember(const rj::Value& body, const char* name);
/// Text without the white space around it.
std::string trimmed(const std::string& text);
/// A query parameter that must be given, or a 422.
std::string requiredQuery(const Request& r, const char* name);
/// A boolean query parameter such as includeHidden=true.
bool queryFlag(const Request& r, const char* name);
/// Whether the query has a parameter at all, given or empty.
bool hasQuery(const Request& r, const char* name);

/// Publishes a line for the event log.
void notify(Engine& e, const std::string& level, const std::string& message, const std::string& detail,
            const std::string& componentId);

// ------------------------------------------------------------------ values

/// An openDAQ value as the API writes it.
rj::Value toJson(const BaseObjectPtr& value, Alloc& a, int depth = 0);
/// Every status of a component and the worst level:
/// {level, message, statuses}.
rj::Value statusSummary(const ComponentPtr& component, Alloc& a);
/// Whether a device is connected; local devices have no ConnectionStatus.
bool isConnected(const DevicePtr& device);
/// An operation mode's name, or null for one the API does not know.
rj::Value operationModeJson(Int mode);

// ------------------------------------------------------------------ types

/// The entries of a dictionary of component types, as {id, key, name,
/// description, kind, connectionStringPrefix}, or empty when the host
/// does not offer that family of types.
rj::Value typesJson(const std::function<BaseObjectPtr()>& getter, const char* kind, Alloc& a);
rj::Value deviceTypesJson(const ComponentPtr& host, Alloc& a);
rj::Value functionBlockTypesJson(const ComponentPtr& host, Alloc& a);
rj::Value serverTypesJson(Engine& e, Alloc& a);
/// Streaming types across every loaded module, the first of each ID.
rj::Value streamingTypesJson(Engine& e, Alloc& a);
/// A type's default configuration as a property list, or null when it has
/// no settings.
rj::Value defaultConfigJson(const ComponentTypePtr& type, Alloc& a);

// ------------------------------------------------------------------ configuration

/// A configuration object's properties, hidden ones included:
/// {componentId, className, updating, properties}.
rj::Value configJson(const PropertyObjectPtr& config, Alloc& a);
/// Applies a flat {"Section.Sub.Property": value} map onto a configuration
/// object and returns the keys it could not apply.
std::vector<std::string> applyConfig(const PropertyObjectPtr& config, const rj::Value& values, const TypeManagerPtr& types);
/// The body's `config` member when it has entries, or null.
const rj::Value* configValues(const rj::Value& body);

// ------------------------------------------------------------------ devices

rj::Value deviceInfoJson(const DeviceInfoPtr& info, bool full, Alloc& a);
/// One protocol a discovered device advertises.
struct Capability
{
    std::string protocolId;
    std::string protocolName;
    std::string connectionString;
    std::string connectionType;
    std::string protocolType;
    /// The connection string of each address type, such as IPv4.
    std::vector<std::pair<std::string, std::string>> addresses;
};

std::vector<Capability> capabilitiesOf(const DeviceInfoPtr& info);
rj::Value capabilitiesJson(const std::vector<Capability>& capabilities, Alloc& a);
/// The discovered device a connection string names, directly or through one
/// of its protocols' addresses, or null. Runs a discovery sweep.
DeviceInfoPtr findAvailableDevice(const DevicePtr& parent, const std::string& connection);
/// A reason to refuse connecting this instance to its own configuration
/// server, or empty; see selfconnect.cpp.
std::string selfRefusal(Engine& e, const std::string& connection);

// ------------------------------------------------------------------ signals and ports

/// A signal as the signal list describes it, without its descriptors.
rj::Value signalInfo(const SignalPtr& signal, Alloc& a);
/// Samples per second from a domain descriptor's linear rule, or null.
rj::Value sampleRateJson(const DataDescriptorPtr& domain);

}  // namespace studio
