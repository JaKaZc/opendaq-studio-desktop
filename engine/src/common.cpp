#include "common.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace studio
{

const char* const kTag = "openDAQStudio";

// ------------------------------------------------------------------ errors

[[noreturn]] void fail(int status, const std::string& code, const std::string& message, const std::string& detail)
{
    throw HttpError{status, code, message, detail, ""};
}

HttpError sdkError(const std::string& action, const std::exception& error)
{
    std::string text = error.what();
    if (text.empty())
        text = "Unknown error";
    std::string lowered = text;
    std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (lowered.find("not found") != std::string::npos || lowered.find("does not exist") != std::string::npos)
        return HttpError{404, "not_found", action + " failed", text, ""};
    if (lowered.find("locked") != std::string::npos || lowered.find("read-only") != std::string::npos ||
        lowered.find("read only") != std::string::npos)
        return HttpError{409, "conflict", action + " failed", text, ""};
    if (dynamic_cast<const std::invalid_argument*>(&error))
        return HttpError{400, "bad_request", action + " failed", text, ""};
    return HttpError{502, "sdk_error", action + " failed", text, ""};
}

[[noreturn]] void failSdk(const std::string& action, const std::exception& error)
{
    throw sdkError(action, error);
}

// ------------------------------------------------------------------ JSON helpers

rj::Value str(const std::string& text, Alloc& a)
{
    rj::Value v;
    v.SetString(text.c_str(), static_cast<rj::SizeType>(text.size()), a);
    return v;
}

namespace
{

/// Writes NaN and infinity, which JSON cannot hold, as null. rapidjson's own
/// writer stops at such a number and leaves the answer cut short.
class JsonWriter : public rj::Writer<rj::StringBuffer>
{
public:
    using rj::Writer<rj::StringBuffer>::Writer;

    bool Double(double value) { return std::isfinite(value) ? rj::Writer<rj::StringBuffer>::Double(value) : Null(); }
};

}  // namespace

std::string toText(const rj::Value& value)
{
    rj::StringBuffer buffer;
    JsonWriter writer(buffer);
    value.Accept(writer);
    return buffer.GetString();
}

/// Any openDAQ object's text, as its toString gives it.
std::string textOf(const BaseObjectPtr& object)
{
    if (!object.assigned())
        return "";
    return StringPtr(object.toString()).toStdString();
}

std::string formatNumber(double value)
{
    if (!std::isfinite(value))
        return "n/a";
    char text[64];
    std::snprintf(text, sizeof text, "%.6g", value);
    return text;
}

bool isSafe(const std::function<void()>& action)
{
    try
    {
        action();
        return true;
    }
    catch (...)
    {
        return false;
    }
}

rj::Value ok(Alloc& a)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("ok", true, a);
    return out;
}

// ------------------------------------------------------------------ requests

std::string queryString(const rj::Value& query, const char* name)
{
    if (query.IsObject() && query.HasMember(name))
    {
        const auto& v = query[name];
        if (v.IsString())
            return v.GetString();
        if (v.IsArray() && !v.Empty() && v[0].IsString())
            return v[0].GetString();
    }
    return "";
}

std::vector<std::string> queryList(const rj::Value& query, const char* name)
{
    std::vector<std::string> out;
    if (!query.IsObject() || !query.HasMember(name))
        return out;
    const auto& v = query[name];
    if (v.IsString())
        out.emplace_back(v.GetString());
    else if (v.IsArray())
        for (const auto& item : v.GetArray())
            if (item.IsString())
                out.emplace_back(item.GetString());
    return out;
}

const rj::Value& member(const rj::Value& body, const char* name)
{
    static const rj::Value noQuery(rj::kObjectType);
    Check check(noQuery, body);
    check.object();
    const auto* found = check.any(name);
    check.done();
    return *found;
}

Check::Check(const rj::Value& query, const rj::Value& body)
    : queryValues(query)
    , body(body)
    , errors(rj::kArrayType)
{
}

void Check::add(const char* type, std::initializer_list<const char*> loc, const char* message, const rj::Value* input,
                rj::Value context, int index)
{
    auto& a = errors.GetAllocator();
    rj::Value error(rj::kObjectType);
    error.AddMember("type", rj::StringRef(type), a);
    rj::Value where(rj::kArrayType);
    for (const char* part : loc)
        where.PushBack(str(part, a), a);
    if (index >= 0)
        where.PushBack(index, a);
    error.AddMember("loc", where, a);
    error.AddMember("msg", rj::StringRef(message), a);
    error.AddMember("input", input ? rj::Value(*input, a) : rj::Value(), a);
    if (!context.IsNull())
        error.AddMember("ctx", rj::Value(context, a), a);
    errors.PushBack(error, a);
}

std::string Check::query(const char* name)
{
    if (!queryValues.IsObject() || !queryValues.HasMember(name))
    {
        add("missing", {"query", name}, "Field required", nullptr);
        return "";
    }
    const auto& v = queryValues[name];
    if (v.IsArray())
        return v.Empty() ? "" : v[v.Size() - 1].GetString();
    return v.GetString();
}

bool Check::queryFlag(const char* name, bool fallback)
{
    if (!queryValues.IsObject() || !queryValues.HasMember(name))
        return fallback;
    const auto& values = queryValues[name];
    const auto& v = values.IsArray() ? values[values.Size() - 1] : values;
    bool out = fallback;
    if (!parseBool(v, out))
        add("bool_parsing", {"query", name}, "Input should be a valid boolean, unable to interpret input", &v);
    return out;
}

void Check::object()
{
    if (body.IsNull())
        add("missing", {"body"}, "Field required", nullptr);
    else if (!body.IsObject())
        add("model_attributes_type", {"body"}, "Input should be a valid dictionary or object to extract fields from", &body);
    else
        bodyUsable = true;
}

void Check::fields(std::initializer_list<const char*> names)
{
    object();
    if (!bodyUsable)
        return;
    for (const auto& m : body.GetObject())
    {
        const std::string name = m.name.GetString();
        if (std::none_of(names.begin(), names.end(), [&](const char* allowed) { return name == allowed; }))
            extra.push_back(name);
    }
}

const rj::Value* Check::any(const char* name)
{
    if (!bodyUsable)
        return nullptr;
    if (!body.HasMember(name))
    {
        add("missing", {"body", name}, "Field required", &body);
        return nullptr;
    }
    return &body[name];
}

