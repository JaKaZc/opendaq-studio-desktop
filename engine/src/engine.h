// The engine: one openDAQ instance and the API in front of it.
//
// Each area of the API lives in its own file under routes/ and registers its
// routes with the engine's router. A route is a function of the engine and
// the request that returns the JSON answer, or throws HttpError (fail) for a
// refusal; openDAQ's own exceptions become 502 answers.

#pragma once

#include "common.h"

#include <atomic>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <deque>
#include <initializer_list>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace studio
{

constexpr const char* kAppName = "openDAQ Studio";
constexpr const char* kAppVersion = "1.0.0";
/// The version of the API's JSON and WebSocket contract.
constexpr const char* kApiVersion = "1.0";

class Engine;
class TimeMaster;

struct Request
{
    const std::string& method;
    const std::string& path;
    const rj::Value& query;
    const rj::Value& body;
    Alloc& a;
};

using Handler = std::function<rj::Value(Engine&, const Request&)>;

/// Refuses, as 422, a body that is not an object or has members other than
/// `allowed`, since the API's request bodies are strict.
void requireOnly(const rj::Value& body, std::initializer_list<const char*> allowed);
/// An integer query parameter, `fallback` when it is missing, and a 422
/// refusal when it is not an integer or lies outside [min, max].
int64_t queryInteger(const rj::Value& query, const char* name, int64_t fallback, int64_t min = INT64_MIN, int64_t max = INT64_MAX);

class Router
{
public:
    void add(const std::string& method, const std::string& path, Handler handler);
    const Handler* find(const std::string& method, const std::string& path) const;
    bool knowsPath(const std::string& path) const;

private:
    std::map<std::string, Handler> routes;
};

// ------------------------------------------------------------------ streaming

/// How live samples are delivered.
struct StreamSettings
{
    /// Seconds between frames to a client; decimation keeps a frame within
    /// `maxPoints` while carrying at least this much input.
    double interval = 0.05;
    /// Values per signal in one frame.
    size_t maxPoints = 4000;
    /// Samples kept per signal, for history and for clients that lag.
    size_t bufferSamples = 300000;
};

/// A fixed-size ring of (tick, value) pairs with absolute sample indexing.
/// Absolute indices never wrap, which lets each client hold a plain cursor
/// and notice "I fell too far behind" with one comparison.
class SignalBuffer
{
public:
    explicit SignalBuffer(size_t capacity);
    uint64_t oldest() const { return written > capacity ? written - capacity : 0; }
    void append(const int64_t* ticks, const double* values, size_t count);
    /// Samples in the absolute range [start, end), clamped to the ring.
    void read(uint64_t start, uint64_t end, std::vector<int64_t>& ticks, std::vector<double>& values) const;

    const size_t capacity;
    /// Total samples ever written; the ring holds the last `capacity`.
    uint64_t written = 0;

private:
    std::vector<int64_t> tickRing;
    std::vector<double> valueRing;
};

/// Descriptor-derived facts a client needs to place samples in time.
struct StreamMeta
{
    std::string signalId;
    std::string name;
    std::string unit;
    bool hasUnit = false;
    std::string sampleType;
    double sampleRate = 0;
    int64_t tickNumerator = 1;
    int64_t tickDenominator = 1;
    double epochOffset = 0;
    bool hasLow = false, hasHigh = false;
    double low = 0, high = 0;
    bool timeDomain = false;
    /// The devices the signal belongs to, nearest first, for aligning devices.
    std::vector<std::string> deviceIds;

    double tickSeconds() const { return static_cast<double>(tickNumerator) / static_cast<double>(tickDenominator); }
    double tickToEpoch(int64_t tick) const { return epochOffset + static_cast<double>(tick) * tickSeconds(); }
    rj::Value toJson(Alloc& a) const;
};

/// One openDAQ reader plus its ring buffer and continuity bookkeeping.
struct SignalStream
{
    SignalStream(const SignalPtr& signal, StreamMeta meta, size_t capacity);

    SignalPtr signal;
    StreamMeta meta;
    SignalBuffer buffer;
    StreamReaderPtr reader;
    std::vector<int> subscribers;
    /// Bumped whenever continuity breaks; clients compare and reset.
    int epoch = 0;
    uint64_t totalSamples = 0;
    uint64_t droppedReads = 0;
    std::string lastError;
    bool ended = false;
    bool hasExpectedTick = false;
    int64_t expectedTick = 0;

    /// Counts samples read, for the rate the diagnostics report.
    void countSamples(uint64_t count);
    /// Samples per second over the last two seconds, rounded to a tenth.
    double samplesPerSecond() const;

private:
    std::deque<std::pair<std::chrono::steady_clock::time_point, uint64_t>> recent;
};

/// What one client wants from one signal.
struct ClientSubscription
{
    double pointsPerSecond = 4000;
    uint64_t cursor = 0;
    int epoch = -1;
    bool primed = false;
    /// Seconds of history to send when the subscription is first served.
    double primeSeconds = 1;
};

/// A client of live data: a desktop window, or the phone app as client 0.
struct StreamClient
{
    std::map<std::string, ClientSubscription> subscriptions;
    /// The subscribed signals' IDs in the order they were subscribed.
    std::vector<std::string> order;
    bool paused = false;
};

// ------------------------------------------------------------------ the engine

class Engine
{
public:
    /// `rootDevice` describes the device the instance presents itself as:
    /// localId, name, manufacturer, model and serialNumber. Other openDAQ
    /// clients see these when it is shared, and the mDNS announcement needs
    /// the manufacturer and serial.
    Engine(const std::string& moduleDirectory, const rj::Value& rootDevice);
    ~Engine();

    /// Makes a device of a loaded module, such as the phone device
    /// (android://), the instance's root, so its channels sit directly in the
    /// device other clients see. `identity` gives the root's local ID, name
    /// and serial number.
    void useAsRoot(const std::string& connection, const rj::Value& identity);

    /// Loads a module library by file name.
    void loadModule(const std::string& library);

    /// One request: the JSON answer, and its status in `status`.
    std::string handle(const std::string& method, const std::string& path, const rj::Value& query, const rj::Value& body, int& status);

    // ---------------------------------------------------------------- streaming

    StreamSettings streamSettings;

    /// A new client of live data, and its number.
    int openClient();
    void closeClient(int client);
    /// Attaches a client to signals, creating readers on demand, and returns
    /// their metadata as `{"signals": [...]}`. With `replace`, signals not
    /// listed are dropped; with `keepPrimed`, signals already subscribed carry
    /// on without a reset, as the phone app expects when it adds a signal.
    std::string subscribe(int client, const std::vector<std::string>& ids, double pointsPerSecond, double primeSeconds,
                          bool replace, bool keepPrimed, int& status);
    /// The signals a client is subscribed to, in the order it subscribed.
    std::vector<std::string> subscribedSignals(int client);
    /// Detaches a client from the signals listed, or from all of them.
    void unsubscribe(int client, const std::vector<std::string>* ids);
    void setResolution(int client, double pointsPerSecond);
    void setPaused(int client, bool paused);
    /// Drains every reader, then the client's next frame: everything new since
    /// its last frame, as one ODQV frame, or empty when nothing is new.
    std::vector<uint8_t> poll(int client);
    /// Streams and clients, for the diagnostics page.
    rj::Value streamStats(Alloc& a);
    /// Forgets streams whose signals are gone, such as with a removed device.
    void pruneStreams();

    /// Aligning devices: each device's clock minus this computer's, in
    /// seconds, taken off the times of its samples.
    std::atomic<bool> alignClocks{false};
    std::map<std::string, double> clockOffsets;
    /// Takes new clock offsets, smoothed, so one noisy measurement does not
    /// move the traces.
    void setClockOffsets(const std::map<std::string, double>& measured);
    /// Forgets the offsets, so the next ones are taken as they are.
    void clearClockOffsets();

    // ---------------------------------------------------------------- events
    //
    // Events reach the clients as `{type, seq, at, payload}`: one per core
    // event or notification, and one tree.changed for any number of
    // structural changes between two takes.

    /// The queued events as a JSON list, emptying the queue.
    std::string takeEvents();
    /// Queues one event, `{type, payload}` as JSON text.
    void pushEvent(const std::string& json);
    void publish(const std::string& type, const rj::Value& payload);
    /// An entry of the UI's event log. Notifications are also kept for
    /// GET /api/system/events.
    void notify(const std::string& message, const std::string& level = "info", const std::string& source = "backend",
                const std::optional<std::string>& detail = std::nullopt,
                const std::optional<std::string>& componentId = std::nullopt);
    /// Asks for a tree.changed with the latest reason at the next take.
    void invalidateTree(const std::string& reason = "structure");
    /// The newest notifications, oldest first.
    rj::Value eventHistory(size_t limit, Alloc& a);
    /// Hides the core events of short-lived helper components, such as the
    /// blocks added for a moment to check a signal, for `seconds`.
    void ignoreComponents(const std::vector<std::string>& ids, double seconds = 10);
    /// While a helper component is added to `folderId`, ignores whatever that
    /// folder gains: the core event of the addition arrives during the call,
    /// before the new component's ID is known. Ends with endProbe.
    void beginProbe(const std::string& folderId);
    void endProbe();

    // ---------------------------------------------------------------- pictures

    /// The newest picture of an image signal, and its number. Pictures are
    /// numbered as they arrive, so a caller that has number `known` gets
    /// nothing back until a newer one arrives. Reading starts on the first
    /// request and stops when nobody has asked for ten seconds.
    bool latestImage(const std::string& id, int64_t known, std::vector<uint8_t>& out, int64_t& sequence);

    // ---------------------------------------------------------------- the host's calls

    /// Counts a call the host made, a request or a poll, and how long it took,
    /// for the diagnostics page. `error` is a failed request's message.
    void recordCall(double seconds, bool request, const std::string& error = "");
    /// `{uptimeSeconds, iterations, workItems, errors, lastError, loopMsAvg, loopMsMax}`.
    rj::Value callStats(Alloc& a);
    /// The clients of live data and events besides the phone app's.
    int eventSubscribers();

    // ---------------------------------------------------------------- for the routes

    const std::string moduleDirectory;
    /// When the engine started, in seconds since the Unix epoch.
    const double startedAt;

    /// Studio's time server and the devices it points at it, on a computer;
    /// none in the phone app.
    std::unique_ptr<TimeMaster> timeMaster;

    InstancePtr instance;
    DevicePtr root;
    bool rootIsDevice = false;
    ContextPtr context;

    /// Whether the instance has the mDNS discovery server.
    bool announcing = false;

    /// The native streaming server while the phone shares itself.
    ServerPtr server;

    /// The NTP server each device was pointed at, by global ID, so it is
    /// pointed once and the user may choose otherwise afterwards.
    std::map<std::string, std::string> pointedAt;

    ComponentPtr findComponent(const std::string& id);
    SignalPtr findSignal(const std::string& id);
    /// The device or function block that holds a component, or the root.
    ComponentPtr holderOf(const ComponentPtr& component);
    /// Whether a device is this instance itself, reached over the network:
    /// the same maker and the same serial number as the root.
    bool isSelf(const DeviceInfoPtr& info) const;

private:
    Router router;

    struct ImageWatch
    {
        PacketReaderPtr reader;
        std::vector<uint8_t> latest;
        int64_t sequence = 0;
        std::chrono::steady_clock::time_point used;
    };
    std::mutex imageLock;
    std::map<std::string, ImageWatch> images;

    std::recursive_mutex streamLock;
    std::map<std::string, std::unique_ptr<SignalStream>> streams;
    std::map<int, StreamClient> clients;
    int nextClient = 1;

    std::mutex eventLock;
    std::vector<std::string> events;
    std::deque<std::string> history;
    uint64_t eventSequence = 0;
    bool treeChanged = false;
    std::string treeReason;
    std::map<std::string, std::chrono::steady_clock::time_point> ignored;
    std::string probeFolder;

    std::mutex callLock;
    uint64_t calls = 0;
    uint64_t requests = 0;
    uint64_t failures = 0;
    std::string lastFailure;
    std::deque<double> durations;

    std::thread timeKeeper;
    std::mutex keeperLock;
    std::condition_variable keeperWake;
    bool stopping = false;

    void onCoreEvent(const ComponentPtr& component, const CoreEventArgsPtr& args);
    void publishLocked(const std::string& type, const rj::Value& payload);
    bool isIgnored(const std::vector<std::string>& ids);
    /// Every five seconds, points new devices at the time master and, while
    /// devices are aligned, measures their clocks.
    void keepTime();
    /// The answer to a request, and for a failure of the engine's own, a
    /// 5xx, its code and message in `failure`.
    std::string answer(const std::string& method, const std::string& path, const rj::Value& query, const rj::Value& body, int& status,
                       std::string& failure);
    static std::string errorJson(const HttpError& error);

    SignalStream& ensureStream(const std::string& id, int client);
    void release(const std::string& id, int client);
    void drain(SignalStream& stream);
    void consumeEvent(SignalStream& stream);
    void endStream(SignalStream& stream, const std::string& message);
    double shiftOf(const StreamMeta& meta) const;
    bool buildBlock(const std::string& id, ClientSubscription& subscription, SignalStream& stream, size_t offset,
                    rj::Value& block, std::vector<float>& payload, Alloc& a);
};

/// JSON text of a string, quoted and escaped.
std::string quote(const std::string& text);

}  // namespace studio
