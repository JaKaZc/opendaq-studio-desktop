// studio_cli: a command line client of the engine, for tests and for checking
// a Windows build under Wine.
//
//   studio_cli '<start options JSON>'
//
// then one request per line on stdin, answered on stdout:
//
//   GET /api/modules
//   PUT /api/properties/value {"componentId":"..."} {"path":["Name"],"value":"x"}
//   subscribe ["id", ...]        the phone app's signals (client 0)
//   client                       opens a client of live data
//   client-subscribe N ["id"]    subscribes client N, answering the metadata
//   poll, poll N                 the next frame's JSON header, client 0 or N
//   sleep MS                     waits
//   events                       the queued events
//
// Each answer is one line: the status, a space, and the JSON.

#include <studio_engine.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

namespace
{

std::string take(char* text)
{
    std::string out = text ? text : "";
    studio_free(text);
    return out;
}

}  // namespace

int main(int argc, char** argv)
{
    const char* options = argc > 1 ? argv[1] : "{}";
    if (studio_start(options) != 0)
    {
        std::cerr << "start failed: " << take(studio_last_error()) << std::endl;
        return 1;
    }
    std::cout << "ready" << std::endl;

    std::string line;
    while (std::getline(std::cin, line))
    {
        if (line.empty())
            continue;
        if (line == "quit")
            break;
        if (line == "events")
        {
            std::cout << "200 " << take(studio_events()) << std::endl;
            continue;
        }
        if (line == "poll" || line.rfind("poll ", 0) == 0)
        {
            // "poll" reads the phone app's client 0, "poll N" client N. The
            // answer is the frame's JSON header.
            int length = 0;
            uint8_t* frame = line == "poll" ? studio_poll(&length) : studio_client_poll(std::stoi(line.substr(5)), &length);
            std::string header = "null";
            if (frame && length >= 10)
            {
                uint32_t size = 0;
                std::memcpy(&size, frame + 6, 4);
                header.assign(reinterpret_cast<const char*>(frame) + 10, size);
            }
            studio_free(frame);
            std::cout << "200 " << header << std::endl;
            continue;
        }
        if (line.rfind("subscribe ", 0) == 0)
        {
            studio_subscribe(line.substr(10).c_str(), 2000);
            std::cout << "200 {}" << std::endl;
            continue;
        }
        if (line == "client")
        {
            std::cout << "200 {\"client\":" << studio_client_open() << "}" << std::endl;
            continue;
        }
        if (line.rfind("client-subscribe ", 0) == 0)
        {
            // client-subscribe N <ids JSON>
            const auto rest = line.substr(17);
            const auto space = rest.find(' ');
            int status = 0;
            const auto answer = take(studio_client_subscribe(std::stoi(rest.substr(0, space)), rest.substr(space + 1).c_str(), 4000, 1, &status));
            std::cout << status << " " << answer << std::endl;
            continue;
        }
        if (line.rfind("sleep ", 0) == 0)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(std::stoi(line.substr(6))));
            std::cout << "200 {}" << std::endl;
            continue;
        }
        // METHOD PATH [QUERY [BODY]]: the query and body are JSON, the body
        // being the rest of the line after the query.
        std::istringstream in(line);
        std::string method, path, query;
        in >> method >> path;
        in >> std::ws;
        std::string rest;
        std::getline(in, rest);
        std::string body;
        if (!rest.empty())
        {
            // The query is one JSON object; find where it ends.
            int depth = 0;
            bool quoted = false;
            size_t end = 0;
            for (size_t i = 0; i < rest.size(); ++i)
            {
                const char c = rest[i];
                if (quoted)
                {
                    if (c == '\\')
                        ++i;
                    else if (c == '"')
                        quoted = false;
                    continue;
                }
                if (c == '"')
                    quoted = true;
                else if (c == '{')
                    ++depth;
                else if (c == '}' && --depth == 0)
                {
                    end = i + 1;
                    break;
                }
            }
            query = rest.substr(0, end);
            body = end < rest.size() ? rest.substr(end) : "";
        }
        int status = 0;
        const auto answer = take(studio_request(method.c_str(), path.c_str(), query.c_str(), body.c_str(), &status));
        std::cout << status << " " << answer << std::endl;
    }
    studio_stop();
    return 0;
}
