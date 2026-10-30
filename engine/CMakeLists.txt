cmake_minimum_required(VERSION 3.24)
project(studio_engine LANGUAGES CXX)

# The openDAQ Studio engine, for the phone app (Android arm64) and the
# desktop app (macOS, Windows). The SDK comes from an install of the openDAQ
# SDK: the Android build cross-compiles one, the desktop builds use the core's
# headers and link against the libraries that ship in the openDAQ wheel.
find_package(openDAQ REQUIRED)

# rapidjson is header only. The SDK's source tree carries it.
set(RAPIDJSON_INCLUDE "" CACHE PATH "rapidjson include directory")

add_library(studio_engine SHARED
    src/c_api.cpp
    src/common.cpp
    src/engine.cpp
    src/logs.cpp
    src/pictures.cpp
    src/platform.cpp
    src/value_text.cpp
    src/streaming.cpp
    src/timeserver.cpp
    src/timesync.cpp
    src/routes/components.cpp
    src/routes/configuration.cpp
    src/routes/fit.cpp
    src/routes/fleet.cpp
    src/routes/modules.cpp
    src/routes/properties.cpp
    src/routes/selfconnect.cpp
    src/routes/servers.cpp
    src/routes/sharing.cpp
    src/routes/signal_info.cpp
    src/routes/signals.cpp
    src/routes/system.cpp
    src/routes/time.cpp
    src/routes/topology_support.cpp
    src/routes/topology.cpp
)
target_compile_features(studio_engine PRIVATE cxx_std_17)
target_include_directories(studio_engine PRIVATE ${RAPIDJSON_INCLUDE} PUBLIC include)
target_link_libraries(studio_engine PRIVATE daq::opendaq)
set_target_properties(studio_engine PROPERTIES CXX_VISIBILITY_PRESET hidden)

if(WIN32)
    # Sockets: selfconnect.cpp resolves this computer's own addresses, and
    # the time server answers NTP.
    target_link_libraries(studio_engine PRIVATE ws2_32)
endif()

if(ANDROID)
    target_link_libraries(studio_engine PRIVATE dl log)
elseif(APPLE)
    # The SDK's libraries sit beside the engine in the app.
    set_target_properties(studio_engine PROPERTIES
        INSTALL_RPATH "@loader_path"
        BUILD_WITH_INSTALL_RPATH ON)
elseif(UNIX)
    target_link_libraries(studio_engine PRIVATE dl)
    set_target_properties(studio_engine PROPERTIES
        INSTALL_RPATH "$ORIGIN"
        BUILD_WITH_INSTALL_RPATH ON)
endif()

option(STUDIO_ENGINE_TOOLS "Build studio_cli, a command line client for tests" OFF)
if(STUDIO_ENGINE_TOOLS)
    add_executable(studio_cli tests/studio_cli.cpp)
    target_compile_features(studio_cli PRIVATE cxx_std_17)
    target_link_libraries(studio_cli PRIVATE studio_engine)
    if(APPLE)
        set_target_properties(studio_cli PROPERTIES INSTALL_RPATH "@loader_path" BUILD_WITH_INSTALL_RPATH ON)
    endif()
endif()

# The Node addon the desktop app's engine host loads. Node-API is ABI stable,
# so one build serves every Electron version. NODE_API_DIR is the node/
# folder with node-api-headers and node-addon-api installed (npm install).
option(STUDIO_ENGINE_NODE "Build the Node addon for the desktop app" OFF)
if(STUDIO_ENGINE_NODE)
    set(NODE_API_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node" CACHE PATH "Folder with node-api-headers and node-addon-api")
    add_library(studio_engine_node MODULE node/addon.cpp)
    target_compile_features(studio_engine_node PRIVATE cxx_std_17)
    target_include_directories(studio_engine_node PRIVATE
        "${NODE_API_DIR}/node_modules/node-api-headers/include"
        "${NODE_API_DIR}/node_modules/node-addon-api")
    target_compile_definitions(studio_engine_node PRIVATE NAPI_CPP_EXCEPTIONS)
    target_link_libraries(studio_engine_node PRIVATE studio_engine)
    set_target_properties(studio_engine_node PROPERTIES
        OUTPUT_NAME studio_engine
        PREFIX ""
        SUFFIX ".node"
        CXX_VISIBILITY_PRESET hidden)
    if(APPLE)
        # Node's functions come from the process that loads the addon.
        target_link_options(studio_engine_node PRIVATE -undefined dynamic_lookup)
        set_target_properties(studio_engine_node PROPERTIES INSTALL_RPATH "@loader_path" BUILD_WITH_INSTALL_RPATH ON)
    elseif(WIN32)
        # NODE_API_LIB is an import library for node.exe made from
        # node-api-headers' node_api.def; the hook redirects it to Electron.
        target_sources(studio_engine_node PRIVATE node/win_delay_load_hook.cpp)
        target_link_libraries(studio_engine_node PRIVATE "${NODE_API_LIB}" delayimp)
        target_link_options(studio_engine_node PRIVATE /DELAYLOAD:node.exe)
    endif()
endif()
