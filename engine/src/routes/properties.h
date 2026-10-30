// The property tree of a component or another property object, as
// /api/properties lists it, for the routes that show properties alongside
// other things, such as a type's default configuration.

#pragma once

#include "../common.h"

namespace studio
{

/// `{componentId, className, updating, properties}`: every property of an
/// object, nested objects included, with what an editor needs. An object
/// that is not a component has an empty componentId.
rj::Value listProperties(const PropertyObjectPtr& object, bool includeHidden, Alloc& a);

/// `{fields: [{key, label}]}`: the metadata columns the UI can show next to
/// a property's value, the members of /api/properties/metadata.
rj::Value metadataFields(Alloc& a);

}  // namespace studio