std::vector<std::string> Check::path(const char* name)
{
    std::vector<std::string> out;
    const auto* v = any(name);
    if (!v)
        return out;
    if (!v->IsArray())
    {
        add("list_type", {"body", name}, "Input should be a valid list", v);
        return out;
    }
    bool valid = true;
    int index = 0;
    for (const auto& item : v->GetArray())
    {
        if (item.IsString())
            out.emplace_back(item.GetString());
        else
        {
            add("string_type", {"body", name}, "Input should be a valid string", &item, rj::Value(), index);
            valid = false;
        }
        index++;
    }
    if (valid && out.empty())
    {
        auto& a = errors.GetAllocator();
        rj::Value context(rj::kObjectType);
        context.AddMember("field_type", "List", a);
        context.AddMember("min_length", 1, a);
        context.AddMember("actual_length", 0, a);
        add("too_short", {"body", name}, "List should have at least 1 item after validation, not 0", v, std::move(context));
    }
    return out;
}

std::string Check::text(const char* name)
{
    const auto* v = any(name);
    if (!v)
        return "";
    if (!v->IsString())
    {
        add("string_type", {"body", name}, "Input should be a valid string", v);
        return "";
    }
    if (v->GetStringLength() == 0)
    {
        auto& a = errors.GetAllocator();
        rj::Value context(rj::kObjectType);
        context.AddMember("min_length", 1, a);
        add("string_too_short", {"body", name}, "String should have at least 1 character", v, std::move(context));
    }
    return v->GetString();
}

bool Check::flag(const char* name)
{
    const auto* v = any(name);
    bool out = false;
    if (!v)
        return out;
    if (v->IsNull() || v->IsArray() || v->IsObject())
        add("bool_type", {"body", name}, "Input should be a valid boolean", v);
    else if (!parseBool(*v, out))
        add("bool_parsing", {"body", name}, "Input should be a valid boolean, unable to interpret input", v);
    return out;
}

const rj::Value* Check::list(const char* name)
{
    if (!bodyUsable || !body.HasMember(name))
        return nullptr;
    const auto& v = body[name];
    if (!v.IsArray())
    {
        add("list_type", {"body", name}, "Input should be a valid list", &v);
        return nullptr;
    }
    return &v;
}

/// Pydantic's lax booleans: true and false, 0 and 1, and the words for them.
bool Check::parseBool(const rj::Value& value, bool& out) const
{
    if (value.IsBool())
    {
        out = value.GetBool();
        return true;
    }
    if (value.IsNumber())
    {
        const double d = value.GetDouble();
        if (d != 0 && d != 1)
            return false;
        out = d == 1;
        return true;
    }
    if (!value.IsString())
        return false;
    std::string text = value.GetString();
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const char* word : {"1", "on", "t", "true", "y", "yes"})
        if (text == word)
            return out = true, true;
    for (const char* word : {"0", "off", "f", "false", "n", "no"})
        if (text == word)
            return out = false, true;
    return false;
}

void Check::done()
{
    for (const auto& name : extra)
        add("extra_forbidden", {"body", name.c_str()}, "Extra inputs are not permitted", &body[name.c_str()]);
    if (errors.Empty())
        return;
    rj::Document out(rj::kObjectType);
    out.AddMember("detail", rj::Value(errors, out.GetAllocator()), out.GetAllocator());
    throw HttpError{422, "invalid_request", errors[0]["msg"].GetString(), "", toText(out)};
}

// ------------------------------------------------------------------ value texts

std::string floatRepr(double value)
{
    if (std::isnan(value))
        return "nan";
    if (std::isinf(value))
        return value < 0 ? "-inf" : "inf";
    // The fewest significant digits that read back as the same number.
    char text[40];
    int digitsWanted = 1;
    for (; digitsWanted < 17; digitsWanted++)
    {
        std::snprintf(text, sizeof text, "%.*e", digitsWanted - 1, value);
        if (std::strtod(text, nullptr) == value)
            break;
    }
    std::snprintf(text, sizeof text, "%.*e", digitsWanted - 1, value);
    std::string scientific = text;
    const bool negative = scientific[0] == '-';
    if (negative)
        scientific.erase(0, 1);
    const auto e = scientific.find('e');
    const int exponent = std::atoi(scientific.c_str() + e + 1);
    std::string digits;
    for (size_t i = 0; i < e; i++)
        if (scientific[i] != '.')
            digits += scientific[i];
    std::string out;
    if (exponent < -4 || exponent >= 16)
    {
        out = digits.substr(0, 1) + (digits.size() > 1 ? "." + digits.substr(1) : "");
        char tail[8];
        std::snprintf(tail, sizeof tail, "e%c%02d", exponent < 0 ? '-' : '+', std::abs(exponent));
        out += tail;
    }
    else if (exponent < 0)
        out = "0." + std::string(static_cast<size_t>(-exponent - 1), '0') + digits;
    else if (digits.size() <= static_cast<size_t>(exponent) + 1)
        out = digits + std::string(static_cast<size_t>(exponent) + 1 - digits.size(), '0') + ".0";
    else
        out = digits.substr(0, static_cast<size_t>(exponent) + 1) + "." + digits.substr(static_cast<size_t>(exponent) + 1);
    return (negative ? "-" : "") + out;
}

std::string reprText(const std::string& text)
{
    const bool single = text.find('\'') != std::string::npos;
    const bool twin = text.find('"') != std::string::npos;
    const char quote = single && !twin ? '"' : '\'';
    std::string out(1, quote);
    for (const unsigned char c : text)
    {
        if (c == '\\')
            out += "\\\\";
        else if (c == quote)
            out += std::string("\\") + quote;
        else if (c == '\n')
            out += "\\n";
        else if (c == '\r')
            out += "\\r";
        else if (c == '\t')
            out += "\\t";
        else if (c < 0x20 || c == 0x7f)
        {
            char escaped[8];
            std::snprintf(escaped, sizeof escaped, "\\x%02x", c);
            out += escaped;
        }
        else
            out += static_cast<char>(c);
    }
    return out + quote;
}

std::string reprText(const rj::Value& value)
{
    if (value.IsNull())
        return "None";
    if (value.IsBool())
        return value.GetBool() ? "True" : "False";
    if (value.IsInt64())
        return std::to_string(value.GetInt64());
    if (value.IsUint64())
        return std::to_string(value.GetUint64());
    if (value.IsNumber())
        return floatRepr(value.GetDouble());
    if (value.IsString())
        return reprText(std::string(value.GetString(), value.GetStringLength()));
    std::string out;
    if (value.IsArray())
    {
        for (const auto& item : value.GetArray())
            out += (out.empty() ? "" : ", ") + reprText(item);
        return "[" + out + "]";
    }
    for (const auto& m : value.GetObject())
        out += (out.empty() ? "" : ", ") + reprText(std::string(m.name.GetString())) + ": " + reprText(m.value);
    return "{" + out + "}";
}

std::string plainText(const rj::Value& value)
{
    return value.IsString() ? std::string(value.GetString(), value.GetStringLength()) : reprText(value);
}

