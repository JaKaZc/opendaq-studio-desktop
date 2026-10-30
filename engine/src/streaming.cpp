// Live samples: openDAQ stream readers to ODQV frames.
//
// Incremental, not snapshot. Each signal has one reader and a ring of its
// recent samples; each client holds a cursor into the ring, and only samples
// it has not seen are sent, so cost scales with the sample rate, not with the
// zoom level.
//
// Min/max decimation. When a client asks for fewer points per second than a
// signal produces, samples are grouped into buckets and each bucket is
// reduced to its min and max, the oscilloscope look, without aliasing and
// with a bounded frame size.
//
// Gaps are explicit. A jump in the domain ticks, a descriptor change or a
// client that fell out of the ring sets `reset` on the next block, so the UI
// clears instead of splicing unrelated data together.

#include "engine.h"

#include "platform.h"
#include "routes/signal_info.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace studio
{

namespace
{

/// How much more input than one frame interval produces a frame may carry,
/// so a client that fell behind catches up again.
constexpr double kCatchUp = 1.5;

double nowSeconds()
{
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
}

/// Samples per min/max bucket for one subscription.
///
/// Two limits apply. The client's resolution: no more points per second than
/// it asked for. And the frame budget: a frame carries at most `maxPoints`
/// buckets, so it must also carry at least one frame interval of input, or a
/// fast signal falls further behind with every frame.
size_t chooseDecimation(double rawRate, double pointsPerSecond, const StreamSettings& settings)
{
    if (rawRate <= 0)
        return 1;
    size_t decimation = 1;
    if (pointsPerSecond > 0)
        decimation = std::max<size_t>(1, static_cast<size_t>(std::floor(rawRate / pointsPerSecond)));
    const double needed = rawRate * std::max(settings.interval, 0.0) * kCatchUp / static_cast<double>(std::max<size_t>(1, settings.maxPoints));
    return std::max(decimation, static_cast<size_t>(std::ceil(needed)));
}

/// Seconds between consecutive samples, taken from the samples themselves,
/// which stays right when a device changes its rate mid-stream.
double sampleInterval(const std::vector<int64_t>& ticks, const StreamMeta& meta)
{
    if (ticks.size() >= 2)
    {
        double step = static_cast<double>(ticks[1] - ticks[0]);
        if (step <= 0)
            step = static_cast<double>(ticks.back() - ticks.front()) / static_cast<double>(std::max<size_t>(1, ticks.size() - 1));
        if (step > 0)
            return step * meta.tickSeconds();
    }
    if (meta.sampleRate > 0)
        return 1.0 / meta.sampleRate;
    return meta.tickSeconds();
}

/// The global IDs of the devices a signal belongs to, nearest first.
std::vector<std::string> deviceChain(const SignalPtr& signal)
{
    std::vector<std::string> chain;
    auto device = owningDevice(signal);
    while (device.assigned())
    {
        chain.push_back(safe<std::string>([&] { return device.getGlobalId().toStdString(); }, ""));
        const auto parent = safe<ComponentPtr>([&] { return device.getParent(); }, nullptr);
        device = parent.assigned() ? owningDevice(parent) : nullptr;
    }
    return chain;
}

StreamReaderPtr makeReader(const SignalPtr& signal)
{
    return StreamReader<double, int64_t>(signal, ReadMode::Scaled, ReadTimeoutType::All);
}

void writeFrame(const rj::Value& blocks, const std::vector<std::vector<float>>& payloads, std::vector<uint8_t>& frame)
{
    rj::Document doc(rj::kObjectType);
    auto& a = doc.GetAllocator();
    doc.AddMember("type", "samples", a);
    doc.AddMember("sentAt", nowSeconds(), a);
    doc.AddMember("blocks", rj::Value(blocks, a), a);
    const std::string header = toText(doc);

    size_t bytes = 0;
    for (const auto& payload : payloads)
        bytes += payload.size() * sizeof(float);
    frame.resize(10 + header.size() + bytes);
    std::memcpy(frame.data(), "ODQV", 4);
    const uint16_t version = 1;
    const uint32_t length = static_cast<uint32_t>(header.size());
    // Every platform the engine runs on is little endian, as the frame is.
    std::memcpy(frame.data() + 4, &version, 2);
    std::memcpy(frame.data() + 6, &length, 4);
    std::memcpy(frame.data() + 10, header.data(), header.size());
    size_t at = 10 + header.size();
    for (const auto& payload : payloads)
    {
        const size_t size = payload.size() * sizeof(float);
        if (size)
            std::memcpy(frame.data() + at, payload.data(), size);
        at += size;
    }
}

}  // namespace

// ------------------------------------------------------------------ ring

SignalBuffer::SignalBuffer(size_t capacity)
    : capacity(std::max<size_t>(1024, capacity))
    , tickRing(this->capacity)
    , valueRing(this->capacity)
{
}

void SignalBuffer::append(const int64_t* ticks, const double* values, size_t count)
{
    if (count == 0)
        return;
    if (count > capacity)
    {
        // One read larger than the ring: only the newest `capacity` samples are
        // kept, but `written` still advances by the full count, so clients
        // notice they fell out of the window.
        ticks += count - capacity;
        values += count - capacity;
        written += count - capacity;
        count = capacity;
    }
    const size_t start = written % capacity;
    const size_t first = std::min(count, capacity - start);
    std::copy(ticks, ticks + first, tickRing.begin() + static_cast<std::ptrdiff_t>(start));
    std::copy(values, values + first, valueRing.begin() + static_cast<std::ptrdiff_t>(start));
    if (first < count)
    {
        std::copy(ticks + first, ticks + count, tickRing.begin());
        std::copy(values + first, values + count, valueRing.begin());
    }
    written += count;
}

void SignalBuffer::read(uint64_t start, uint64_t end, std::vector<int64_t>& ticks, std::vector<double>& values) const
{
    start = std::max(start, oldest());
    end = std::min(end, written);
    ticks.clear();
    values.clear();
    if (end <= start)
        return;
    const size_t count = static_cast<size_t>(end - start);
    ticks.reserve(count);
    values.reserve(count);
    for (uint64_t i = start; i < end; i++)
    {
        ticks.push_back(tickRing[i % capacity]);
        values.push_back(valueRing[i % capacity]);
    }
}

// ------------------------------------------------------------------ metadata

rj::Value StreamMeta::toJson(Alloc& a) const
{
    rj::Value out(rj::kObjectType);
    out.AddMember("signalId", str(signalId, a), a);
    out.AddMember("name", str(name, a), a);
    out.AddMember("unit", hasUnit ? str(unit, a) : rj::Value(), a);
    out.AddMember("sampleType", sampleType.empty() ? rj::Value() : str(sampleType, a), a);
    out.AddMember("sampleRate", sampleRate > 0 ? rj::Value(sampleRate) : rj::Value(), a);
    rj::Value resolution(rj::kObjectType);
    resolution.AddMember("numerator", tickNumerator, a);
    resolution.AddMember("denominator", tickDenominator, a);
    out.AddMember("tickResolution", resolution, a);
    out.AddMember("epochOffset", epochOffset, a);
    if (hasLow || hasHigh)
    {
        rj::Value range(rj::kObjectType);
        range.AddMember("low", hasLow ? rj::Value(low) : rj::Value(), a);
        range.AddMember("high", hasHigh ? rj::Value(high) : rj::Value(), a);
        out.AddMember("valueRange", range, a);
    }
    else
        out.AddMember("valueRange", rj::Value(), a);
    out.AddMember("timeDomain", timeDomain, a);
    return out;
}

SignalStream::SignalStream(const SignalPtr& signal, StreamMeta meta, size_t capacity)
    : signal(signal)
    , meta(std::move(meta))
    , buffer(capacity)
    , reader(makeReader(signal))
{
}

// ------------------------------------------------------------------ clients

int Engine::openClient()
{
    std::lock_guard lock(streamLock);
    const int id = nextClient++;
    clients[id];
    return id;
}

void Engine::closeClient(int client)
{
    std::lock_guard lock(streamLock);
    unsubscribe(client, nullptr);
    clients.erase(client);
}

std::string Engine::subscribe(int client, const std::vector<std::string>& ids, double pointsPerSecond, double primeSeconds,
                              bool replace, bool keepPrimed, int& status)
{
    std::lock_guard lock(streamLock);
    std::vector<std::string> wanted;
    for (const auto& id : ids)
        if (!id.empty() && std::find(wanted.begin(), wanted.end(), id) == wanted.end())
            wanted.push_back(id);

    auto& state = clients[client];
    if (replace)
    {
        std::vector<std::string> dropped;
        for (const auto& [id, subscription] : state.subscriptions)
            if (std::find(wanted.begin(), wanted.end(), id) == wanted.end())
                dropped.push_back(id);
        unsubscribe(client, &dropped);
    }

    rj::Document doc;
    auto& a = doc.GetAllocator();
    rj::Value metas(rj::kArrayType);
    bool refused = false;
    HttpError firstRefusal{};
    for (const auto& id : wanted)
    {
        try
        {
            auto& stream = ensureStream(id, client);
            metas.PushBack(stream.meta.toJson(a), a);
            auto found = state.subscriptions.find(id);
            if (found != state.subscriptions.end() && keepPrimed)
            {
                found->second.pointsPerSecond = std::max(1.0, pointsPerSecond);
                continue;
            }
            if (found == state.subscriptions.end())
                state.order.push_back(id);
            auto& subscription = state.subscriptions[id];
            subscription.pointsPerSecond = std::max(1.0, pointsPerSecond);
            subscription.primeSeconds = std::max(0.0, primeSeconds);
            subscription.primed = false;
            subscription.epoch = stream.epoch;
            subscription.cursor = 0;
        }
        catch (const HttpError& error)
        {
            // A signal that cannot be streamed is left out rather than failing
            // the whole set: a measurement output has no time axis until its
            // first result, and the other signals must still stream.
            if (!refused)
                firstRefusal = error;
            refused = true;
        }
        catch (const std::exception& error)
        {
            if (!refused)
                firstRefusal = sdkError("Subscribe to signals", error);
            refused = true;
        }
    }
    if (refused && metas.Empty())
    {
        status = firstRefusal.status;
        return errorJson(firstRefusal);
    }
    status = 200;
    rj::Value out(rj::kObjectType);
    out.AddMember("signals", metas, a);
    return toText(out);
}

void Engine::unsubscribe(int client, const std::vector<std::string>* ids)
{
    std::lock_guard lock(streamLock);
    const auto found = clients.find(client);
    if (found == clients.end())
        return;
    std::vector<std::string> targets;
    if (ids)
        targets = *ids;
    else
        for (const auto& [id, subscription] : found->second.subscriptions)
            targets.push_back(id);
    auto& order = found->second.order;
    for (const auto& id : targets)
    {
        found->second.subscriptions.erase(id);
        order.erase(std::remove(order.begin(), order.end(), id), order.end());
        release(id, client);
    }
}

void Engine::setResolution(int client, double pointsPerSecond)
{
    std::lock_guard lock(streamLock);
    const auto found = clients.find(client);
    if (found == clients.end())
        return;
    for (auto& [id, subscription] : found->second.subscriptions)
        subscription.pointsPerSecond = std::max(1.0, pointsPerSecond);
}

void Engine::setPaused(int client, bool paused)
{
    std::lock_guard lock(streamLock);
    const auto found = clients.find(client);
    if (found != clients.end())
        found->second.paused = paused;
}

// ------------------------------------------------------------------ readers

SignalStream& Engine::ensureStream(const std::string& id, int client)
{
    const auto existing = streams.find(id);
    if (existing != streams.end() && !existing->second->ended)
    {
        auto& subscribers = existing->second->subscribers;
        if (std::find(subscribers.begin(), subscribers.end(), client) == subscribers.end())
            subscribers.push_back(client);
        return *existing->second;
    }

    const auto signal = signalOf(*this, id);
    const auto descriptor = descriptorOf(signal);
    const auto domain = domainDescriptorOf(signal);
    if (!isChartable(descriptor, domain))
        fail(400, "bad_request", "signal " + id + " cannot be streamed as a scalar trace",
             "only scalar numeric signals with a domain signal are supported");

    StreamMeta meta;
    meta.signalId = id;
    meta.name = safe<std::string>([&] { return signal.getName().toStdString(); }, "");
    if (meta.name.empty())
        meta.name = id;
    isSafe([&] {
        const auto unit = descriptor.getUnit();
        if (unit.assigned())
        {
            meta.unit = unit.getSymbol().toStdString();
            meta.hasUnit = true;
        }
    });
    meta.sampleType = sampleTypeText(descriptor);
    meta.sampleRate = domainSampleRate(domain);
    isSafe([&] {
        const RatioPtr resolution = domain.getTickResolution();
        meta.tickNumerator = resolution.getNumerator() ? resolution.getNumerator() : 1;
        meta.tickDenominator = resolution.getDenominator() ? resolution.getDenominator() : 1;
    });
    const auto origin = safe<std::string>([&] { return domain.getOrigin().toStdString(); }, "");
    meta.timeDomain = !origin.empty();
    double offset = 0;
    if (originSeconds(origin, offset))
        meta.epochOffset = offset;
    isSafe([&] {
        const auto range = descriptor.getValueRange();
        if (!range.assigned())
            return;
        isSafe([&] {
            meta.low = static_cast<double>(range.getLowValue());
            meta.hasLow = true;
        });
        isSafe([&] {
            meta.high = static_cast<double>(range.getHighValue());
            meta.hasHigh = true;
        });
    });
    meta.deviceIds = deviceChain(signal);

    auto stream = std::make_unique<SignalStream>(signal, std::move(meta), streamSettings.bufferSamples);
    stream->subscribers.push_back(client);
    auto& placed = streams[id];
    placed = std::move(stream);
    return *placed;
}

void Engine::release(const std::string& id, int client)
{
    const auto found = streams.find(id);
    if (found == streams.end())
        return;
    auto& subscribers = found->second->subscribers;
    subscribers.erase(std::remove(subscribers.begin(), subscribers.end(), client), subscribers.end());
    if (subscribers.empty())
        streams.erase(found);
}

void Engine::pruneStreams()
{
    std::lock_guard lock(streamLock);
    for (auto it = streams.begin(); it != streams.end();)
    {
        const bool gone = safe<bool>([&] { return static_cast<bool>(it->second->signal.isRemoved()); }, true);
        if (gone)
        {
            for (auto& [number, client] : clients)
            {
                client.subscriptions.erase(it->first);
                client.order.erase(std::remove(client.order.begin(), client.order.end(), it->first), client.order.end());
            }
            it = streams.erase(it);
        }
        else
            ++it;
    }
}

void Engine::endStream(SignalStream& stream, const std::string& message)
{
    stream.ended = true;
    stream.lastError = message;
    stream.epoch++;
    platform::log(platform::Level::Info, kTag, "Stream for %s ended: %s", stream.meta.signalId.c_str(), message.c_str());
}

/// Reads past an event packet the reader is holding. A descriptor change, such
/// as a new sample rate, reaches a reader as an event packet; until it is read
/// the reader reports no samples while not being empty, and nothing flows.
void Engine::consumeEvent(SignalStream& stream)
{
    if (safe<bool>([&] { return static_cast<bool>(stream.reader.getEmpty()); }, true))
        return;
    ReaderStatusPtr status;
    try
    {
        SizeT count = 0;
        status = stream.reader.readWithDomain(nullptr, nullptr, &count);
    }
    catch (const std::exception& error)
    {
        stream.droppedReads++;
        stream.lastError = error.what();
        return;
    }
    if (!status.assigned())
        return;
    if (status.getReadStatus() == ReadStatus::Event)
    {
        // What follows may not continue what is buffered.
        stream.epoch++;
        stream.hasExpectedTick = false;
    }
    if (!status.getValid())
    {
        // A reader that can no longer convert the signal is replaced.
        try
        {
            stream.reader = makeReader(stream.signal);
        }
        catch (const std::exception& error)
        {
            endStream(stream, std::string("the reader could not be recreated: ") + error.what());
        }
    }
}

void Engine::drain(SignalStream& stream)
{
    if (stream.ended)
        return;
    SizeT available = 0;
    try
    {
        available = stream.reader.getAvailableCount();
    }
    catch (const std::exception& error)
    {
        // A removed signal ends the stream.
        endStream(stream, error.what());
        return;
    }
    if (available == 0)
    {
        consumeEvent(stream);
        return;
    }
    std::vector<double> values(available);
    std::vector<int64_t> ticks(available);
    SizeT count = available;
    ReaderStatusPtr status;
    try
    {
        status = stream.reader.readWithDomain(values.data(), ticks.data(), &count);
    }
    catch (const std::exception& error)
    {
        stream.droppedReads++;
        stream.lastError = error.what();
        return;
    }
    if (status.assigned() && status.getReadStatus() == ReadStatus::Event)
    {
        stream.epoch++;
        stream.hasExpectedTick = false;
    }
    if (count == 0)
        return;

    if (stream.hasExpectedTick && ticks[0] != stream.expectedTick)
        // A jump in the domain: the samples about to be stored do not continue
        // the ones already buffered.
        stream.epoch++;
    const int64_t step = count > 1 ? ticks[1] - ticks[0] : 0;
    stream.hasExpectedTick = step != 0;
    stream.expectedTick = ticks[count - 1] + step;
    if (step > 0 && stream.meta.tickSeconds() > 0)
    {
        // The rate from the descriptor goes stale when the device's sample
        // rate changes; the spacing of the samples themselves is current.
        const double rate = 1.0 / (static_cast<double>(step) * stream.meta.tickSeconds());
        const double known = stream.meta.sampleRate;
        if (known <= 0 || std::abs(rate - known) > rate * 1e-6)
            stream.meta.sampleRate = rate;
    }
    stream.buffer.append(ticks.data(), values.data(), count);
    stream.totalSamples += count;
    stream.countSamples(count);
}

// ------------------------------------------------------------------ frames

double Engine::shiftOf(const StreamMeta& meta) const
{
    if (!alignClocks)
        return 0;
    for (const auto& device : meta.deviceIds)
    {
        const auto found = clockOffsets.find(device);
        if (found != clockOffsets.end())
            return found->second;
    }
    return 0;
}

void Engine::setClockOffsets(const std::map<std::string, double>& measured)
{
    std::lock_guard lock(streamLock);
    for (const auto& [device, offset] : measured)
    {
        const auto previous = clockOffsets.find(device);
        if (previous == clockOffsets.end() || std::abs(offset - previous->second) > 0.05)
            clockOffsets[device] = offset;
        else
            previous->second += 0.3 * (offset - previous->second);
    }
}

std::vector<uint8_t> Engine::poll(int client)
{
    std::lock_guard lock(streamLock);
    for (auto& [id, stream] : streams)
        drain(*stream);

    const auto found = clients.find(client);
    if (found == clients.end() || found->second.paused || found->second.subscriptions.empty())
        return {};

    rj::Document doc;
    auto& a = doc.GetAllocator();
    rj::Value blocks(rj::kArrayType);
    std::vector<std::vector<float>> payloads;
    size_t offset = 0;
    for (auto& [id, subscription] : found->second.subscriptions)
    {
        const auto stream = streams.find(id);
        if (stream == streams.end())
            continue;
        rj::Value block;
        std::vector<float> payload;
        if (!buildBlock(id, subscription, *stream->second, offset, block, payload, a))
            continue;
        offset += payload.size() * sizeof(float);
        blocks.PushBack(block, a);
        payloads.push_back(std::move(payload));
    }
    if (blocks.Empty())
        return {};
    std::vector<uint8_t> frame;
    writeFrame(blocks, payloads, frame);
    return frame;
}

bool Engine::buildBlock(const std::string& id, ClientSubscription& subscription, SignalStream& stream, size_t offset,
                        rj::Value& block, std::vector<float>& payload, Alloc& a)
{
    const auto& meta = stream.meta;
    const double rawRate = meta.sampleRate;
    bool reset = false;

    if (subscription.epoch != stream.epoch)
    {
        subscription.epoch = stream.epoch;
        subscription.primed = false;
        reset = true;
    }
    if (!subscription.primed)
    {
        // The first frame after subscribing hands over a slice of history, so
        // a freshly opened scope is not blank while the buffer fills.
        const auto history = static_cast<uint64_t>(std::max(0.0, subscription.primeSeconds * std::max(rawRate, 1.0)));
        const uint64_t written = stream.buffer.written;
        subscription.cursor = std::max(stream.buffer.oldest(), written > history ? written - history : 0);
        subscription.primed = true;
        reset = true;
    }

    const size_t decimation = chooseDecimation(rawRate, subscription.pointsPerSecond, streamSettings);
    // Never more than the frame budget in one frame.
    size_t maxSamples = std::max<size_t>(2, streamSettings.maxPoints * decimation);
    if (decimation > 1)
        maxSamples -= maxSamples % decimation;

    const uint64_t written = stream.buffer.written;
    const uint64_t oldest = stream.buffer.oldest();
    const bool dropped = subscription.cursor < oldest;
    const uint64_t start = std::max(subscription.cursor, oldest);
    const uint64_t endCursor = std::min<uint64_t>(written, start + maxSamples);
    std::vector<int64_t> ticks;
    std::vector<double> values;
    stream.buffer.read(start, endCursor, ticks, values);
    reset = reset || dropped;
    const uint64_t startCursor = endCursor - values.size();

    block.SetObject();
    if (values.empty())
    {
        if (!reset)
            return false;
        subscription.cursor = endCursor;
        block.AddMember("signalId", str(id, a), a);
        block.AddMember("mode", "reset", a);
        block.AddMember("reset", true, a);
        block.AddMember("epoch", stream.epoch, a);
        block.AddMember("byteOffset", static_cast<uint64_t>(offset), a);
        block.AddMember("byteLength", 0, a);
        block.AddMember("count", 0, a);
        block.AddMember("ended", stream.ended, a);
        return true;
    }

    const double interval = sampleInterval(ticks, meta);
    const double startTime = meta.tickToEpoch(ticks[0]) - shiftOf(meta);

    if (decimation > 1)
    {
        const size_t usable = (values.size() / decimation) * decimation;
        if (usable == 0)
        {
            // Not a full bucket yet: every sample waits for the next frame, so
            // bucket boundaries stay on the decimation grid.
            subscription.cursor = startCursor;
            return false;
        }
        const size_t buckets = usable / decimation;
        payload.reserve(buckets * 2);
        for (size_t b = 0; b < buckets; b++)
        {
            double lo = values[b * decimation], hi = lo;
            for (size_t i = b * decimation + 1; i < (b + 1) * decimation; i++)
            {
                lo = std::min(lo, values[i]);
                hi = std::max(hi, values[i]);
            }
            payload.push_back(static_cast<float>(lo));
            payload.push_back(static_cast<float>(hi));
        }
        // Whole buckets only; the remainder is read again next frame.
        subscription.cursor = startCursor + usable;
        block.AddMember("signalId", str(id, a), a);
        block.AddMember("mode", "minmax", a);
        block.AddMember("reset", reset, a);
        block.AddMember("epoch", stream.epoch, a);
        block.AddMember("startTime", startTime, a);
        block.AddMember("bucketSeconds", static_cast<double>(decimation) * interval, a);
        block.AddMember("buckets", static_cast<uint64_t>(buckets), a);
        block.AddMember("count", static_cast<uint64_t>(payload.size()), a);
        block.AddMember("byteOffset", static_cast<uint64_t>(offset), a);
        block.AddMember("byteLength", static_cast<uint64_t>(payload.size() * sizeof(float)), a);
        block.AddMember("ended", stream.ended, a);
        return true;
    }

    subscription.cursor = endCursor;
    payload.reserve(values.size());
    for (const double value : values)
        payload.push_back(static_cast<float>(value));
    block.AddMember("signalId", str(id, a), a);
    block.AddMember("mode", "raw", a);
    block.AddMember("reset", reset, a);
    block.AddMember("epoch", stream.epoch, a);
    block.AddMember("startTime", startTime, a);
    block.AddMember("sampleInterval", interval, a);
    block.AddMember("count", static_cast<uint64_t>(payload.size()), a);
    block.AddMember("byteOffset", static_cast<uint64_t>(offset), a);
    block.AddMember("byteLength", static_cast<uint64_t>(payload.size() * sizeof(float)), a);
    block.AddMember("ended", stream.ended, a);
    return true;
}

// ------------------------------------------------------------------ diagnostics

rj::Value Engine::streamStats(Alloc& a)
{
    std::lock_guard lock(streamLock);
    rj::Value list(rj::kArrayType);
    for (const auto& [id, stream] : streams)
    {
        rj::Value s(rj::kObjectType);
        s.AddMember("signalId", str(id, a), a);
        s.AddMember("name", str(stream->meta.name, a), a);
        s.AddMember("subscribers", static_cast<uint64_t>(stream->subscribers.size()), a);
        s.AddMember("totalSamples", stream->totalSamples, a);
        s.AddMember("samplesPerSecond", stream->samplesPerSecond(), a);
        s.AddMember("bufferedSamples", std::min<uint64_t>(stream->buffer.written, stream->buffer.capacity), a);
        s.AddMember("bufferCapacity", static_cast<uint64_t>(stream->buffer.capacity), a);
        s.AddMember("droppedReads", stream->droppedReads, a);
        s.AddMember("ended", stream->ended, a);
        s.AddMember("lastError", stream->lastError.empty() ? rj::Value() : str(stream->lastError, a), a);
        s.AddMember("epoch", stream->epoch, a);
        list.PushBack(s, a);
    }
    double total = 0;
    for (const auto& [id, stream] : streams)
        total += stream->samplesPerSecond();
    // The desktop windows; client 0, the phone app's, is not one.
    rj::Value byClient(rj::kObjectType);
    for (const auto& [number, client] : clients)
    {
        if (number == 0)
            continue;
        rj::Value c(rj::kObjectType);
        c.AddMember("paused", client.paused, a);
        rj::Value signals(rj::kArrayType);
        for (const auto& id : subscribedSignals(number))
            signals.PushBack(str(id, a), a);
        c.AddMember("signals", signals, a);
        byClient.AddMember(str(std::to_string(number), a), c, a);
    }
    rj::Value out(rj::kObjectType);
    out.AddMember("streams", list, a);
    out.AddMember("clients", byClient, a);
    out.AddMember("totalSamplesPerSecond", std::round(total * 10) / 10, a);
    return out;
}

}  // namespace studio
