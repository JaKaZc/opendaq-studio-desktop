// Each area of the API registers its routes here. The engine calls every
// function below once, when it starts.

#pragma once

#include "../engine.h"

namespace studio
{

void addSystemRoutes(Router& router);
void addComponentRoutes(Router& router);
void addPropertyRoutes(Router& router);
void addSignalRoutes(Router& router);
void addTopologyRoutes(Router& router);
void addModuleRoutes(Router& router);
void addTimeRoutes(Router& router);
void addSharingRoutes(Router& router);
void addFitRoutes(Router& router);
void addServerRoutes(Router& router);
void addFleetRoutes(Router& router);
void addConfigurationRoutes(Router& router);

inline void addAllRoutes(Router& router)
{
    addSystemRoutes(router);
    addComponentRoutes(router);
    addPropertyRoutes(router);
    addSignalRoutes(router);
    addTopologyRoutes(router);
    addModuleRoutes(router);
    addTimeRoutes(router);
    addSharingRoutes(router);
    addFitRoutes(router);
    addServerRoutes(router);
    addFleetRoutes(router);
    addConfigurationRoutes(router);
}

}  // namespace studio