bool truthy(const rj::Value& value)
{
    if (value.IsBool())
        return value.GetBool();
    if (value.IsNumber())
        return value.GetDouble() != 0;
    if (value.IsString())
        return value.GetStringLength() > 0;
    if (value.IsArray())
        return !value.Empty();
    if (value.IsObject())
        return value.MemberCount() > 0;
    return false;
}

// ------------------------------------------------------------------ values

const char* coreTypeName(CoreType type)
{
    switch (type)
    {
        case ctBool: return "bool";
        case ctInt: return "int";
        case ctFloat: return "float";
        case ctString: return "string";
        case ctList: return "list";
        case ctDict: return "dict";
        case ctRatio: return "ratio";
        case ctProc: return "proc";
        case ctObject: return "object";
        case ctBinaryData: return "binary";
        case ctFunc: return "func";
        case ctComplexNumber: return "complex";
        case ctStruct: return "struct";
        case ctEnumeration: return "enumeration";
        default: return "undefined";
    }
}

CoreType coreTypeOf(const BaseObjectPtr& value)
{
    if (!value.assigned())
        return ctUndefined;
    return safe<CoreType>([&] { return value.getCoreType(); }, ctUndefined);
}

rj::Value valueToJson(const BaseObjectPtr& value, Alloc& a, int depth)
{
    rj::Value out;
    if (!value.assigned())
        return out;
    const auto type = coreTypeOf(value);
    switch (type)
    {
        case ctBool:
            out.SetBool(static_cast<bool>(value));
            return out;
        case ctInt:
            out.SetInt64(static_cast<int64_t>(value));
            return out;
        case ctFloat:
        {
            // JSON has no NaN or infinity; the UI shows null as "n/a".
            const double d = static_cast<double>(value);
            if (std::isfinite(d))
                out.SetDouble(d);
            return out;
        }
        case ctString:
            return str(static_cast<std::string>(value.asPtr<IString>()), a);
        default:
            break;
    }
    out.SetObject();
    if (depth >= 12)
    {
        out.AddMember("kind", "truncated", a);
        out.AddMember("text", str(safe<std::string>([&] { return textOf(value); }, ""), a), a);
        return out;
    }
    switch (type)
    {
        case ctEnumeration:
        {
            const EnumerationPtr enumeration = value.asPtr<IEnumeration>();
            const auto enumType = safe<EnumerationTypePtr>([&] { return enumeration.getEnumerationType(); }, nullptr);
            out.AddMember("kind", "enumeration", a);
            out.AddMember("name", str(safe<std::string>([&] { return enumeration.getValue().toStdString(); }, ""), a), a);
            rj::Value number;
            isSafe([&] { number.SetInt64(enumeration.getIntValue()); });
            out.AddMember("value", number, a);
            out.AddMember("typeName", enumType.assigned() ? str(textOf(enumType.getName()), a) : rj::Value(), a);
            rj::Value names(rj::kArrayType);
            isSafe([&] {
                for (const auto& name : enumType.getEnumeratorNames())
                    names.PushBack(str(name.toStdString(), a), a);
            });
            out.AddMember("enumerators", names, a);
            return out;
        }
        case ctRatio:
        {
            const RatioPtr ratio = value.asPtr<IRatio>();
            const int64_t numerator = safe<int64_t>([&] { return ratio.getNumerator(); }, 0);
            int64_t denominator = safe<int64_t>([&] { return ratio.getDenominator(); }, 1);
            if (denominator == 0)
                denominator = 1;
            out.AddMember("kind", "ratio", a);
            out.AddMember("numerator", numerator, a);
            out.AddMember("denominator", denominator, a);
            out.AddMember("value", static_cast<double>(numerator) / static_cast<double>(denominator), a);
            return out;
        }
        case ctComplexNumber:
        {
            const ComplexNumberPtr number = value.asPtr<IComplexNumber>();
            out.AddMember("kind", "complex", a);
            out.AddMember("real", static_cast<double>(number.getReal()), a);
            out.AddMember("imaginary", static_cast<double>(number.getImaginary()), a);
            return out;
        }
        case ctStruct:
        {
            const StructPtr structure = value.asPtr<IStruct>();
            const auto structType = safe<StructTypePtr>([&] { return structure.getStructType(); }, nullptr);
            out.AddMember("kind", "struct", a);
            out.AddMember("typeName", structType.assigned() ? str(textOf(structType.getName()), a) : rj::Value(), a);
            rj::Value names(rj::kArrayType);
            isSafe([&] {
                for (const auto& name : structType.getFieldNames())
                    names.PushBack(str(name.toStdString(), a), a);
            });
            out.AddMember("fieldNames", names, a);
            rj::Value fields(rj::kObjectType);
            isSafe([&] {
                for (const auto& [name, field] : structure.getAsDictionary())
                    fields.AddMember(str(name.toStdString(), a), valueToJson(field, a, depth + 1), a);
            });
            out.AddMember("fields", fields, a);
            return out;
        }
        case ctList:
            out.SetArray();
            isSafe([&] {
                for (const auto& item : value.asPtr<IList>())
                    out.PushBack(valueToJson(item, a, depth + 1), a);
            });
            return out;
        case ctDict:
        {
            const DictPtr<IBaseObject, IBaseObject> dict = value.asPtr<IDict>();
            isSafe([&] {
                for (const auto& [key, item] : dict)
                {
                    rj::Value name = valueToJson(key, a, depth + 1);
                    out.AddMember(str(plainText(name), a), valueToJson(item, a, depth + 1), a);
                }
            });
            return out;
        }
        case ctObject:
            if (const auto object = value.asPtrOrNull<IPropertyObject>(); object.assigned())
            {
                out.AddMember("kind", "object", a);
                const auto className = safe<StringPtr>([&] { return object.getClassName(); }, nullptr);
                out.AddMember("className", className.assigned() ? str(className.toStdString(), a) : rj::Value(), a);
                return out;
            }
            break;
        case ctFunc:
        case ctProc:
            out.AddMember("kind", "callable", a);
            return out;
        default:
            break;
    }
    return str(safe<std::string>([&] { return textOf(value); }, ""), a);
}

