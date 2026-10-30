#include "timesync.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <regex>

namespace studio
{

namespace
{

/// Unix time in microseconds of a domain origin such as
/// "1970-01-01T00:00:00Z" or "2024-01-01T00:00:00+01:00", or false.
bool originMicroseconds(const std::string& text, int64_t& out)
{
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%d", &year, &month, &day, &hour, &minute, &second) < 3)
        return false;
    // Days from the civil date, after Howard Hinnant's algorithm.
    const int y = year - (month <= 2);
    const int era = (y >= 0 ? y : y - 399) / 400;
    const int yoe = y - era * 400;
    const int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = static_cast<int64_t>(era) * 146097 + doe - 719468;
    int64_t seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    // A zone after the time, such as +01:00, moves it back to UTC.
    const auto t = text.find('T');
    const auto zone = t == std::string::npos ? std::string::npos : text.find_first_of("+-", t);
    if (zone != std::string::npos)
    {
        int zh = 0, zm = 0;
        std::sscanf(text.c_str() + zone + 1, "%d:%d", &zh, &zm);
        seconds -= (text[zone] == '-' ? -1 : 1) * (zh * 3600 + zm * 60);
    }
    out = seconds * 1'000'000;
    return true;
}

int64_t nowMicroseconds()
{
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count();
}

}  // namespace

void collectDevices(const DevicePtr& device, std::vector<DevicePtr>& out)
{
    out.push_back(device);
    isSafe([&] {
        for (const auto& child : device.getDevices())
            collectDevices(child, out);
    });
}

bool measureClock(const DevicePtr& device, double& offsetMs, double& uncertaintyMs)
{
    const auto domain = device.getDomain();
    if (!domain.assigned())
        return false;
    int64_t origin = 0;
    if (!originMicroseconds(domain.getOrigin().toStdString(), origin))
        return false;
    const auto resolution = domain.getTickResolution();
    const long double perTick = static_cast<long double>(resolution.getNumerator()) * 1e6L / resolution.getDenominator();
    // Three tries; the fastest answer is the most exact.
    double best = -1;
    for (int i = 0; i < 3; i++)
    {
        const int64_t before = nowMicroseconds();
        const uint64_t ticks = device.getTicksSinceOrigin();
        const int64_t after = nowMicroseconds();
        if (ticks == 0)
            return false;
        const long double deviceTime = origin + static_cast<long double>(ticks) * perTick;
        const double half = (after - before) / 2.0;
        if (best < 0 || half < best)
        {
            best = half;
            offsetMs = static_cast<double>((deviceTime - (before + half)) / 1000.0L);
        }
    }
    uncertaintyMs = best / 1000.0;
    return true;
}

std::map<std::string, double> measureOffsets(const DevicePtr& root)
{
    std::vector<DevicePtr> devices;
    collectDevices(root, devices);
    std::map<std::string, double> out;
    for (const auto& device : devices)
    {
        double offset = 0;
        double uncertainty = 0;
        if (safe<bool>([&] { return measureClock(device, offset, uncertainty); }, false))
            out[device.getGlobalId().toStdString()] = offset / 1000;
    }
    return out;
}

std::vector<std::string> servedAddresses(const DevicePtr& device)
{
    std::vector<std::string> out;
    isSafe([&] {
        if (!device.hasProperty("ServeTime") || !static_cast<bool>(device.getPropertyValue("ServeTime")))
            return;
        const std::string text = static_cast<std::string>(device.getPropertyValue("TimeServer").asPtr<IString>());
        static const std::regex address(R"(\b\d{1,3}(\.\d{1,3}){3}:\d+\b)");
        for (auto it = std::sregex_iterator(text.begin(), text.end(), address); it != std::sregex_iterator(); ++it)
            out.push_back(it->str());
    });
    return out;
}

std::string hostOf(const std::string& connection)
{
    const auto start = connection.find("://");
    if (start == std::string::npos)
        return {};
    std::string rest = connection.substr(start + 3);
    rest = rest.substr(0, rest.find_first_of("/?#"));
    const auto at = rest.rfind('@');
    if (at != std::string::npos)
        rest = rest.substr(at + 1);
    std::string host = rest[0] == '[' ? rest.substr(1, rest.find(']') - 1) : rest.substr(0, rest.find(':'));
    std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return host;
}

}  // namespace studio
