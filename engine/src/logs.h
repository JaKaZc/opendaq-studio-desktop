// What the engine and the SDK have to say, kept where the API can read it
// (GET /api/system/logs).
//
// Two streams share one bounded ring: "viewer", the engine's own log lines,
// and "sdk", openDAQ's log. openDAQ only offers file sinks, so the instance
// writes its log to a file in the data directory and the ring copies what
// was appended whenever the log is read.
//
// openDAQ's components take their level when they are created, so the SDK's
// level is stored and applied on the next start, while the engine's own level
// changes at once. Both are kept in logs/logging.json.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace studio::logs
{

/// The levels the UI offers, quietest first.
extern const char* const kLevels[6];
bool isLevel(const std::string& level);
/// A level's place in kLevels; an unknown level counts as "info".
int rank(const std::string& level);

struct Record
{
    uint64_t seq;
    double at;
    std::string level;
    std::string source;
    std::string origin;
    std::string message;
};

void add(double at, const std::string& level, const std::string& source, const std::string& origin, const std::string& message);
/// The newest `limit` records at `level` or louder, from `source` (or both
/// when empty), whose message or origin contains `search`, after `since`;
/// oldest first.
std::vector<Record> entries(size_t limit, const std::string& level, const std::string& source, const std::string& search, uint64_t since);
size_t count();

/// Where the logs and their preferences are kept: `directory`/logs. Without
/// one, as on a phone that names none, the SDK's log is not captured and
/// the levels are not stored.
void setDataDirectory(const std::string& directory);
/// The SDK's log file, or empty without a data directory.
std::string sdkLogPath();

/// The stored level of "viewerLevel" or "sdkLevel", or "info".
std::string storedLevel(const char* key);
/// Stores the levels given; an empty one is left as it is.
void storeLevels(const std::string& viewer, const std::string& sdk);

/// The engine's own level, as the UI names it, and whether a line at `level`
/// is logged.
std::string viewerLevel();
void setViewerLevel(const std::string& level);
bool viewerLogs(const std::string& level);

/// Follows the SDK's log file from its current end, so a start begins clean.
void followSdkLog(const std::string& path);
/// Copies the lines the SDK appended since the last call into the ring.
void readSdkLog();

/// openDAQ's level number of a level name, as its LogLevel enum.
int sdkLevelValue(const std::string& level);

}  // namespace studio::logs