namespace
{

/// The number in a text, which the UI may send with its unit ("50 Hz").
double floatOfText(const std::string& raw)
{
    const auto first = raw.find_first_not_of(" \t\n\r\f\v");
    const auto last = raw.find_last_not_of(" \t\n\r\f\v");
    const std::string stripped = first == std::string::npos ? "" : raw.substr(first, last - first + 1);
    const std::string token = stripped.substr(0, stripped.find(' '));
    char* end = nullptr;
    const double d = std::strtod(token.c_str(), &end);
    const bool hex = token.find_first_of("xX") != std::string::npos && token.find_first_of("nN") == std::string::npos;
    if (token.empty() || hex || end != token.c_str() + token.size())
        throw std::invalid_argument("could not convert string to float: " + reprText(token));
    return d;
}

bool coerceBool(const rj::Value& v)
{
    if (v.IsBool())
        return v.GetBool();
    if (v.IsNumber())
        return v.GetDouble() != 0;
    if (v.IsString())
    {
        std::string text = v.GetString();
        const auto first = text.find_first_not_of(" \t\n\r\f\v");
        const auto last = text.find_last_not_of(" \t\n\r\f\v");
        text = first == std::string::npos ? "" : text.substr(first, last - first + 1);
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        for (const char* word : {"1", "true", "yes", "y", "on"})
            if (text == word)
                return true;
        for (const char* word : {"0", "false", "no", "n", "off", "", "none"})
            if (text == word)
                return false;
    }
    throw std::invalid_argument("expected a boolean, got " + reprText(v));
}

/// The integer part of a float. NaN and infinity have none.
int64_t integerOf(double d)
{
    if (std::isnan(d))
        throw std::invalid_argument("cannot convert float NaN to integer");
    if (std::isinf(d))
        throw std::overflow_error("cannot convert float infinity to integer");
    return static_cast<int64_t>(std::trunc(d));
}

int64_t coerceInt(const rj::Value& v)
{
    if (v.IsBool())
        return v.GetBool() ? 1 : 0;
    if (v.IsInt64())
        return v.GetInt64();
    if (v.IsNumber())
    {
        const double d = v.GetDouble();
        if (d != std::trunc(d))
            throw std::invalid_argument("expected an integer, got " + reprText(v));
        return integerOf(d);
    }
    if (v.IsString())
        return integerOf(floatOfText(v.GetString()));
    throw std::invalid_argument("expected an integer, got " + reprText(v));
}

double coerceFloat(const rj::Value& v)
{
    if (v.IsBool())
        return v.GetBool() ? 1 : 0;
    if (v.IsNumber())
        return v.GetDouble();
    if (v.IsString())
        return floatOfText(v.GetString());
    throw std::invalid_argument("expected a number, got " + reprText(v));
}

/// The integer and the number of any JSON value, for ratios and complex numbers.
int64_t intOf(const rj::Value& v)
{
    if (v.IsString())
    {
        const std::string text = v.GetString();
        char* end = nullptr;
        const long long n = std::strtoll(text.c_str(), &end, 10);
        if (text.empty() || end != text.c_str() + text.size())
            throw std::invalid_argument("invalid literal for int() with base 10: " + reprText(text));
        return n;
    }
    if (v.IsNull() || v.IsArray() || v.IsObject())
        throw std::invalid_argument("int() argument must be a string, a bytes-like object or a real number");
    return v.IsNumber() && !v.IsInt64() ? integerOf(v.GetDouble()) : coerceInt(v);
}

double floatOf(const rj::Value& v)
{
    if (v.IsNull() || v.IsArray() || v.IsObject())
        throw std::invalid_argument("float() argument must be a string or a real number");
    return coerceFloat(v);
}

const rj::Value& memberOr(const rj::Value& object, const char* name, const rj::Value& fallback)
{
    return object.HasMember(name) ? object[name] : fallback;
}

/// "eval:" makes a string an openDAQ EvalValue, as in the SDK demo.
BaseObjectPtr stringOrEval(const rj::Value& v)
{
    const std::string text = plainText(v);
    if (text.rfind("eval:", 0) == 0)
    {
        const std::string expression = text.substr(5);
        const auto first = expression.find_first_not_of(" \t\n\r\f\v");
        const auto last = expression.find_last_not_of(" \t\n\r\f\v");
        return EvalValue(first == std::string::npos ? "" : expression.substr(first, last - first + 1));
    }
    return String(text);
}

BaseObjectPtr scalarFromJson(const rj::Value& v, const std::string& hint)
{
    if (hint == "bool")
        return Boolean(coerceBool(v));
    if (hint == "int")
        return Integer(coerceInt(v));
    if (hint == "float")
        return Floating(coerceFloat(v));
    if (hint == "string")
        return stringOrEval(v);
    if (v.IsNull())
        return nullptr;
    if (v.IsBool())
        return Boolean(v.GetBool());
    if (v.IsInt64())
        return Integer(v.GetInt64());
    if (v.IsNumber())
        return Floating(v.GetDouble());
    return stringOrEval(v);
}

BaseObjectPtr structFromJson(const rj::Value& payload, const TypeManagerPtr& types)
{
    static const rj::Value none;
    static const rj::Value emptyObject(rj::kObjectType);
    const auto& typeName = memberOr(payload, "typeName", none);
    const auto& given = memberOr(payload, "fields", none);
    const auto& fields = truthy(given) ? given : emptyObject;
    if (!fields.IsObject())
        throw std::invalid_argument("struct fields must be an object");

    // Range, Unit and ComplexNumber are built into the SDK and are made with
    // their own factories; a generic struct of those names is refused.
    const std::string name = typeName.IsString() ? typeName.GetString() : "";
    if (name == "Range")
        return Range(Floating(coerceFloat(memberOr(fields, "LowValue", none))),
                     Floating(coerceFloat(memberOr(fields, "HighValue", none))));
    if (name == "Unit")
    {
        rj::Value noId(-1);
        static const rj::Value noText("");
        return Unit(plainText(memberOr(fields, "Symbol", noText)), coerceInt(memberOr(fields, "Id", noId)),
                    plainText(memberOr(fields, "Name", noText)), plainText(memberOr(fields, "Quantity", noText)));
    }
    if (name == "ComplexNumber")
    {
        static const rj::Value zero(0);
        return ComplexNumber(coerceFloat(memberOr(fields, "Real", zero)), coerceFloat(memberOr(fields, "Imaginary", zero)));
    }
    if (!truthy(typeName))
        throw std::invalid_argument("struct payload is missing typeName");

    auto values = Dict<IString, IBaseObject>();
    for (const auto& field : fields.GetObject())
        values.set(String(field.name.GetString()), fromJson(field.value, "", types));
    return Struct(String(plainText(typeName)), values, types);
}

}  // namespace

