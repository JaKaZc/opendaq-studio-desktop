#include "signal_info.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace studio
{

namespace
{

std::string lower(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

[[noreturn]] void notFound(const std::string& message, const std::string& id)
{
    throw HttpError{404, "not_found", message, "", R"({"componentId":)" + quote(id) + "}"};
}

/// A number as the shortest text that reads back the same, such as "0.1",
/// "2.0" or "1e+16".
std::string floatRepr(double value)
{
    if (std::isnan(value))
        return "nan";
    if (std::isinf(value))
        return value > 0 ? "inf" : "-inf";
    char text[40];
    for (int precision = 0; precision < 17; precision++)
    {
        std::snprintf(text, sizeof text, "%.*e", precision, value);
        if (std::strtod(text, nullptr) == value)
            break;
    }
    // text is "-d.ddde+XX": the digits and the exponent, laid out again.
    std::string mantissa(text, std::strchr(text, 'e'));
    const int exponent = std::atoi(std::strchr(text, 'e') + 1);
    const bool negative = mantissa[0] == '-';
    std::string digits;
    for (const char c : mantissa)
        if (std::isdigit(static_cast<unsigned char>(c)))
            digits += c;
    std::string out = negative ? "-" : "";
    if (exponent < -4 || exponent >= 16)
    {
        out += digits.substr(0, 1);
        if (digits.size() > 1)
            out += "." + digits.substr(1);
        char tail[8];
        std::snprintf(tail, sizeof tail, "e%c%02d", exponent < 0 ? '-' : '+', std::abs(exponent));
        return out + tail;
    }
    if (exponent < 0)
        return out + "0." + std::string(static_cast<size_t>(-exponent - 1), '0') + digits;
    const auto point = static_cast<size_t>(exponent) + 1;
    if (digits.size() <= point)
        return out + digits + std::string(point - digits.size(), '0') + ".0";
    return out + digits.substr(0, point) + "." + digits.substr(point);
}

/// A JSON value as plain text: a string is itself, and the strings inside a
/// list or an object are quoted.
std::string valueText(const rj::Value& value, bool nested = false)
{
    if (value.IsNull())
        return "None";
    if (value.IsBool())
        return value.GetBool() ? "True" : "False";
    if (value.IsInt64())
        return std::to_string(value.GetInt64());
    if (value.IsNumber())
        return floatRepr(value.GetDouble());
    if (value.IsString())
    {
        if (!nested)
            return value.GetString();
        std::string out = "'";
        for (const char* c = value.GetString(); *c; c++)
            out += *c == '\'' || *c == '\\' ? std::string("\\") + *c : std::string(1, *c);
        return out + "'";
    }
    std::string out;
    if (value.IsArray())
    {
        for (const auto& item : value.GetArray())
            out += (out.empty() ? "" : ", ") + valueText(item, true);
        return "[" + out + "]";
    }
    for (const auto& member : value.GetObject())
        out += (out.empty() ? "" : ", ") + valueText(member.name, true) + ": " + valueText(member.value, true);
    return "{" + out + "}";
}

std::string idOf(const ComponentPtr& component)
{
    return safe<std::string>([&] { return component.getGlobalId().toStdString(); }, "");
}

rj::Value nullable(const std::string& text, Alloc& a)
{
    return text.empty() ? rj::Value() : str(text, a);
}

rj::Value parametersJson(const DictPtr<IString, IBaseObject>& parameters, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    isSafe([&] {
        for (const auto& [key, value] : parameters)
            out.AddMember(str(key.toStdString(), a), valueToJson(value, a), a);
    });
    return out;
}

rj::Value ruleJson(const char* type, const DictPtr<IString, IBaseObject>& parameters, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("type", rj::Value(type, a), a);
    out.AddMember("parameters", parametersJson(parameters, a), a);
    return out;
}

rj::Value dataRuleJson(const DataRulePtr& rule, Alloc& a)
{
    if (!rule.assigned())
        return rj::Value();
    const char* type = "Other";
    switch (safe<DataRuleType>([&] { return rule.getType(); }, DataRuleType::Other))
    {
        case DataRuleType::Linear: type = "Linear"; break;
        case DataRuleType::Constant: type = "Constant"; break;
        case DataRuleType::Explicit: type = "Explicit"; break;
        default: break;
    }
    return ruleJson(type, safe<DictPtr<IString, IBaseObject>>([&] { return rule.getParameters(); }, nullptr), a);
}

rj::Value dimensionRuleJson(const DimensionRulePtr& rule, Alloc& a)
{
    if (!rule.assigned())
        return rj::Value();
    const char* type = "Other";
    switch (safe<DimensionRuleType>([&] { return rule.getType(); }, DimensionRuleType::Other))
    {
        case DimensionRuleType::Linear: type = "Linear"; break;
        case DimensionRuleType::Logarithmic: type = "Logarithmic"; break;
        case DimensionRuleType::List: type = "List"; break;
        default: break;
    }
    return ruleJson(type, safe<DictPtr<IString, IBaseObject>>([&] { return rule.getParameters(); }, nullptr), a);
}

rj::Value rangeJson(const RangePtr& range, Alloc& a)
{
    if (!range.assigned())
        return rj::Value();
    rj::Value low = valueToJson(safe<NumberPtr>([&] { return range.getLowValue(); }, nullptr), a);
    rj::Value high = valueToJson(safe<NumberPtr>([&] { return range.getHighValue(); }, nullptr), a);
    if (low.IsNull() && high.IsNull())
        return rj::Value();
    rj::Value out(rj::kObjectType);
    out.AddMember("low", low, a);
    out.AddMember("high", high, a);
    return out;
}

rj::Value ratioJson(const RatioPtr& ratio, Alloc& a)
{
    if (!ratio.assigned())
        return rj::Value();
    const int64_t numerator = safe<int64_t>([&] { return static_cast<int64_t>(ratio.getNumerator()); }, 0);
    const int64_t denominator = safe<int64_t>([&] { return static_cast<int64_t>(ratio.getDenominator()); }, 0);
    if (denominator == 0)
        return rj::Value();
    rj::Value out(rj::kObjectType);
    out.AddMember("numerator", numerator, a);
    out.AddMember("denominator", denominator, a);
    return out;
}

rj::Value dimensionsJson(const DataDescriptorPtr& descriptor, Alloc& a)
{
    rj::Value out(rj::kArrayType);
    const auto dimensions = safe<ListPtr<IDimension>>([&] { return descriptor.getDimensions(); }, nullptr);
    if (!dimensions.assigned())
        return out;
    for (const DimensionPtr& dimension : dimensions)
    {
        rj::Value d(rj::kObjectType);
        d.AddMember("name", str(safe<std::string>([&] { return textOf(dimension.getName()); }, ""), a), a);
        isSafe([&] { d.AddMember("size", static_cast<uint64_t>(dimension.getSize()), a); });
        if (!d.HasMember("size"))
            d.AddMember("size", rj::Value(), a);
        d.AddMember("unit", unitJson(safe<UnitPtr>([&] { return dimension.getUnit(); }, nullptr), a), a);
        d.AddMember("rule", dimensionRuleJson(safe<DimensionRulePtr>([&] { return dimension.getRule(); }, nullptr), a), a);
        out.PushBack(d, a);
    }
    return out;
}

size_t dimensionCount(const DataDescriptorPtr& descriptor)
{
    return safe<size_t>([&] { return descriptor.getDimensions().assigned() ? descriptor.getDimensions().getCount() : size_t(0); }, 0);
}

size_t structFieldCount(const DataDescriptorPtr& descriptor)
{
    return safe<size_t>([&] { return descriptor.getStructFields().assigned() ? descriptor.getStructFields().getCount() : size_t(0); }, 0);
}

bool isNumericName(const std::string& name)
{
    return name.rfind("Float", 0) == 0 || name.rfind("Int", 0) == 0 || name.rfind("UInt", 0) == 0;
}

rj::Value referenceInfoJson(const ReferenceDomainInfoPtr& info, Alloc& a)
{
    if (!info.assigned())
        return rj::Value();
    rj::Value out(rj::kObjectType);
    out.AddMember("referenceDomainId", nullable(safe<std::string>([&] { return textOf(info.getReferenceDomainId()); }, ""), a), a);
    out.AddMember("referenceDomainOffset", valueToJson(safe<IntegerPtr>([&] { return info.getReferenceDomainOffset(); }, nullptr), a), a);
    const char* protocol = nullptr;
    switch (safe<TimeProtocol>([&] { return info.getReferenceTimeProtocol(); }, TimeProtocol::Unknown))
    {
        case TimeProtocol::Tai: protocol = "Tai"; break;
        case TimeProtocol::Gps: protocol = "Gps"; break;
        case TimeProtocol::Utc: protocol = "Utc"; break;
        default: break;
    }
    out.AddMember("referenceTimeSource", protocol ? rj::Value(protocol, a) : rj::Value(), a);
    const char* usesOffset = nullptr;
    isSafe([&] {
        switch (info.getUsesOffset())
        {
            case UsesOffset::True: usesOffset = "True"; break;
            case UsesOffset::False: usesOffset = "False"; break;
            default: usesOffset = "Unknown"; break;
        }
    });
    out.AddMember("usesOffset", usesOffset ? rj::Value(usesOffset, a) : rj::Value(), a);
    return out;
}

rj::Value imageSizeJson(const DataDescriptorPtr& descriptor, Alloc& a)
{
    if (imageFormat(descriptor).empty())
        return rj::Value();
    int64_t width = 0, height = 0;
    const bool known = isSafe([&] {
        const auto metadata = descriptor.getMetadata();
        const auto number = [](const std::string& text)
        {
            char* end = nullptr;
            const long long value = std::strtoll(text.c_str(), &end, 10);
            while (end && std::isspace(static_cast<unsigned char>(*end)))
                end++;
            if (text.empty() || !end || *end)
                throw std::invalid_argument(text);
            return static_cast<int64_t>(value);
        };
        width = number(textOf(metadata.get("width")));
        height = number(textOf(metadata.get("height")));
    });
    if (!known)
        return rj::Value();
    rj::Value out(rj::kObjectType);
    out.AddMember("width", width, a);
    out.AddMember("height", height, a);
    return out;
}

/// A civil date and time of microseconds since the Unix epoch, after Howard
/// Hinnant's algorithm: "YYYY-MM-DD", "HH:MM:SS" and the microseconds.
void civil(int64_t micros, std::string& date, std::string& time, int64_t& fraction)
{
    int64_t seconds = micros / 1000000;
    fraction = micros % 1000000;
    if (fraction < 0)
    {
        fraction += 1000000;
        seconds--;
    }
    int64_t days = seconds / 86400;
    int64_t rest = seconds % 86400;
    if (rest < 0)
    {
        rest += 86400;
        days--;
    }
    days += 719468;
    const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
    const int64_t doe = days - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    const int64_t day = doy - (153 * mp + 2) / 5 + 1;
    const int64_t month = mp < 10 ? mp + 3 : mp - 9;
    const int64_t year = yoe + era * 400 + (month <= 2);
    char text[32];
    std::snprintf(text, sizeof text, "%04lld-%02lld-%02lld", static_cast<long long>(year), static_cast<long long>(month),
                  static_cast<long long>(day));
    date = text;
    std::snprintf(text, sizeof text, "%02lld:%02lld:%02lld", static_cast<long long>(rest / 3600), static_cast<long long>(rest / 60 % 60),
                  static_cast<long long>(rest % 60));
    time = text;
}

/// The seconds a domain origin's zone is ahead of UTC, such as 3600 for
/// "+01:00".
int64_t zoneSeconds(const std::string& origin)
{
    const auto t = origin.find('T');
    const auto zone = t == std::string::npos ? std::string::npos : origin.find_first_of("+-", t);
    if (zone == std::string::npos)
        return 0;
    int hours = 0, minutes = 0;
    std::sscanf(origin.c_str() + zone + 1, "%d:%d", &hours, &minutes);
    return (origin[zone] == '-' ? -1 : 1) * (hours * 3600 + minutes * 60);
}

/// A domain signal's last value, ticks from its origin, as a moment in time.
bool timestampOf(const DataDescriptorPtr& descriptor, const BaseObjectPtr& raw, rj::Value& result, Alloc& a)
{
    const auto origin = safe<std::string>([&] { return textOf(descriptor.getOrigin()); }, "");
    double originEpoch = 0;
    const auto resolution = safe<RatioPtr>([&] { return descriptor.getTickResolution(); }, nullptr);
    const auto type = coreTypeOf(raw);
    if (!originSeconds(origin, originEpoch) || !resolution.assigned() || (type != ctInt && type != ctFloat))
        return false;
    const auto numerator = static_cast<int64_t>(resolution.getNumerator());
    const auto denominator = static_cast<int64_t>(resolution.getDenominator());
    if (denominator == 0)
        return false;
    const int64_t ticks = type == ctInt ? static_cast<int64_t>(raw) : static_cast<int64_t>(static_cast<double>(raw));
    // Seconds since the origin, to microseconds: the whole seconds, and the
    // fraction rounded half to even.
    const double seconds = static_cast<double>(ticks * numerator) / static_cast<double>(denominator);
    double whole = 0;
    const double fraction = std::modf(seconds, &whole);
    const int64_t offset = static_cast<int64_t>(whole) * 1000000 + static_cast<int64_t>(std::nearbyint(fraction * 1e6));
    const int64_t micros = std::llround(originEpoch * 1e6) + offset;

    std::string date, time;
    int64_t micro = 0;
    char digits[8];
    civil(micros + zoneSeconds(origin) * 1000000, date, time, micro);
    std::snprintf(digits, sizeof digits, "%06lld", static_cast<long long>(micro));
    std::string display = date + " " + time + "." + digits;
    while (display.back() == '0')
        display.pop_back();
    if (display.back() == '.')
        display.pop_back();

    result["kind"].SetString("timestamp");
    result["value"].SetInt64(ticks);
    result["timestamp"] = str(isoTimestamp(micros), a);
    result["displayValue"] = str(display, a);
    return true;
}

}  // namespace

std::string isoTimestamp(int64_t microsSinceEpoch)
{
    std::string date, time;
    int64_t fraction = 0;
    civil(microsSinceEpoch, date, time, fraction);
    char digits[8];
    std::snprintf(digits, sizeof digits, ".%06lld", static_cast<long long>(fraction));
    return date + "T" + time + (fraction ? digits : "") + "+00:00";
}

// ------------------------------------------------------------------ lookups

ComponentPtr componentOf(Engine& e, const std::string& id)
{
    return lookupComponent(e.root, id);
}

SignalPtr signalOf(Engine& e, const std::string& id)
{
    const SignalPtr signal = componentOf(e, id).asPtrOrNull<ISignal>();
    if (!signal.assigned())
        notFound("not a signal: " + id, id);
    return signal;
}

std::vector<SignalPtr> collectSignals(const ComponentPtr& component, bool includeHidden)
{
    std::vector<SignalPtr> out;
    if (const SignalPtr signal = component.asPtrOrNull<ISignal>(); signal.assigned())
    {
        out.push_back(signal);
        return out;
    }
    const SearchFilterPtr filter = includeHidden ? search::Any() : nullptr;
    isSafe([&] {
        ListPtr<ISignal> signals;
        if (const DevicePtr device = component.asPtrOrNull<IDevice>(); device.assigned())
            signals = device.getSignalsRecursive(filter);
        else if (const FunctionBlockPtr block = component.asPtrOrNull<IFunctionBlock>(); block.assigned())
            signals = block.getSignalsRecursive(filter);
        if (signals.assigned())
            for (const auto& signal : signals)
                out.push_back(signal);
    });
    return out;
}

// ------------------------------------------------------------------ descriptor maths

DataDescriptorPtr descriptorOf(const SignalPtr& signal)
{
    return safe<DataDescriptorPtr>([&] { return signal.getDescriptor(); }, nullptr);
}

DataDescriptorPtr domainDescriptorOf(const SignalPtr& signal)
{
    const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
    return domain.assigned() ? descriptorOf(domain) : nullptr;
}

std::string sampleTypeText(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return "";
    return safe<std::string>([&] { return sampleTypeName(descriptor.getSampleType()); }, "");
}

double domainSampleRate(const DataDescriptorPtr& domain)
{
    if (!domain.assigned())
        return 0;
    return safe<double>(
        [&] {
            const auto resolution = domain.getTickResolution();
            const auto rule = domain.getRule();
            if (!resolution.assigned() || !rule.assigned())
                return 0.0;
            const auto numerator = static_cast<int64_t>(resolution.getNumerator());
            const auto denominator = static_cast<int64_t>(resolution.getDenominator());
            const auto parameters = rule.getParameters();
            if (!numerator || !denominator || !parameters.assigned() || !parameters.hasKey("delta"))
                return 0.0;
            const auto delta = parameters.get("delta");
            if (!delta.assigned() || static_cast<double>(delta) == 0)
                return 0.0;
            const double period = static_cast<double>(delta) * static_cast<double>(numerator) / static_cast<double>(denominator);
            return period > 0 ? 1.0 / period : 0.0;
        },
        0.0);
}

bool isTimeDomain(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return false;
    return safe<bool>(
        [&] {
            const auto unit = descriptor.getUnit();
            if (!descriptor.getTickResolution().assigned() || !unit.assigned())
                return false;
            return lower(textOf(unit.getQuantity())) == "time" && lower(textOf(unit.getSymbol())) == "s" &&
                   !textOf(descriptor.getOrigin()).empty();
        },
        false);
}

bool isChartable(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain)
{
    if (!descriptor.assigned() || !domain.assigned())
        return false;
    return isNumericName(sampleTypeText(descriptor)) && dimensionCount(descriptor) == 0 && structFieldCount(descriptor) == 0;
}

std::string signalShape(const DataDescriptorPtr& descriptor, const DataDescriptorPtr& domain)
{
    if (!descriptor.assigned() || !domain.assigned() || !isNumericName(sampleTypeText(descriptor)) || structFieldCount(descriptor))
        return "other";
    const size_t dimensions = dimensionCount(descriptor);
    return dimensions == 0 ? "scalar" : dimensions == 1 ? "array" : "other";
}

std::string imageFormat(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return "";
    return safe<std::string>(
        [&] {
            if (descriptor.getSampleType() != SampleType::Binary)
                return std::string();
            const auto unit = descriptor.getUnit();
            const std::string symbol = unit.assigned() ? lower(textOf(unit.getSymbol())) : "";
            return imageMediaType(symbol).empty() ? std::string() : symbol;
        },
        "");
}

std::string imageMediaType(const std::string& format)
{
    if (format == "jpeg" || format == "jpg")
        return "image/jpeg";
    if (format == "png")
        return "image/png";
    if (format == "bmp")
        return "image/bmp";
    if (format == "plot")
        return "application/x-opendaq-plot";
    return "";
}

// ------------------------------------------------------------------ JSON

rj::Value descriptorJson(const DataDescriptorPtr& descriptor, Alloc& a)
{
    if (!descriptor.assigned())
        return rj::Value();
    rj::Value out(rj::kObjectType);
    out.AddMember("name", str(safe<std::string>([&] { return textOf(descriptor.getName()); }, ""), a), a);
    out.AddMember("sampleType", nullable(sampleTypeText(descriptor), a), a);
    out.AddMember("unit", unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a), a);
    out.AddMember("valueRange", rangeJson(safe<RangePtr>([&] { return descriptor.getValueRange(); }, nullptr), a), a);
    out.AddMember("rule", dataRuleJson(safe<DataRulePtr>([&] { return descriptor.getRule(); }, nullptr), a), a);
    out.AddMember("origin", str(safe<std::string>([&] { return textOf(descriptor.getOrigin()); }, ""), a), a);
    out.AddMember("tickResolution", ratioJson(safe<RatioPtr>([&] { return descriptor.getTickResolution(); }, nullptr), a), a);
    out.AddMember("dimensions", dimensionsJson(descriptor, a), a);
    rj::Value fieldNames(rj::kArrayType);
    isSafe([&] {
        const auto fields = descriptor.getStructFields();
        if (fields.assigned())
            for (const DataDescriptorPtr& field : fields)
                fieldNames.PushBack(str(safe<std::string>([&] { return textOf(field.getName()); }, ""), a), a);
    });
    out.AddMember("structFieldCount", fieldNames.Size(), a);
    out.AddMember("structFieldNames", fieldNames, a);
    rj::Value metadata(rj::kObjectType);
    isSafe([&] {
        const auto entries = descriptor.getMetadata();
        if (entries.assigned())
            for (const auto& [key, value] : entries)
                metadata.AddMember(str(key.toStdString(), a), valueToJson(value, a), a);
    });
    out.AddMember("metadata", metadata, a);
    const auto scaling = safe<ScalingPtr>([&] { return descriptor.getPostScaling(); }, nullptr);
    out.AddMember("postScaling", scaling.assigned() ? str(textOf(scaling), a) : rj::Value(), a);
    out.AddMember("referenceDomainInfo",
                  referenceInfoJson(safe<ReferenceDomainInfoPtr>([&] { return descriptor.getReferenceDomainInfo(); }, nullptr), a), a);
    return out;
}

rj::Value signalInfo(const SignalPtr& signal, bool withDescriptor, Alloc& a)
{
    const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
    const auto descriptor = descriptorOf(signal);
    const auto domainDescriptor = domain.assigned() ? descriptorOf(domain) : nullptr;
    const auto parent = safe<ComponentPtr>([&] { return signal.getParent(); }, nullptr);
    const auto device = safe<ComponentPtr>([&] { return owningDevice(signal); }, nullptr);
    const auto flag = [&](auto getter, bool fallback) { return safe<bool>([&] { return static_cast<bool>(getter()); }, fallback); };

    rj::Value info(rj::kObjectType);
    info.AddMember("id", str(idOf(signal), a), a);
    info.AddMember("localId", str(safe<std::string>([&] { return signal.getLocalId().toStdString(); }, ""), a), a);
    info.AddMember("name", str(safe<std::string>([&] { return signal.getName().toStdString(); }, ""), a), a);
    info.AddMember("description", str(safe<std::string>([&] { return textOf(signal.getDescription()); }, ""), a), a);
    info.AddMember("parentId", parent.assigned() ? str(idOf(parent), a) : rj::Value(), a);
    info.AddMember("deviceId", device.assigned() ? str(idOf(device), a) : rj::Value(), a);
    info.AddMember("active", flag([&] { return signal.getActive(); }, true), a);
    info.AddMember("public", flag([&] { return signal.getPublic(); }, true), a);
    info.AddMember("visible", flag([&] { return signal.getVisible(); }, true), a);
    info.AddMember("streamed", flag([&] { return signal.getStreamed(); }, false), a);
    info.AddMember("domainSignalId", domain.assigned() ? str(idOf(domain), a) : rj::Value(), a);
    info.AddMember("domainSignalName",
                   domain.assigned() ? str(safe<std::string>([&] { return domain.getName().toStdString(); }, ""), a) : rj::Value(), a);
    info.AddMember("unit", descriptor.assigned() ? unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a) : rj::Value(),
                   a);
    info.AddMember("sampleType", nullable(sampleTypeText(descriptor), a), a);
    const double rate = domainSampleRate(domainDescriptor);
    info.AddMember("sampleRate", rate > 0 ? rj::Value(rate) : rj::Value(), a);
    info.AddMember("chartable", isChartable(descriptor, domainDescriptor), a);
    info.AddMember("shape", str(signalShape(descriptor, domainDescriptor), a), a);
    info.AddMember("image", nullable(imageFormat(descriptor), a), a);
    info.AddMember("imageSize", imageSizeJson(descriptor, a), a);
    info.AddMember("timeDomain", isTimeDomain(domainDescriptor), a);
    rj::Value related(rj::kArrayType);
    isSafe([&] {
        for (const auto& other : signal.getRelatedSignals())
            related.PushBack(str(idOf(other), a), a);
    });
    info.AddMember("relatedSignalIds", related, a);
    if (withDescriptor)
    {
        info.AddMember("descriptor", descriptorJson(descriptor, a), a);
        info.AddMember("domainDescriptor", descriptorJson(domainDescriptor, a), a);
    }
    return info;
}

}  // namespace studio
