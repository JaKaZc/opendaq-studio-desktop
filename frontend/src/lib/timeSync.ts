/**
 * The devices' synchronization and clocks (`GET /api/time`), and what they say
 * together: whether the devices are in sync, and who is master or slave.
 */

export interface SyncInterface {
  name: string;
  selected: boolean;
  /** Input: the device takes its time from it. Output: it gives time on it. */
  mode: 'Input' | 'Output' | 'Auto' | 'Off';
  state?: 'Ok' | 'Error' | 'Warning';
  grandmaster?: string;
}

/** Studio as the time master: its NTP server and the addresses devices reach it at. */
export interface TimeMaster {
  enabled: boolean;
  serving: boolean;
  port: number;
  addresses: string[];
  answered: number;
  error: string | null;
  /** A device that serves its time, such as a phone with ServeTime on, which the others follow instead. */
  device?: { id: string; name: string; address: string; addresses: string[] } | null;
}

/** Whether a device follows Studio's own time server. */
export function followsStudio(device: DeviceTime, master: TimeMaster | null): boolean {
  if (!master || !device.detail || syncSource(device)?.name !== 'NetworkTime') return false;
  return master.addresses.some((address) => device.detail!.includes(`${address}:${master.port}`));
}

/** The device that serves the time a device follows, if it follows one. */
export function followedDevice(device: DeviceTime, master: TimeMaster | null): string | null {
  const server = master?.device;
  if (!server || server.id === device.id || !device.detail || syncSource(device)?.name !== 'NetworkTime') return null;
  return server.addresses.some((address) => device.detail!.includes(address)) ? server.name : null;
}

/** Whether a device gives its time to others on one of its interfaces. */
export function servesTime(device: DeviceTime): boolean {
  return device.sync?.interfaces.some((item) => item.mode === 'Output') ?? false;
}

export interface DeviceTime {
  id: string;
  name: string;
  isRoot: boolean;
  sync?: { locked: boolean; interfaces: SyncInterface[] };
  /** The device's own words on its time, such as the phone device's TimeStatus. */
  detail?: string;
  /** The device's clock minus this computer's, and how exactly it was measured. */
  clock?: { offsetMs: number; uncertaintyMs: number };
  /** Where a device that serves its time is reached as an NTP server. */
  serves?: string[];
}

/** Whether the device reports a synchronization at all. */
export function reportsSync(device: DeviceTime): boolean {
  return (device.sync?.interfaces.length ?? 0) > 0;
}

export function syncSource(device: DeviceTime): SyncInterface | undefined {
  return device.sync?.interfaces.find((item) => item.selected);
}

/**
 * Slave when it takes its time from its source, master when it gives time on
 * any interface; a phone that serves its time is a master whatever its own
 * time follows.
 */
export function syncRole(device: DeviceTime): 'Slave' | 'Master' | 'Automatic' | null {
  if (servesTime(device)) return 'Master';
  switch (syncSource(device)?.mode) {
    case 'Input':
      return 'Slave';
    case 'Output':
      return 'Master';
    case 'Auto':
      return 'Automatic';
    default:
      return null;
  }
}

/** The role and source in words, such as "Slave of NetworkTime". */
export function roleText(device: DeviceTime): string {
  const source = syncSource(device);
  if (!source) return reportsSync(device) ? 'No source is selected' : 'Reports no synchronization';
  const grandmaster = source.grandmaster ? `, grandmaster ${source.grandmaster}` : '';
  const output = device.sync?.interfaces.find((item) => item.mode === 'Output');
  if (output && source.mode === 'Input') return `Master on ${output.name}, its own time from ${source.name}${grandmaster}`;
  switch (syncRole(device)) {
    case 'Slave':
      return `Slave of ${source.name}${grandmaster}`;
    case 'Master':
      return `Master on ${source.name}${grandmaster}`;
    case 'Automatic':
      return `Master or slave on ${source.name}${grandmaster}`;
    default:
      return `Source ${source.name}${grandmaster}`;
  }
}

export function formatMs(ms: number): string {
  const size = Math.abs(ms);
  if (size >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (size >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(1)} ms`;
}

/** A signed offset, such as +0.4 ms. */
export function formatOffset(ms: number): string {
  return `${ms >= 0 ? '+' : '−'}${formatMs(Math.abs(ms))}`;
}

/**
 * Clocks within this many milliseconds, beyond what the measurement can tell,
 * count as in sync. Devices that follow NTP each are a few milliseconds apart;
 * the summary always says by how much.
 */
export const TOLERANCE_MS = 5;

export interface TimeSummary {
  devices: DeviceTime[];
  inSync: boolean;
  text: string;
  /** The largest difference between two clocks, and how exactly they were measured. */
  spreadMs: number | null;
  precisionMs: number | null;
}

export function summarize(all: DeviceTime[]): TimeSummary {
  const devices = all.filter((device) => reportsSync(device) || device.clock);
  if (devices.length === 0) return { devices, inSync: false, text: 'No device reports its time.', spreadMs: null, precisionMs: null };
  const clocks = devices.filter((device) => device.clock).sort((a, b) => a.clock!.offsetMs - b.clock!.offsetMs);
  const unlocked = devices.filter((device) => reportsSync(device) && device.sync?.locked === false);
  const earliest = clocks[0];
  const latest = clocks[clocks.length - 1];
  let spread: number | null = null;
  let precision: number | null = null;
  if (clocks.length >= 2 && earliest && latest) {
    spread = latest.clock!.offsetMs - earliest.clock!.offsetMs;
    precision = Math.max(...clocks.map((device) => device.clock!.uncertaintyMs)) * 2;
  }
  const apart = spread !== null && spread > TOLERANCE_MS + (precision ?? 0);
  const problems = [
    ...unlocked.map((device) => `${device.name} is not locked to its source.`),
    ...(apart && earliest && latest ? [`${latest.name} is ${formatMs(spread!)} ahead of ${earliest.name}.`] : []),
  ];
  if (problems.length > 0) return { devices, inSync: false, text: problems.join(' '), spreadMs: spread, precisionMs: precision };
  const count = devices.length === 1 ? '1 device' : `${devices.length} devices`;
  const text =
    spread === null
      ? `In sync: ${count} locked to its source.`
      : `In sync: the clocks of ${count} agree within ${formatMs(spread)}, measured to ±${formatMs((precision ?? 0) / 2)}.`;
  return { devices, inSync: true, text, spreadMs: spread, precisionMs: precision };
}