BaseObjectPtr fromJson(const rj::Value& v, const std::string& hint, const TypeManagerPtr& types)
{
    if (hint == "func" || hint == "proc")
        throw std::invalid_argument("callable properties are invoked, not assigned");

    if (v.IsObject())
    {
        static const rj::Value none;
        const auto& kind = memberOr(v, "kind", none);
        if (kind.IsNull())
        {
            auto dict = Dict<IBaseObject, IBaseObject>();
            for (const auto& item : v.GetObject())
                dict.set(scalarFromJson(item.name, ""), fromJson(item.value, "", types));
            return dict;
        }
        const std::string name = kind.IsString() ? kind.GetString() : "";
        if (name == "struct")
            return structFromJson(v, types);
        if (name == "ratio")
        {
            static const rj::Value zero(0), one(1);
            return Ratio(intOf(memberOr(v, "numerator", zero)), intOf(memberOr(v, "denominator", one)));
        }
        if (name == "complex")
        {
            static const rj::Value zero(0.0);
            return ComplexNumber(floatOf(memberOr(v, "real", zero)), floatOf(memberOr(v, "imaginary", zero)));
        }
        if (name == "enumeration")
        {
            const auto& typeName = memberOr(v, "typeName", none);
            const auto& value = memberOr(v, "name", none);
            if (!truthy(typeName) || value.IsNull())
                throw std::invalid_argument("enumeration payload needs typeName and name");
            return Enumeration(String(plainText(typeName)), String(plainText(value)), types);
        }
        throw std::invalid_argument("cannot assign a value of kind " + reprText(kind));
    }

    if (v.IsArray())
    {
        auto list = List<IBaseObject>();
        for (const auto& item : v.GetArray())
            list.pushBack(fromJson(item, "", types));
        return list;
    }

    return scalarFromJson(v, hint);
}

rj::Value unitJson(const UnitPtr& unit, Alloc& a)
{
    rj::Value out;
    if (!unit.assigned())
        return out;
    const std::string symbol = safe<std::string>([&] { return textOf(unit.getSymbol()); }, "");
    const std::string name = safe<std::string>([&] { return textOf(unit.getName()); }, "");
    const std::string quantity = safe<std::string>([&] { return textOf(unit.getQuantity()); }, "");
    if (symbol.empty() && name.empty() && quantity.empty())
        return out;
    out.SetObject();
    rj::Value id;
    isSafe([&] { id.SetInt64(unit.getId()); });
    out.AddMember("id", id, a);
    out.AddMember("symbol", str(symbol, a), a);
    out.AddMember("name", str(name, a), a);
    out.AddMember("quantity", str(quantity, a), a);
    return out;
}

// ------------------------------------------------------------------ components

ComponentPtr lookupComponent(const DevicePtr& root, const std::string& id)
{
    if (id.empty())
        fail(404, "not_found", "component id is required");
    if (id == "/" || id == root.getGlobalId().toStdString())
        return root;
    // "/openDAQDevice/Dev/RefDev0" is "Dev/RefDev0" from the root: the part
    // before the second slash names the root, whatever it says.
    std::string relative;
    size_t start = 0;
    for (int part = 0; start != std::string::npos; part++)
    {
        const auto end = id.find('/', start);
        if (part >= 2)
            relative += (part > 2 ? "/" : "") + id.substr(start, end == std::string::npos ? std::string::npos : end - start);
        start = end == std::string::npos ? end : end + 1;
    }
    ComponentPtr found;
    if (!isSafe([&] { found = root.findComponent(relative); }) || !found.assigned())
    {
        rj::Document extra(rj::kObjectType);
        extra.AddMember("componentId", str(id, extra.GetAllocator()), extra.GetAllocator());
        throw HttpError{404, "not_found", "component not found: " + id, "", toText(extra)};
    }
    return found;
}

/// The kind of a component for the app. The root is "instance", unless it is
/// a real device, such as the phone device the app makes its root.
std::string kindOf(const ComponentPtr& component, const ComponentPtr& root, bool rootIsDevice)
{
    if (component == root)
        return rootIsDevice ? "device" : "instance";
    if (component.supportsInterface<IChannel>())
        return "channel";
    if (component.supportsInterface<IRecorder>())
        return "recorder";
    if (component.supportsInterface<IFunctionBlock>())
        return "functionBlock";
    if (component.supportsInterface<IDevice>())
        return "device";
    if (component.supportsInterface<IServer>())
        return "server";
    if (component.supportsInterface<ISignal>())
        return "signal";
    if (component.supportsInterface<IInputPort>())
        return "inputPort";
    if (component.supportsInterface<ISyncComponent>())
        return "syncComponent";
    if (component.supportsInterface<IFolder>())
        return "folder";
    return "component";
}

std::string operationModeName(OperationModeType mode)
{
    switch (mode)
    {
        case OperationModeType::Idle: return "Idle";
        case OperationModeType::Operation: return "Operation";
        case OperationModeType::SafeOperation: return "SafeOperation";
        default: return "Unknown";
    }
}

OperationModeType operationModeFrom(const std::string& name)
{
    if (name == "Idle")
        return OperationModeType::Idle;
    if (name == "Operation")
        return OperationModeType::Operation;
    if (name == "SafeOperation")
        return OperationModeType::SafeOperation;
    fail(400, "bad_request", "Unknown operation mode " + name);
}

rj::Value statusJson(const ComponentPtr& component, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    std::string level = "none";
    rj::Value message;
    rj::Value statuses(rj::kObjectType);
    const auto container = safe<ComponentStatusContainerPtr>([&] { return component.getStatusContainer(); }, nullptr);
    if (container.assigned())
    {
        const auto entries = safe<DictPtr<IString, IEnumeration>>([&] { return container.getStatuses(); }, nullptr);
        if (entries.assigned())
            for (const auto& [name, value] : entries)
            {
                const std::string key = name.toStdString();
                const std::string text = safe<std::string>([&] { return textOf(container.getStatusMessage(key)); }, "");
                rj::Value state = valueToJson(value, a);
                // Only ComponentStatus colours the tree.
                if (key == "ComponentStatus")
                {
                    const std::string name = state.IsObject() && state.HasMember("name") && state["name"].IsString() ? state["name"].GetString() : plainText(state);
                    level = name == "Ok" ? "ok" : name == "Warning" ? "warning" : name == "Error" ? "error" : "none";
                    if (!text.empty())
                        message = str(text, a);
                }
                rj::Value status(rj::kObjectType);
                status.AddMember("value", state, a);
                status.AddMember("message", str(text, a), a);
                statuses.AddMember(str(key, a), status, a);
            }
    }
    out.AddMember("level", str(level, a), a);
    out.AddMember("message", message, a);
    out.AddMember("statuses", statuses, a);
    return out;
}

bool deviceConnected(const DevicePtr& device)
{
    const auto container = safe<ComponentStatusContainerPtr>([&] { return device.getStatusContainer(); }, nullptr);
    if (!container.assigned())
        return true;
    const auto status = safe<EnumerationPtr>([&] { return container.getStatus("ConnectionStatus"); }, nullptr);
    if (!status.assigned())
        return true;
    return safe<std::string>([&] { return status.getValue().toStdString(); }, "Connected") == "Connected";
}

ComponentPtr owningDevice(ComponentPtr component)
{
    while (component.assigned())
    {
        if (component.supportsInterface<IDevice>())
            return component;
        component = component.getParent();
    }
    return nullptr;
}

