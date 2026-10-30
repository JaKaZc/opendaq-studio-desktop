#include "value_text.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace studio
{

namespace
{

/// A float in the shortest digits that read back the same, fixed between
/// 1e-4 and 1e16, otherwise with a signed exponent of at least two digits.
std::string floatText(double value)
{
    if (std::isnan(value))
        return "NaN";
    if (std::isinf(value))
        return value > 0 ? "Infinity" : "-Infinity";
    char text[40];
    for (int precision = 1; precision <= 17; precision++)
    {
        std::snprintf(text, sizeof text, "%.*e", precision - 1, value);
        if (std::strtod(text, nullptr) == value)
            break;
    }
    // text is [-]d[.ddd]e[+-]xx: split it into sign, digits and exponent.
    std::string scientific = text;
    const bool negative = scientific[0] == '-';
    if (negative)
        scientific.erase(0, 1);
    const auto e = scientific.find('e');
    const int exponent = std::atoi(scientific.c_str() + e + 1);
    std::string digits = scientific.substr(0, e);
    digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());

    std::string out;
    if (exponent >= -4 && exponent < 16)
    {
        if (exponent < 0)
            out = "0." + std::string(static_cast<size_t>(-exponent - 1), '0') + digits;
        else if (static_cast<int>(digits.size()) <= exponent + 1)
            out = digits + std::string(static_cast<size_t>(exponent + 1 - static_cast<int>(digits.size())), '0') + ".0";
        else
            out = digits.substr(0, static_cast<size_t>(exponent + 1)) + "." + digits.substr(static_cast<size_t>(exponent + 1));
    }
    else
    {
        out = digits.substr(0, 1);
        if (digits.size() > 1)
            out += "." + digits.substr(1);
        char tail[8];
        std::snprintf(tail, sizeof tail, "e%c%02d", exponent < 0 ? '-' : '+', std::abs(exponent));
        out += tail;
    }
    return negative ? "-" + out : out;
}

std::string numberText(const rapidjson::Value& value)
{
    if (value.IsInt64())
        return std::to_string(value.GetInt64());
    if (value.IsUint64())
        return std::to_string(value.GetUint64());
    return floatText(value.GetDouble());
}

/// The code points of UTF-8 text; a malformed byte stands for itself.
template <typename Emit>
void forEachCodePoint(const std::string& text, Emit&& emit)
{
    for (size_t i = 0; i < text.size();)
    {
        const auto c = static_cast<unsigned char>(text[i]);
        const int length = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
        if (length == 1 || i + length > text.size())
        {
            emit(static_cast<uint32_t>(c), text.substr(i, 1));
            i++;
            continue;
        }
        uint32_t point = c & (0x7F >> length);
        for (int k = 1; k < length; k++)
            point = (point << 6) | (static_cast<unsigned char>(text[i + k]) & 0x3F);
        emit(point, text.substr(i, static_cast<size_t>(length)));
        i += static_cast<size_t>(length);
    }
}

std::string jsonString(const std::string& text)
{
    std::string out = "\"";
    char escape[16];
    forEachCodePoint(text,
                     [&](uint32_t point, const std::string&)
                     {
                         switch (point)
                         {
                             case '"': out += "\\\""; return;
                             case '\\': out += "\\\\"; return;
                             case '\n': out += "\\n"; return;
                             case '\r': out += "\\r"; return;
                             case '\t': out += "\\t"; return;
                             case '\b': out += "\\b"; return;
                             case '\f': out += "\\f"; return;
                             default: break;
                         }
                         if (point >= 0x20 && point < 0x7F)
                             out += static_cast<char>(point);
                         else if (point < 0x10000)
                         {
                             std::snprintf(escape, sizeof escape, "\\u%04x", point);
                             out += escape;
                         }
                         else
                         {
                             const uint32_t v = point - 0x10000;
                             std::snprintf(escape, sizeof escape, "\\u%04x\\u%04x", 0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF));
                             out += escape;
                         }
                     });
    return out + "\"";
}

std::string reprString(const std::string& text)
{
    const bool single = text.find('\'') != std::string::npos;
    const char quote = single && text.find('"') == std::string::npos ? '"' : '\'';
    std::string out(1, quote);
    char escape[16];
    forEachCodePoint(text,
                     [&](uint32_t point, const std::string& bytes)
                     {
                         if (point == static_cast<uint32_t>(quote) || point == '\\')
                             out += "\\" + bytes;
                         else if (point == '\n')
                             out += "\\n";
                         else if (point == '\r')
                             out += "\\r";
                         else if (point == '\t')
                             out += "\\t";
                         else if (point < 0x20 || point == 0x7F)
                         {
                             std::snprintf(escape, sizeof escape, "\\x%02x", point);
                             out += escape;
                         }
                         else
                             out += bytes;
                     });
    return out + quote;
}

template <typename Text>
std::string write(const rapidjson::Value& value, Text&& text, const char* null, const char* yes, const char* no)
{
    if (value.IsNull())
        return null;
    if (value.IsBool())
        return value.GetBool() ? yes : no;
    if (value.IsNumber())
        return numberText(value);
    if (value.IsString())
        return text(std::string(value.GetString(), value.GetStringLength()));
    std::string out;
    if (value.IsArray())
    {
        out = "[";
        for (const auto& item : value.GetArray())
            out += (out.size() > 1 ? ", " : "") + write(item, text, null, yes, no);
        return out + "]";
    }
    out = "{";
    for (const auto& member : value.GetObject())
        out += (out.size() > 1 ? ", " : "") + text(std::string(member.name.GetString(), member.name.GetStringLength())) + ": " +
               write(member.value, text, null, yes, no);
    return out + "}";
}

}  // namespace

std::string asciiJson(const rapidjson::Value& value)
{
    return write(value, jsonString, "null", "true", "false");
}

std::string jsonRepr(const rapidjson::Value& value)
{
    return write(value, reprString, "None", "True", "False");
}

}  // namespace studio
