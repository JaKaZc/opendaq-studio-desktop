// Refusing to connect this instance to its own configuration server.
//
// The instance's own server shows up in discovery beside every other device,
// and openDAQ does not stop it from connecting to it. Over a configuration
// protocol that is fatal: the client mirrors the server's device tree into
// the instance, the server publishes the mirror too, and the mirror gains a
// copy of itself each round until the process runs out of memory. A
// streaming connection mirrors signals only and is fine. So the rule is
// narrow: refuse a configuration protocol, to an
// address of this machine, while this instance serves.

#include "topology_support.h"

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cctype>
#include <set>

namespace studio
{

namespace
{

std::string lower(std::string text)
{
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

std::string schemeOf(const std::string& connection)
{
    return lower(connection.substr(0, connection.find("://")));
}

/// The port of a network scheme when the connection string names none, or 0.
int defaultPort(const std::string& scheme)
{
    if (scheme == "opcua" || scheme == "daq.opcua")
        return 4840;
    if (scheme == "daq.ns" || scheme == "daq.nd")
        return 7420;
    if (scheme == "daq.lt" || scheme == "daq.wss" || scheme == "daq.ws")
        return 7414;
    return 0;
}

/// The host a connection string dials, lower-case, or empty when it names no
/// network endpoint: "daq://" names a device for discovery to resolve, and a
/// local scheme such as "daqref://" has no port.
std::string endpointHost(const std::string& connection)
{
    const std::string text = trimmed(connection);
    const auto separator = text.find("://");
    if (separator == std::string::npos || schemeOf(text) == "daq")
        return "";
    std::string authority = text.substr(separator + 3);
    authority = authority.substr(0, authority.find_first_of("/?#"));
    if (const auto at = authority.rfind('@'); at != std::string::npos)
        authority = authority.substr(at + 1);
    std::string host;
    std::string port;
    if (!authority.empty() && authority[0] == '[')
    {
        const auto close = authority.find(']');
        if (close == std::string::npos)
            return "";
        host = authority.substr(1, close - 1);
        if (close + 1 < authority.size() && authority[close + 1] == ':')
            port = authority.substr(close + 2);
    }
    else
    {
        const auto colon = authority.rfind(':');
        host = authority.substr(0, colon);
        if (colon != std::string::npos)
            port = authority.substr(colon + 1);
    }
    long number = 0;
    if (!port.empty())
    {
        if (port.size() > 5 || !std::all_of(port.begin(), port.end(), [](unsigned char c) { return std::isdigit(c); }))
            return "";
        number = std::stol(port);
        if (number > 65535)
            return "";
    }
    if (host.empty() || (number == 0 && defaultPort(schemeOf(text)) == 0))
        return "";
    return lower(host);
}

/// A host without an IPv6 zone index or brackets, for comparing.
std::string bare(const std::string& host)
{
    std::string out = host.substr(0, host.find('%'));
    out.erase(std::remove(out.begin(), out.end(), '['), out.end());
    out.erase(std::remove(out.begin(), out.end(), ']'), out.end());
    return lower(out);
}

std::string numericHost(const sockaddr* address, socklen_t length)
{
    char text[NI_MAXHOST] = "";
    if (getnameinfo(address, length, text, sizeof text, nullptr, 0, NI_NUMERICHOST) != 0)
        return "";
    return text;
}

/// Every address that means "this machine". The empty host is among them,
/// so a configuration string without a host is refused too.
std::set<std::string> localAddresses()
{
#if defined(_WIN32)
    static const bool started = [] {
        WSADATA data;
        return WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }();
    (void) started;
#endif
    std::set<std::string> hosts = {"127.0.0.1", "::1", "localhost", "0.0.0.0", ""};
    char name[256] = "";
    if (gethostname(name, sizeof name) == 0 && *name)
        for (const std::string& host : {std::string(name), std::string(name) + ".local"})
        {
            addrinfo* found = nullptr;
            if (getaddrinfo(host.c_str(), nullptr, nullptr, &found) != 0)
                continue;
            for (auto* entry = found; entry; entry = entry->ai_next)
                hosts.insert(numericHost(entry->ai_addr, static_cast<socklen_t>(entry->ai_addrlen)));
            freeaddrinfo(found);
        }
    // The address this machine would reach the outside world from, the one
    // its mDNS announcement carries. Connecting a UDP socket sends nothing.
    const auto probe = socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in target{};
    target.sin_family = AF_INET;
    target.sin_port = htons(9);
    inet_pton(AF_INET, "192.0.2.1", &target.sin_addr);
    if (connect(probe, reinterpret_cast<const sockaddr*>(&target), sizeof target) == 0)
    {
        sockaddr_in own{};
        socklen_t length = sizeof own;
        if (getsockname(probe, reinterpret_cast<sockaddr*>(&own), &length) == 0)
            hosts.insert(numericHost(reinterpret_cast<const sockaddr*>(&own), length));
    }
#if defined(_WIN32)
    closesocket(probe);
#else
    close(probe);
#endif
    std::set<std::string> out;
    for (const auto& host : hosts)
        out.insert(lower(host));
    return out;
}

std::string reason(const std::string& connection, const std::string& protocol)
{
    return connection + " is a configuration connection (" + protocol +
           ") to a server on this machine, and openDAQ Studio is serving. Connecting an instance to its own configuration "
           "server makes it mirror itself over and over until the process runs out of memory - openDAQ does not stop it, "
           "so this does. Use the streaming address of the same server (daq.ns:// or daq.lt://), which mirrors signals "
           "only, or connect from another machine.";
}

}  // namespace

std::string selfRefusal(Engine& e, const std::string& connection)
{
    const std::string text = trimmed(connection);
    // With nothing served there is nothing to connect back to.
    if (text.empty() || safe<size_t>([&] { return e.instance.getServers().getCount(); }, 0) == 0)
        return "";
    const auto local = localAddresses();
    const std::string scheme = schemeOf(text);

    if (scheme == "daq")
    {
        // The string names a device; judge the addresses discovery resolves
        // it to.
        const auto discovered = findAvailableDevice(e.root, text);
        if (!discovered.assigned())
            return "";
        for (const auto& capability : capabilitiesOf(discovered))
        {
            if (capability.protocolType.find("Configuration") == std::string::npos)
                continue;
            std::vector<std::string> endpoints = {capability.connectionString};
            for (const auto& address : capability.addresses)
                endpoints.push_back(address.second);
            for (const auto& endpoint : endpoints)
                if (local.count(bare(endpointHost(endpoint))))
                    return reason(text, capability.protocolName.empty() ? "configuration" : capability.protocolName);
        }
        return "";
    }

    static const std::set<std::string> configurationSchemes = {"daq.nd", "nd", "daq.opcua", "opcua", "daq.wsd"};
    if (!configurationSchemes.count(scheme))
        return "";
    if (local.count(bare(endpointHost(text))))
        return reason(text, scheme);
    return "";
}

}  // namespace studio