rj::Value inputPortsJson(const ComponentPtr& component, Alloc& a)
{
    rj::Value ports(rj::kArrayType);
    const auto block = component.asPtrOrNull<IFunctionBlock>();
    if (!block.assigned())
        return ports;
    const auto list = safe<ListPtr<IInputPort>>([&] { return block.getInputPorts(); }, nullptr);
    if (!list.assigned())
        return ports;
    for (const auto& port : list)
    {
        const auto connected = safe<SignalPtr>([&] { return port.getSignal(); }, nullptr);
        rj::Value p(rj::kObjectType);
        p.AddMember("id", str(safe<std::string>([&] { return textOf(port.getGlobalId()); }, ""), a), a);
        p.AddMember("name", str(safe<std::string>([&] { return textOf(port.getName()); }, ""), a), a);
        p.AddMember("localId", str(safe<std::string>([&] { return textOf(port.getLocalId()); }, ""), a), a);
        p.AddMember("description", str(safe<std::string>([&] { return textOf(port.getDescription()); }, ""), a), a);
        p.AddMember("active", safe<bool>([&] { return static_cast<bool>(port.getActive()); }, true), a);
        p.AddMember("visible", safe<bool>([&] { return static_cast<bool>(port.getVisible()); }, true), a);
        p.AddMember("requiresSignal", safe<bool>([&] { return static_cast<bool>(port.getRequiresSignal()); }, false), a);
        p.AddMember("signalId", connected.assigned() ? str(textOf(connected.getGlobalId()), a) : rj::Value(), a);
        p.AddMember("signalName", connected.assigned() ? str(textOf(connected.getName()), a) : rj::Value(), a);
        ports.PushBack(p, a);
    }
    return ports;
}

std::string notificationEvent(const std::string& message, const char* level, const std::string& componentId,
                              const std::string* detail)
{
    rj::Document d(rj::kObjectType);
    auto& a = d.GetAllocator();
    rj::Value payload(rj::kObjectType);
    payload.AddMember("level", rj::StringRef(level), a);
    payload.AddMember("message", str(message, a), a);
    payload.AddMember("detail", detail ? str(*detail, a) : rj::Value(), a);
    payload.AddMember("source", "viewer", a);
    payload.AddMember("componentId", str(componentId, a), a);
    d.AddMember("type", "notification", a);
    d.AddMember("payload", payload, a);
    return toText(d);
}

// ------------------------------------------------------------------ signals

bool isNumeric(SampleType type)
{
    switch (type)
    {
        case SampleType::Float32:
        case SampleType::Float64:
        case SampleType::Int8:
        case SampleType::Int16:
        case SampleType::Int32:
        case SampleType::Int64:
        case SampleType::UInt8:
        case SampleType::UInt16:
        case SampleType::UInt32:
        case SampleType::UInt64:
            return true;
        default:
            return false;
    }
}

std::string sampleTypeName(SampleType type)
{
    switch (type)
    {
        case SampleType::Float32: return "Float32";
        case SampleType::Float64: return "Float64";
        case SampleType::UInt8: return "UInt8";
        case SampleType::Int8: return "Int8";
        case SampleType::UInt16: return "UInt16";
        case SampleType::Int16: return "Int16";
        case SampleType::UInt32: return "UInt32";
        case SampleType::Int32: return "Int32";
        case SampleType::UInt64: return "UInt64";
        case SampleType::Int64: return "Int64";
        case SampleType::RangeInt64: return "RangeInt64";
        case SampleType::ComplexFloat32: return "ComplexFloat32";
        case SampleType::ComplexFloat64: return "ComplexFloat64";
        case SampleType::Binary: return "Binary";
        case SampleType::String: return "String";
        case SampleType::Struct: return "Struct";
        case SampleType::Null: return "Null";
        default: return "Undefined";
    }
}

