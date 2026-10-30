// openDAQ Studio as the time master of the devices on its network.
//
// Studio answers NTP requests on UDP port 12300, which needs no
// administrator rights, from this computer's clock. Devices that follow NTP
// and say which server, such as a phone with the Android device module (its
// NtpServer and TimeSource properties), are pointed at it as they connect, so
// they all follow one clock over one network hop.
//
// A device is pointed once, when Studio first sees it or when this
// computer's address towards it changes; choosing another time source on the
// device afterwards is the user's choice. A device can be the master
// instead: a phone whose ServeTime is on serves its own time, and the other
// devices are pointed at it.
//
// The desktop engine runs it. The phone app's engine has none: a phone is
// pointed at by Studio, or serves its own time.

#pragma once

#include "common.h"

#include <atomic>
#include <map>
#include <mutex>
#include <string>
#include <thread>

namespace studio
{

/// An NTP server (RFC 5905, server mode) on its own thread.
class TimeServer
{
public:
    explicit TimeServer(int port = 12300);
    ~TimeServer();

    void start();
    void stop();
    bool running() const { return thread.joinable(); }

    int port;
    /// Why the port could not be opened, or empty.
    std::string error;
    std::atomic<uint64_t> answered{0};

private:
    void serve();

    intptr_t socket = -1;
    std::thread thread;
    std::atomic<bool> stopping{false};
};

/// Points devices that follow NTP at the time master: a device that serves
/// its time, or else Studio's time server.
class TimeMaster
{
public:
    TimeMaster();

    /// Points each device of the root that follows NTP at the master, once.
    void follow(const DevicePtr& root);
    /// `{enabled, serving, port, addresses, answered, error, device}`.
    rj::Value state(Alloc& a);

    std::atomic<bool> enabled{true};
    TimeServer server;

private:
    struct Master
    {
        std::string id;
        std::string name;
        std::string address;
        std::vector<std::string> addresses;
    };

    void point(const DevicePtr& device, const std::string& server);

    std::mutex lock;
    std::map<std::string, std::string> pointed;
    bool hasMaster = false;
    Master master;
};

}  // namespace studio
