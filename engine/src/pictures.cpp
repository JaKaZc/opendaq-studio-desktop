// Pictures from image signals, such as a phone's camera, and the Universal
// renderer's plot data.

#include "engine.h"

#include "platform.h"
#include "routes/signal_info.h"

namespace studio
{

bool Engine::latestImage(const std::string& id, int64_t known, std::vector<uint8_t>& out, int64_t& sequence)
{
    std::lock_guard guard(imageLock);
    const auto now = std::chrono::steady_clock::now();
    for (auto it = images.begin(); it != images.end();)
        it = now - it->second.used > std::chrono::seconds(10) ? images.erase(it) : std::next(it);

    // Nothing to answer has the number 0, which tells the caller to ask the
    // picture route why: the signal is gone, or does not carry pictures.
    sequence = 0;
    auto it = images.find(id);
    if (it == images.end())
    {
        const auto signal = findSignal(id);
        if (!signal.assigned() || imageFormat(descriptorOf(signal)).empty())
            return false;
        ImageWatch watch;
        watch.reader = PacketReader(signal);
        it = images.emplace(id, std::move(watch)).first;
    }
    auto& watch = it->second;
    watch.used = now;
    try
    {
        for (const auto& packet : watch.reader.readAll())
        {
            if (packet.getType() != PacketType::Data)
                continue;
            const DataPacketPtr data = packet.asPtr<IDataPacket>();
            const auto* bytes = static_cast<const uint8_t*>(data.getRawData());
            watch.latest.assign(bytes, bytes + data.getRawDataSize());
            watch.sequence++;
        }
    }
    catch (const std::exception& error)
    {
        // The signal went away, for example with its device.
        platform::log(platform::Level::Warn, kTag, "Pictures of %s: %s", id.c_str(), error.what());
        images.erase(it);
        return false;
    }
    sequence = watch.sequence;
    if (watch.latest.empty() || watch.sequence == known)
        return false;
    out = watch.latest;
    return true;
}

}  // namespace studio