namespace
{

/// A domain origin such as "1970-01-01T00:00:00Z" or
/// "2024-01-01T00:00:00.5+01:00": seconds since the Unix epoch, and the
/// zone's offset from UTC in seconds.
bool parseOrigin(const std::string& text, double& seconds, int& offset)
{
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0;
    if (text.empty() || std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%lf", &year, &month, &day, &hour, &minute, &second) < 3)
        return false;
    // Days from the civil date, after Howard Hinnant's algorithm.
    const int y = year - (month <= 2);
    const int era = (y >= 0 ? y : y - 399) / 400;
    const int yoe = y - era * 400;
    const int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = static_cast<int64_t>(era) * 146097 + doe - 719468;
    seconds = static_cast<double>(days * 86400 + hour * 3600 + minute * 60) + second;
    offset = 0;
    // A zone after the time, such as +01:00, moves it back to UTC.
    const auto t = text.find('T');
    const auto zone = t == std::string::npos ? std::string::npos : text.find_first_of("+-", t);
    if (zone != std::string::npos)
    {
        int zh = 0, zm = 0;
        std::sscanf(text.c_str() + zone + 1, "%d:%d", &zh, &zm);
        offset = (text[zone] == '-' ? -1 : 1) * (zh * 3600 + zm * 60);
        seconds -= offset;
    }
    return true;
}

/// "YYYY-MM-DD", "HH:MM:SS" and the microseconds of a moment in
/// microseconds since the Unix epoch.
void civil(int64_t micros, char* date, char* time, int& fraction)
{
    int64_t seconds = micros / 1000000;
    fraction = static_cast<int>(micros % 1000000);
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
    // The civil date of a day number, after Howard Hinnant's algorithm.
    days += 719468;
    const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
    const int64_t doe = days - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    const int64_t day = doy - (153 * mp + 2) / 5 + 1;
    const int64_t month = mp < 10 ? mp + 3 : mp - 9;
    const int64_t year = yoe + era * 400 + (month <= 2);
    std::snprintf(date, 16, "%04lld-%02lld-%02lld", static_cast<long long>(year), static_cast<long long>(month), static_cast<long long>(day));
    std::snprintf(time, 16, "%02lld:%02lld:%02lld", static_cast<long long>(rest / 3600), static_cast<long long>(rest / 60 % 60),
                  static_cast<long long>(rest % 60));
}

std::string lowered(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

/// The whole number in a text, or an exception.
int64_t wholeNumber(const std::string& text)
{
    size_t used = 0;
    const int64_t n = std::stoll(text, &used);
    if (text.find_first_not_of(" \t\n\r", used) != std::string::npos)
        throw std::invalid_argument("invalid literal for int() with base 10: " + reprText(text));
    return n;
}

std::string descriptorSampleType(const DataDescriptorPtr& descriptor)
{
    return safe<std::string>([&] { return sampleTypeName(descriptor.getSampleType()); }, "");
}

bool numericName(const std::string& name)
{
    return name.rfind("Float", 0) == 0 || name.rfind("Int", 0) == 0 || name.rfind("UInt", 0) == 0;
}

bool hasStructFields(const DataDescriptorPtr& descriptor)
{
    return safe<bool>([&] {
        const auto fields = descriptor.getStructFields();
        return fields.assigned() && fields.getCount() > 0;
    }, false);
}

size_t dimensionCount(const DataDescriptorPtr& descriptor)
{
    return safe<size_t>([&] {
        const auto dimensions = descriptor.getDimensions();
        return dimensions.assigned() ? static_cast<size_t>(dimensions.getCount()) : size_t(0);
    }, 0);
}

/// Samples per second of a domain descriptor's rule: `delta` ticks per
/// sample at its tick resolution.
bool domainRate(const DataDescriptorPtr& domain, double& rate)
{
    if (!domain.assigned())
        return false;
    return safe<bool>([&] {
        const RatioPtr resolution = domain.getTickResolution();
        const auto rule = domain.getRule();
        if (!resolution.assigned() || !rule.assigned())
            return false;
        const int64_t numerator = resolution.getNumerator();
        const int64_t denominator = resolution.getDenominator();
        const auto parameters = rule.getParameters();
        if (!numerator || !denominator || !parameters.assigned() || !parameters.hasKey("delta"))
            return false;
        const double delta = static_cast<double>(parameters.get("delta"));
        if (delta == 0)
            return false;
        const double period = delta * static_cast<double>(numerator) / static_cast<double>(denominator);
        if (period <= 0)
            return false;
        rate = 1.0 / period;
        return true;
    }, false);
}

/// Whether a domain descriptor counts wall-clock time rather than samples.
bool isTimeDomain(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return false;
    return safe<bool>([&] {
        if (!descriptor.getTickResolution().assigned())
            return false;
        const auto unit = descriptor.getUnit();
        if (!unit.assigned())
            return false;
        if (lowered(textOf(unit.getQuantity())) != "time" || lowered(textOf(unit.getSymbol())) != "s")
            return false;
        return !textOf(descriptor.getOrigin()).empty();
    }, false);
}

/// The picture format of an image signal's descriptor, or empty.
std::string imageFormat(const DataDescriptorPtr& descriptor)
{
    if (!descriptor.assigned())
        return "";
    return safe<std::string>([&] {
        if (descriptor.getSampleType() != SampleType::Binary)
            return std::string();
        const auto unit = descriptor.getUnit();
        const std::string symbol = unit.assigned() ? lowered(textOf(unit.getSymbol())) : "";
        for (const char* format : {"jpeg", "jpg", "png", "bmp", "plot"})
            if (symbol == format)
                return symbol;
        return std::string();
    }, "");
}

}  // namespace

bool originSeconds(const std::string& text, double& out)
{
    int offset = 0;
    return parseOrigin(text, out, offset);
}

/// Seconds per tick of a domain descriptor, or 0 when it has none.
double tickSeconds(const DataDescriptorPtr& domain)
{
    return safe<double>(
        [&] {
            const RatioPtr resolution = domain.getTickResolution();
            return static_cast<double>(resolution.getNumerator()) / static_cast<double>(resolution.getDenominator());
        },
        0.0);
}

/// Samples per second from a linear domain rule, or 0.
double sampleRate(const SignalPtr& signal)
{
    return safe<double>(
        [&] {
            const auto domain = signal.getDomainSignal().getDescriptor();
            const auto rule = domain.getRule();
            if (rule.getType() != DataRuleType::Linear)
                return 0.0;
            const double delta = static_cast<double>(rule.getParameters().get("delta"));
            const double seconds = delta * tickSeconds(domain);
            return seconds > 0 ? 1.0 / seconds : 0.0;
        },
        0.0);
}

SignalFacts factsOf(const SignalPtr& signal)
{
    SignalFacts facts;
    isSafe([&] {
        const auto descriptor = signal.getDescriptor();
        if (!descriptor.assigned())
            return;
        const auto type = descriptor.getSampleType();
        const auto dimensions = descriptor.getDimensions();
        const bool scalar = !dimensions.assigned() || dimensions.getCount() == 0;
        facts.shape = scalar ? (type == SampleType::Struct ? "struct" : "scalar") : "array";
        facts.unit = safe<std::string>([&] { return descriptor.getUnit().getSymbol().toStdString(); }, "");
        facts.chartable = scalar && isNumeric(type) && signal.getDomainSignal().assigned();
        facts.image = imageFormat(descriptor);
    });
    return facts;
}

rj::Value signalInfoJson(const SignalPtr& signal, Alloc& a)
{
    const auto domain = safe<SignalPtr>([&] { return signal.getDomainSignal(); }, nullptr);
    const auto descriptor = safe<DataDescriptorPtr>([&] { return signal.getDescriptor(); }, nullptr);
    const auto domainDescriptor = domain.assigned() ? safe<DataDescriptorPtr>([&] { return domain.getDescriptor(); }, nullptr) : nullptr;
    const auto parent = safe<ComponentPtr>([&] { return signal.getParent(); }, nullptr);
    const auto device = safe<ComponentPtr>([&] { return owningDevice(signal); }, nullptr);
    const auto text = [&](auto getter) { return str(safe<std::string>([&] { return textOf(getter()); }, ""), a); };
    const auto flag = [&](auto getter, bool fallback) { return safe<bool>([&] { return static_cast<bool>(getter()); }, fallback); };

    rj::Value info(rj::kObjectType);
    info.AddMember("id", text([&] { return signal.getGlobalId(); }), a);
    info.AddMember("localId", text([&] { return signal.getLocalId(); }), a);
    info.AddMember("name", text([&] { return signal.getName(); }), a);
    info.AddMember("description", text([&] { return signal.getDescription(); }), a);
    info.AddMember("parentId", parent.assigned() ? text([&] { return parent.getGlobalId(); }) : rj::Value(), a);
    info.AddMember("deviceId", device.assigned() ? text([&] { return device.getGlobalId(); }) : rj::Value(), a);
    info.AddMember("active", flag([&] { return signal.getActive(); }, true), a);
    info.AddMember("public", flag([&] { return signal.getPublic(); }, true), a);
    info.AddMember("visible", flag([&] { return signal.getVisible(); }, true), a);
    info.AddMember("streamed", flag([&] { return signal.getStreamed(); }, false), a);
    info.AddMember("domainSignalId", domain.assigned() ? text([&] { return domain.getGlobalId(); }) : rj::Value(), a);
    info.AddMember("domainSignalName", domain.assigned() ? text([&] { return domain.getName(); }) : rj::Value(), a);
    info.AddMember("unit", descriptor.assigned() ? unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a) : rj::Value(), a);
    const std::string sampleType = descriptor.assigned() ? descriptorSampleType(descriptor) : "";
    info.AddMember("sampleType", sampleType.empty() ? rj::Value() : str(sampleType, a), a);
    double rate = 0;
    info.AddMember("sampleRate", domainRate(domainDescriptor, rate) ? rj::Value(rate) : rj::Value(), a);

    const bool both = descriptor.assigned() && domainDescriptor.assigned();
    const bool numeric = both && numericName(sampleType) && !hasStructFields(descriptor);
    const size_t dimensions = numeric ? dimensionCount(descriptor) : 0;
    info.AddMember("chartable", numeric && dimensions == 0, a);
    info.AddMember("shape", rj::StringRef(!numeric ? "other" : dimensions == 0 ? "scalar" : dimensions == 1 ? "array" : "other"), a);

    const std::string image = imageFormat(descriptor);
    info.AddMember("image", image.empty() ? rj::Value() : str(image, a), a);
    rj::Value size;
    if (!image.empty())
        isSafe([&] {
            const auto metadata = descriptor.getMetadata();
            const int64_t width = wholeNumber(textOf(metadata.get("width")));
            const int64_t height = wholeNumber(textOf(metadata.get("height")));
            size.SetObject();
            size.AddMember("width", width, a);
            size.AddMember("height", height, a);
        });
    info.AddMember("imageSize", size, a);
    info.AddMember("timeDomain", isTimeDomain(domainDescriptor), a);
    rj::Value related(rj::kArrayType);
    isSafe([&] {
        for (const auto& other : signal.getRelatedSignals())
            related.PushBack(str(textOf(other.getGlobalId()), a), a);
    });
    info.AddMember("relatedSignalIds", related, a);
    return info;
}

rj::Value lastValueJson(const SignalPtr& signal, Alloc& a)
{
    rj::Value out(rj::kObjectType);
    out.AddMember("id", str(safe<std::string>([&] { return textOf(signal.getGlobalId()); }, ""), a), a);
    out.AddMember("value", rj::Value(), a);
    out.AddMember("displayValue", rj::Value(), a);
    out.AddMember("timestamp", rj::Value(), a);
    out.AddMember("kind", "none", a);
    out.AddMember("error", rj::Value(), a);

    const auto descriptor = safe<DataDescriptorPtr>([&] { return signal.getDescriptor(); }, nullptr);
    if (!imageFormat(descriptor).empty())
    {
        // A picture has no value to print; its size, from the descriptor's
        // metadata when the device gives it, says more.
        const std::string size = safe<std::string>([&] {
            const auto metadata = descriptor.getMetadata();
            if (!metadata.hasKey("width") || !metadata.hasKey("height"))
                return std::string();
            return textOf(metadata.get("width")) + " × " + textOf(metadata.get("height"));
        }, "");
        out["kind"] = rj::StringRef("image");
        out["displayValue"] = str(size.empty() ? "Picture" : size, a);
        return out;
    }

    BaseObjectPtr raw;
    try
    {
        raw = signal.getLastValue();
    }
    catch (const std::exception& error)
    {
        out["error"] = str(error.what(), a);
        return out;
    }
    if (!raw.assigned())
        return out;

    const auto unit = descriptor.assigned() ? unitJson(safe<UnitPtr>([&] { return descriptor.getUnit(); }, nullptr), a) : rj::Value();
    const std::string symbol = unit.IsObject() ? unit["symbol"].GetString() : "";

    // A domain signal's value is a tick count; shown as the moment it is.
    double origin = 0;
    int offset = 0;
    const auto resolution = isTimeDomain(descriptor) ? safe<RatioPtr>([&] { return descriptor.getTickResolution(); }, nullptr) : nullptr;
    const auto type = coreTypeOf(raw);
    if (resolution.assigned() && (type == ctInt || type == ctFloat) && resolution.getDenominator() != 0 &&
        parseOrigin(safe<std::string>([&] { return textOf(descriptor.getOrigin()); }, ""), origin, offset))
    {
        const int64_t ticks = type == ctInt ? static_cast<int64_t>(raw) : static_cast<int64_t>(std::trunc(static_cast<double>(raw)));
        const double seconds = static_cast<double>(ticks) * static_cast<double>(resolution.getNumerator()) /
                               static_cast<double>(resolution.getDenominator());
        const int64_t moment = static_cast<int64_t>(std::nearbyint(origin * 1e6)) + static_cast<int64_t>(std::nearbyint(seconds * 1e6));
        char date[16], time[16];
        int fraction = 0;
        civil(moment, date, time, fraction);
        char micros[8];
        std::snprintf(micros, sizeof micros, "%06d", fraction);
        const std::string stamp = std::string(date) + "T" + time + (fraction ? std::string(".") + micros : "") + "+00:00";
        civil(moment + static_cast<int64_t>(offset) * 1000000, date, time, fraction);
        std::snprintf(micros, sizeof micros, "%06d", fraction);
        std::string display = std::string(date) + " " + time + "." + micros;
        display.erase(display.find_last_not_of('0') + 1);
        if (display.back() == '.')
            display.pop_back();
        out["kind"] = rj::StringRef("timestamp");
        out["value"].SetInt64(ticks);
        out["timestamp"] = str(stamp, a);
        out["displayValue"] = str(display, a);
        return out;
    }

    rj::Value converted = valueToJson(raw, a);
    if (converted.IsObject() && converted.HasMember("kind") && converted["kind"] == "struct")
    {
        const auto& typeName = converted["typeName"];
        out["kind"] = rj::StringRef("struct");
        out["displayValue"] = str(typeName.IsString() && typeName.GetStringLength() ? typeName.GetString() : "struct", a);
    }
    else if (converted.IsString())
    {
        out["kind"] = rj::StringRef("string");
        out["displayValue"] = rj::Value(converted, a);
    }
    else if (converted.IsBool())
    {
        out["kind"] = rj::StringRef("bool");
        out["displayValue"] = rj::StringRef(converted.GetBool() ? "Yes" : "No");
    }
    else if (converted.IsNumber())
    {
        char text[64];
        if (converted.IsInt64())
            std::snprintf(text, sizeof text, "%lld", static_cast<long long>(converted.GetInt64()));
        else
            std::snprintf(text, sizeof text, "%.6g", converted.GetDouble());
        out["kind"] = rj::StringRef("number");
        out["displayValue"] = str(std::string(text) + (symbol.empty() ? "" : " " + symbol), a);
    }
    else
    {
        out["kind"] = rj::StringRef("other");
        if (!converted.IsNull())
            out["displayValue"] = str(plainText(converted), a);
    }
    out["value"] = converted;
    return out;
}

}  // namespace studio
