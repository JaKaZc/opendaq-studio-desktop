#include "logs.h"

#include <rapidjson/document.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/stringbuffer.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <regex>
#include <sstream>

namespace studio::logs
{

namespace fs = std::filesystem;
namespace rj = rapidjson;

const char* const kLevels[6] = {"trace", "debug", "info", "warning", "error", "critical"};

namespace
{

/// Lines kept: far more than anyone reads, and still bounded.
constexpr size_t kCapacity = 5000;

std::mutex lock;
std::deque<Record> records;
uint64_t sequence = 0;
fs::path directory;
std::string viewer = "info";

// The SDK's log file and how far it has been read.
std::string sdkPath;
uint64_t sdkOffset = 0;
std::string partial;

std::string lower(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

double now()
{
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count() / 1e6;
}

void addLocked(double at, const std::string& level, const std::string& source, const std::string& origin, const std::string& message)
{
    records.push_back({++sequence, at, level, source, origin, message});
    if (records.size() > kCapacity)
        records.pop_front();
}

fs::path preferencesFile()
{
    return directory / "logs" / "logging.json";
}

rj::Document readPreferences()
{
    rj::Document doc;
    std::ifstream in(preferencesFile());
    std::stringstream text;
    text << in.rdbuf();
    doc.Parse(text.str().c_str());
    if (doc.HasParseError() || !doc.IsObject())
        doc.SetObject();
    return doc;
}

/// A time openDAQ writes, "2026-09-07 06:45:47.471" in local time, as Unix time.
double parseTime(const std::string& text)
{
    std::tm moment{};
    int millis = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%d %d:%d:%d.%3d", &moment.tm_year, &moment.tm_mon, &moment.tm_mday, &moment.tm_hour,
                    &moment.tm_min, &moment.tm_sec, &millis) < 6)
        return now();
    moment.tm_year -= 1900;
    moment.tm_mon -= 1;
    moment.tm_isdst = -1;
    const std::time_t seconds = std::mktime(&moment);
    return seconds == -1 ? now() : static_cast<double>(seconds) + millis / 1000.0;
}

/// One line of the SDK's log, `[tid: 123][2026-09-07 06:45:47.471] [Component] [warning] text`,
/// or a line in another shape, which is kept as it is.
void addSdkLine(const std::string& line)
{
    static const std::regex shape(R"(^\[tid:\s*\d+\]\[([^\]]+)\]\s*\[([^\]]*)\]\s*\[([a-z]+)\]\s*(.*)$)");
    static const std::pair<const char*, const char*> levels[] = {
        {"trace", "trace"}, {"debug", "debug"}, {"info", "info"},   {"warn", "warning"},
        {"warning", "warning"}, {"err", "error"}, {"error", "error"}, {"critical", "critical"}};
    std::smatch match;
    if (!std::regex_match(line, match, shape))
    {
        addLocked(now(), "info", "sdk", "openDAQ", line);
        return;
    }
    std::string level = "info";
    for (const auto& [name, mapped] : levels)
        if (match[3] == name)
            level = mapped;
    const std::string origin = match[2];
    addLocked(parseTime(match[1]), level, "sdk", origin.empty() ? "openDAQ" : origin, match[4]);
}

std::string trim(const std::string& text)
{
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos)
        return {};
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

}  // namespace

bool isLevel(const std::string& level)
{
    return std::find(std::begin(kLevels), std::end(kLevels), level) != std::end(kLevels);
}

int rank(const std::string& level)
{
    const auto found = std::find(std::begin(kLevels), std::end(kLevels), level);
    return found == std::end(kLevels) ? 2 : static_cast<int>(found - std::begin(kLevels));
}

void add(double at, const std::string& level, const std::string& source, const std::string& origin, const std::string& message)
{
    std::lock_guard guard(lock);
    addLocked(at, level, source, origin, message);
}

