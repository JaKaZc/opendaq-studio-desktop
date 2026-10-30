// The devices' clocks and time sources, which GET /api/time reports and the
// time master and aligned plots use.

#pragma once

#include "common.h"

#include <map>
#include <string>
#include <vector>

namespace studio
{

/// A device and every device below it, depth first.
void collectDevices(const DevicePtr& device, std::vector<DevicePtr>& out);

/// The device's clock minus this computer's, and how exactly that was
/// measured, in milliseconds. False when the device has no clock.
bool measureClock(const DevicePtr& device, double& offsetMs, double& uncertaintyMs);

/// Each device's clock offset in seconds, by global ID, for the devices
/// below `root` that have a clock.
std::map<std::string, double> measureOffsets(const DevicePtr& root);

/// Where a device that serves its time, such as a phone with ServeTime on,
/// is reached as an NTP server; empty for one that does not.
std::vector<std::string> servedAddresses(const DevicePtr& device);

/// The host of a connection string such as daq.nd://192.168.1.21:7420.
std::string hostOf(const std::string& connection);

}  // namespace studio
