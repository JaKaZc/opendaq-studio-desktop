// JSON values written as text where the API carries that text: a
// configuration's size counts the file in its spaced JSON form, and an
// event's detail prints a value in its literal form.

#pragma once

#include <rapidjson/document.h>

#include <string>

namespace studio
{

/// The JSON text of a value with ", " and ": " separators and ASCII only.
std::string asciiJson(const rapidjson::Value& value);

/// A value in its literal form: quoted strings, None, True and False.
std::string jsonRepr(const rapidjson::Value& value);

}  // namespace studio