std::vector<Record> entries(size_t limit, const std::string& level, const std::string& source, const std::string& search, uint64_t since)
{
    const int floor = rank(level);
    const std::string needle = lower(trim(search));
    std::vector<Record> selected;
    std::lock_guard guard(lock);
    for (const auto& record : records)
        if (record.seq > since && rank(record.level) >= floor && (source.empty() || record.source == source) &&
            (needle.empty() || lower(record.message).find(needle) != std::string::npos ||
             lower(record.origin).find(needle) != std::string::npos))
            selected.push_back(record);
    if (selected.size() > limit)
        selected.erase(selected.begin(), selected.end() - static_cast<std::ptrdiff_t>(limit));
    return selected;
}

size_t count()
{
    std::lock_guard guard(lock);
    return records.size();
}

void setDataDirectory(const std::string& path)
{
    std::lock_guard guard(lock);
    directory = path;
    if (directory.empty())
        return;
    std::error_code ignored;
    fs::create_directories(directory / "logs", ignored);
}

std::string sdkLogPath()
{
    std::lock_guard guard(lock);
    return directory.empty() ? std::string() : (directory / "logs" / "opendaq-sdk.log").string();
}

std::string storedLevel(const char* key)
{
    std::lock_guard guard(lock);
    if (directory.empty())
        return "info";
    const auto doc = readPreferences();
    if (doc.HasMember(key) && doc[key].IsString() && isLevel(doc[key].GetString()))
        return doc[key].GetString();
    return "info";
}

void storeLevels(const std::string& viewerLevel, const std::string& sdkLevel)
{
    std::lock_guard guard(lock);
    if (directory.empty())
        return;
    auto doc = readPreferences();
    auto& a = doc.GetAllocator();
    const auto set = [&](const char* key, const std::string& level)
    {
        if (level.empty())
            return;
        rj::Value value(level.c_str(), static_cast<rj::SizeType>(level.size()), a);
        if (doc.HasMember(key))
            doc[key] = value;
        else
            doc.AddMember(rj::StringRef(key), value, a);
    };
    set("viewerLevel", viewerLevel);
    set("sdkLevel", sdkLevel);
    rj::StringBuffer buffer;
    rj::PrettyWriter<rj::StringBuffer> writer(buffer);
    writer.SetIndent(' ', 2);
    doc.Accept(writer);
    std::ofstream(preferencesFile()) << buffer.GetString() << "\n";
}

std::string viewerLevel()
{
    std::lock_guard guard(lock);
    // The engine has no trace lines of its own, so trace is debug.
    return viewer == "trace" ? "debug" : viewer;
}

void setViewerLevel(const std::string& level)
{
    std::lock_guard guard(lock);
    viewer = level;
}

bool viewerLogs(const std::string& level)
{
    std::lock_guard guard(lock);
    return rank(level) >= rank(viewer);
}

void followSdkLog(const std::string& path)
{
    std::lock_guard guard(lock);
    sdkPath = path;
    std::error_code error;
    const auto size = fs::file_size(path, error);
    sdkOffset = error ? 0 : size;
    partial.clear();
}

void readSdkLog()
{
    std::lock_guard guard(lock);
    if (sdkPath.empty())
        return;
    std::error_code error;
    const auto size = fs::file_size(sdkPath, error);
    if (error)
        return;
    if (size < sdkOffset)
    {
        // The sink rotated the file out from under the reader.
        sdkOffset = 0;
        partial.clear();
    }
    if (size == sdkOffset)
        return;
    std::ifstream in(sdkPath, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(sdkOffset));
    std::string chunk(static_cast<size_t>(size - sdkOffset), '\0');
    in.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
    chunk.resize(static_cast<size_t>(in.gcount()));
    sdkOffset += chunk.size();

    // A sink writes a line at a time, but a read can still land mid-line.
    std::string text = partial + chunk;
    const auto end = text.rfind('\n');
    partial = end == std::string::npos ? text : text.substr(end + 1);
    if (end == std::string::npos)
        return;
    std::istringstream lines(text.substr(0, end));
    for (std::string line; std::getline(lines, line);)
    {
        line = trim(line);
        if (!line.empty())
            addSdkLine(line);
    }
}

int sdkLevelValue(const std::string& level)
{
    return isLevel(level) ? rank(level) : rank("info");
}

}  // namespace studio::logs
