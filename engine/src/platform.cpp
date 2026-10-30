#include "platform.h"

#include "logs.h"

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>

#if defined(__ANDROID__)
#include <android/log.h>
#include <dlfcn.h>
#elif defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace platform
{

void log(Level level, const char* tag, const char* format, ...)
{
    static const char* const names[] = {"debug", "info", "warning", "error"};
    const char* name = names[static_cast<int>(level)];
    if (!studio::logs::viewerLogs(name))
        return;
    va_list args;
    va_start(args, format);
    char text[2048];
    std::vsnprintf(text, sizeof text, format, args);
    va_end(args);
#if defined(__ANDROID__)
    const int priority = level == Level::Error  ? ANDROID_LOG_ERROR
                         : level == Level::Warn ? ANDROID_LOG_WARN
                         : level == Level::Info ? ANDROID_LOG_INFO
                                                : ANDROID_LOG_DEBUG;
    __android_log_write(priority, tag, text);
#else
    static const char* const upper[] = {"DEBUG", "INFO", "WARNING", "ERROR"};
    std::fprintf(stderr, "%s %s: %s\n", upper[static_cast<int>(level)], tag, text);
    std::fflush(stderr);
#endif
    using namespace std::chrono;
    studio::logs::add(duration_cast<microseconds>(system_clock::now().time_since_epoch()).count() / 1e6, name, "viewer", tag, text);
}

std::string dataDirectory()
{
    for (const char* name : {"OPENDAQ_STUDIO_DATA_DIR", "OPENDAQ_VIEWER_DATA_DIR"})
        if (const char* value = std::getenv(name); value && *value)
            return value;
#if defined(__ANDROID__)
    return {};
#elif defined(_WIN32)
    const char* local = std::getenv("LOCALAPPDATA");
    const char* home = std::getenv("USERPROFILE");
    return local ? std::string(local) + "\\openDAQ Studio" : home ? std::string(home) + "\\AppData\\Local\\openDAQ Studio" : "";
#else
    const char* home = std::getenv("HOME");
#if defined(__APPLE__)
    return home ? std::string(home) + "/Library/Application Support/openDAQ Studio" : "";
#else
    if (const char* data = std::getenv("XDG_DATA_HOME"); data && *data)
        return std::string(data) + "/opendaq-studio";
    return home ? std::string(home) + "/.local/share/opendaq-studio" : "";
#endif
#endif
}

void* openSymbol(const std::string& library, const char* symbol)
{
#if defined(_WIN32)
    HMODULE handle = LoadLibraryA(library.c_str());
    if (!handle)
        throw std::runtime_error("Could not load " + library + ": error " + std::to_string(GetLastError()));
    void* address = reinterpret_cast<void*>(GetProcAddress(handle, symbol));
#else
    void* handle = dlopen(library.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (!handle)
        throw std::runtime_error("Could not load " + library + ": " + dlerror());
    void* address = dlsym(handle, symbol);
#endif
    if (!address)
        throw std::runtime_error(library + " has no " + symbol);
    return address;
}

}  // namespace platform
