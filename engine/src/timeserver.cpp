#include "timeserver.h"

#include "platform.h"
#include "timesync.h"

#include <chrono>
#include <cstring>
#include <set>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <cerrno>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace studio
{

namespace
{

#if defined(_WIN32)
using Socket = SOCKET;
void closeSocket(Socket s)
{
    closesocket(s);
}
std::string socketError()
{
    return "error " + std::to_string(WSAGetLastError());
}
#else
using Socket = int;
void closeSocket(Socket s)
{
    close(s);
}
std::string socketError()
{
    return std::strerror(errno);
}
#endif

constexpr uint64_t kNtpEpoch = 2'208'988'800;  // seconds from 1900 to 1970
constexpr Int kNetworkTime = 1;                // the phone device's TimeSource "Network time"

/// Sockets need Windows' socket library started once; elsewhere this is nothing.
void startSockets()
{
#if defined(_WIN32)
    static const bool started = []
    {
        WSADATA data;
        return WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }();
    (void) started;
#endif
}

/// An NTP timestamp of this computer's clock: seconds since 1900 and the
/// fraction of a second in 1/2^32.
void ntpTimestamp(uint8_t* out)
{
    using namespace std::chrono;
    const auto ns = duration_cast<nanoseconds>(system_clock::now().time_since_epoch()).count();
    const uint64_t seconds = static_cast<uint64_t>(ns / 1'000'000'000) + kNtpEpoch;
    const uint64_t fraction = (static_cast<uint64_t>(ns % 1'000'000'000) << 32) / 1'000'000'000;
    for (int i = 0; i < 4; i++)
    {
        out[i] = static_cast<uint8_t>((seconds >> (24 - 8 * i)) & 0xFF);
        out[4 + i] = static_cast<uint8_t>((fraction >> (24 - 8 * i)) & 0xFF);
    }
}

/// This computer's address on the network that reaches `host`, or empty.
std::string localAddressTowards(const std::string& host)
{
    startSockets();
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo* found = nullptr;
    if (getaddrinfo(host.c_str(), "9", &hints, &found) != 0 || !found)
        return {};
    std::string out;
    const Socket probe = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (connect(probe, found->ai_addr, static_cast<socklen_t>(found->ai_addrlen)) == 0)
    {
        sockaddr_in local{};
        socklen_t length = sizeof local;
        char text[INET_ADDRSTRLEN] = {};
        if (getsockname(probe, reinterpret_cast<sockaddr*>(&local), &length) == 0 &&
            inet_ntop(AF_INET, &local.sin_addr, text, sizeof text))
            out = text;
    }
    closeSocket(probe);
    freeaddrinfo(found);
    return out;
}

/// Where devices on this computer's networks reach the server.
std::vector<std::string> ownAddresses()
{
    startSockets();
    char name[256] = {};
    if (gethostname(name, sizeof name - 1) != 0)
        return {};
    addrinfo hints{};
    hints.ai_family = AF_INET;
    addrinfo* found = nullptr;
    if (getaddrinfo(name, nullptr, &hints, &found) != 0)
        return {};
    std::set<std::string> addresses;
    for (auto* item = found; item; item = item->ai_next)
    {
        char text[INET_ADDRSTRLEN] = {};
        if (inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(item->ai_addr)->sin_addr, text, sizeof text) &&
            std::strncmp(text, "127.", 4) != 0)
            addresses.insert(text);
    }
    freeaddrinfo(found);
    return {addresses.begin(), addresses.end()};
}

}  // namespace

// ------------------------------------------------------------------ the server

TimeServer::TimeServer(int port)
    : port(port)
{
}

TimeServer::~TimeServer()
{
    stop();
}

void TimeServer::start()
{
    if (running())
        return;
    startSockets();
    const Socket s = ::socket(AF_INET, SOCK_DGRAM, 0);
    const int reuse = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof reuse);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(static_cast<uint16_t>(port));
    if (bind(s, reinterpret_cast<sockaddr*>(&address), sizeof address) != 0)
    {
        error = "Port " + std::to_string(port) + " could not be opened: " + socketError();
        closeSocket(s);
        platform::log(platform::Level::Warn, kTag, "Time server: %s", error.c_str());
        return;
    }
    // A receive wakes every half second to notice it should stop.
#if defined(_WIN32)
    const DWORD timeout = 500;
#else
    const timeval timeout{0, 500'000};
#endif
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof timeout);
    socklen_t length = sizeof address;
    getsockname(s, reinterpret_cast<sockaddr*>(&address), &length);
    port = ntohs(address.sin_port);
    error.clear();
    socket = static_cast<intptr_t>(s);
    stopping = false;
    thread = std::thread([this] { serve(); });
    platform::log(platform::Level::Info, kTag, "Serving time on UDP port %d", port);
}

void TimeServer::stop()
{
    stopping = true;
    if (thread.joinable())
        thread.join();
    if (socket != -1)
        closeSocket(static_cast<Socket>(socket));
    socket = -1;
}

void TimeServer::serve()
{
    const auto s = static_cast<Socket>(socket);
    uint8_t request[512];
    while (!stopping)
    {
        sockaddr_storage from{};
        socklen_t fromLength = sizeof from;
        const auto received = recvfrom(s, reinterpret_cast<char*>(request), sizeof request, 0, reinterpret_cast<sockaddr*>(&from), &fromLength);
        if (received < 48 || (request[0] & 7) != 3)
            continue;
        uint8_t receivedAt[8];
        ntpTimestamp(receivedAt);
        const int version = ((request[0] >> 3) & 7) ? (request[0] >> 3) & 7 : 4;
        uint8_t reply[48] = {};
        reply[0] = static_cast<uint8_t>((version << 3) | 4);  // no leap warning, server mode
        reply[1] = 2;                                        // stratum: this computer follows a server of its own
        reply[2] = request[2];                               // poll interval, as asked
        reply[3] = 0xEC;                                     // precision, about a microsecond (2^-20 s)
        std::memcpy(reply + 12, "LOCL", 4);
        std::memcpy(reply + 16, receivedAt, 8);  // reference: the clock is set
        std::memcpy(reply + 24, request + 40, 8);  // originate: the client's transmit time
        std::memcpy(reply + 32, receivedAt, 8);
        ntpTimestamp(reply + 40);
        if (sendto(s, reinterpret_cast<const char*>(reply), sizeof reply, 0, reinterpret_cast<sockaddr*>(&from), fromLength) == sizeof reply)
            answered++;
    }
}

// ------------------------------------------------------------------ the master

TimeMaster::TimeMaster()
{
    server.start();
}

void TimeMaster::follow(const DevicePtr& root)
{
    std::lock_guard guard(lock);
    const auto devices = safe<ListPtr<IDevice>>([&] { return root.getDevices(); }, List<IDevice>());

    hasMaster = false;
    for (const auto& device : devices)
    {
        const auto addresses = servedAddresses(device);
        if (addresses.empty())
            continue;
        // The address Studio reaches the device at is the one the other
        // devices most likely reach it at too.
        const std::string host = hostOf(safe<std::string>([&] { return device.getInfo().getConnectionString().toStdString(); }, ""));
        master = {safe<std::string>([&] { return device.getGlobalId().toStdString(); }, ""),
                  safe<std::string>([&] { return device.getName().toStdString(); }, ""), addresses.front(), addresses};
        for (const auto& address : addresses)
            if (!host.empty() && address.rfind(host + ":", 0) == 0)
            {
                master.address = address;
                break;
            }
        hasMaster = true;
        break;
    }
    if (!hasMaster && (!enabled || !server.running()))
        return;
    for (const auto& device : devices)
    {
        if (hasMaster && safe<std::string>([&] { return device.getGlobalId().toStdString(); }, "") == master.id)
            continue;
        point(device, hasMaster ? master.address : "");
    }
}

void TimeMaster::point(const DevicePtr& device, const std::string& to)
{
    if (!safe<bool>([&] { return device.hasProperty("NtpServer") && device.hasProperty("TimeSource"); }, false))
        return;
    std::string address = to;
    if (address.empty())
    {
        const std::string host = hostOf(safe<std::string>([&] { return device.getInfo().getConnectionString().toStdString(); }, ""));
        // A device reached through this computer itself, such as over an adb
        // forward, cannot reach the server at a loopback address.
        if (host.empty() || host == "localhost" || host == "::1" || host.rfind("127.", 0) == 0)
            return;
        const std::string local = localAddressTowards(host);
        if (local.empty())
            return;
        address = local + ":" + std::to_string(server.port);
    }
    const std::string id = safe<std::string>([&] { return device.getGlobalId().toStdString(); }, "");
    if (pointed[id] == address)
        return;
    // A locked device refuses, and stays as it is; it is not asked again.
    pointed[id] = address;
    const std::string name = safe<std::string>([&] { return device.getName().toStdString(); }, id);
    try
    {
        device.setPropertyValue("NtpServer", String(address));
        device.setPropertyValue("TimeSource", kNetworkTime);
        platform::log(platform::Level::Info, kTag, "%s follows the time at %s", name.c_str(), address.c_str());
    }
    catch (const std::exception& error)
    {
        platform::log(platform::Level::Warn, kTag, "%s could not be pointed at the time at %s: %s", id.c_str(), address.c_str(), error.what());
    }
}

rj::Value TimeMaster::state(Alloc& a)
{
    std::lock_guard guard(lock);
    rj::Value out(rj::kObjectType);
    out.AddMember("enabled", enabled.load(), a);
    out.AddMember("serving", server.running(), a);
    out.AddMember("port", server.port, a);
    rj::Value addresses(rj::kArrayType);
    for (const auto& address : ownAddresses())
        addresses.PushBack(str(address, a), a);
    out.AddMember("addresses", addresses, a);
    out.AddMember("answered", server.answered.load(), a);
    out.AddMember("error", server.error.empty() ? rj::Value() : str(server.error, a), a);
    // A device that serves its time, which the others follow instead.
    rj::Value device;
    if (hasMaster)
    {
        device.SetObject();
        device.AddMember("id", str(master.id, a), a);
        device.AddMember("name", str(master.name, a), a);
        device.AddMember("address", str(master.address, a), a);
        rj::Value served(rj::kArrayType);
        for (const auto& address : master.addresses)
            served.PushBack(str(address, a), a);
        device.AddMember("addresses", served, a);
    }
    out.AddMember("device", device, a);
    return out;
}

}  // namespace studio
