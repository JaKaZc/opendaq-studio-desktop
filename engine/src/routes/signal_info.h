// What the API says about a signal: the signal info of the lists,
// descriptors, the descriptor maths the scope depends on, and last values.
// The streams and the function block check use the same facts.

#pragma once

#include "../engine.h"

namespace studio
{

/// A component by global ID, or a 404 naming it. The instance's own ID, ""
/// and "/" are the root.
ComponentPtr componentOf(Engine& e, const std::string& id);
/// A signal by global ID, or a 404 naming it.
SignalPtr signalOf(Engine& e, const std::string& id);

/// Signals belonging to a device, function block or signal, hidden ones too
/// with `includeHidden`.
std::vector<SignalPtr> collectSignals(const ComponentPtr& component, bool includeHidden);

/// A sample type's name, such as "Float64".
std::string sampleTypeText(const DataDescriptorPtr& descriptor);
/// Samples per second from a domain descriptor's rule, or 0.
double domainSampleRate(const DataDescriptorPtr& domain);
/// Whether a domain descriptor carries wall-clock time rather than counts.
bool isTimeDomain(const DataDescriptorPtr& descriptor);
/// Whether the scope can plot a signal of these descriptors as a scalar line.
bool isChartable(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain);
/// "scalar" for one number per sample, "array" for a one-dimensional numeric
/// value per sample, such as an FFT block's spectrum, else "other".
std::string signalShape(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain);
/// The picture format of an image signal's descriptor, such as "jpeg", or
/// empty. "plot" is the Universal renderer's plot data.
std::string imageFormat(const DataDescriptorPtr& descriptor);
/// The media type of a picture format, such as "image/jpeg".
std::string imageMediaType(const std::string& format);

/// A signal's descriptor and its domain signal's, either may be unassigned.
DataDescriptorPtr descriptorOf(const SignalPtr& signal);
DataDescriptorPtr domainDescriptorOf(const SignalPtr& signal);

rj::Value descriptorJson(const DataDescriptorPtr& descriptor, Alloc& a);
/// Everything the signal list, signal table and scope picker need.
rj::Value signalInfo(const SignalPtr& signal, bool withDescriptor, Alloc& a);
/// A moment in UTC as ISO 8601 text with microseconds, such as
/// "2024-01-01T12:00:00.250000+00:00".
std::string isoTimestamp(int64_t microsSinceEpoch);

/// Drops the function block check's cached verdicts. A newly loaded module
/// can bring new function block types and change old answers.
void forgetFunctionBlockFit();

}  // namespace studio
