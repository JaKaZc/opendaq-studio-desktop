// What differs between the platforms the engine runs on: where log lines go
// and how a module library is opened by hand. Everything else in the engine is
// the same code on Android, macOS and Windows.

#pragma once

#include <string>

namespace platform
{

enum class Level
{
    Debug,
    Info,
    Warn,
    Error
};

/// Writes one log line: to logcat on Android, to stderr on a computer, where
/// the desktop host collects it, and to the log the API serves. A line
/// quieter than the engine's log level is dropped.
void log(Level level, const char* tag, const char* format, ...)
#if defined(__GNUC__) || defined(__clang__)
    __attribute__((format(printf, 3, 4)))
#endif
    ;

/// The per-user folder openDAQ Studio keeps its state in: the one
/// OPENDAQ_STUDIO_DATA_DIR names, or the platform's, or empty on a phone.
std::string dataDirectory();

/// Opens a shared library and returns the address of `symbol` in it, or
/// throws with the system's reason.
void* openSymbol(const std::string& library, const char* symbol);

}  // namespace platform
