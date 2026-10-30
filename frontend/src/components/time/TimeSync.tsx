import { useEffect } from 'react';
import { AlignHorizontalJustifyStart, CheckCircle2, AlertCircle, RefreshCw, RefreshCwOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  followedDevice,
  followsStudio,
  servesTime,
  formatMs,
  formatOffset,
  reportsSync,
  roleText,
  summarize,
  syncRole,
  syncSource,
  type DeviceTime,
  type TimeMaster,
} from '../../lib/timeSync';
import { useTime } from '../../store/useTime';
import { Switch } from '../ui/Field';

/**
 * Aligns the devices in plots: each device's samples move by its clock's
 * measured offset to this computer's, so devices that are not synchronized
 * line up. The devices themselves are left as they are.
 */
export function AlignToggle() {
  const align = useTime((state) => state.align);
  const setAlign = useTime((state) => state.setAlign);
  useEffect(() => {
    void useTime.getState().refresh();
  }, []);
  return (
    <button
      type="button"
      aria-pressed={align}
      onClick={() => void setAlign(!align)}
      title={
        align
          ? "Each device's samples are moved by its clock's offset to this computer's. Click to show them as the devices stamp them."
          : "Line up devices whose clocks differ: each device's samples move by its clock's measured offset to this computer's."
      }
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap',
        align ? 'bg-accent text-white' : 'text-text-muted hover:bg-sunken hover:text-text',
      )}
    >
      <AlignHorizontalJustifyStart size={12} aria-hidden />
      Align devices
    </button>
  );
}

/** A device's role and lock as a small chip, such as "Slave · locked". */
export function SyncChip({ device, className }: { device: DeviceTime; className?: string }) {
  if (!reportsSync(device)) return null;
  const locked = device.sync?.locked === true;
  const role = syncRole(device);
  return (
    <span
      title={roleText(device)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium',
        locked ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn',
        className,
      )}
    >
      {locked ? <RefreshCw size={10} aria-hidden /> : <RefreshCwOff size={10} aria-hidden />}
      {[role, locked ? 'locked' : 'not locked'].filter(Boolean).join(' · ')}
    </span>
  );
}

/** The chip of a device by id, from the polled time state. */
export function DeviceSyncChip({ deviceId, className }: { deviceId: string; className?: string }) {
  const device = useTime((state) => state.devices.find((item) => item.id === deviceId));
  return device ? <SyncChip device={device} className={className} /> : null;
}

/** One line: whether the devices are in sync, and if not, why. */
export function TimeSummaryLine({ className }: { className?: string }) {
  const devices = useTime((state) => state.devices);
  const summary = summarize(devices);
  if (summary.devices.length === 0) return null;
  return (
    <div className={cn('flex items-start gap-1.5 text-[12px] leading-snug', summary.inSync ? 'text-ok' : 'text-warn', className)}>
      {summary.inSync ? (
        <CheckCircle2 size={13} className="mt-px shrink-0" aria-hidden />
      ) : (
        <AlertCircle size={13} className="mt-px shrink-0" aria-hidden />
      )}
      <span>{summary.text}</span>
    </div>
  );
}

/**
 * The Time card of a device in the detail panel; for the instance, every
 * device. Each row: the role and source, the clock against this computer's,
 * and the device's own words on its time.
 */
export function TimeCard({ deviceId, isInstance }: { deviceId: string; isInstance: boolean }) {
  const devices = useTime((state) => state.devices);
  const master = useTime((state) => state.master);
  const summary = summarize(devices);
  const rows = isInstance ? summary.devices : summary.devices.filter((device) => device.id === deviceId);
  if (rows.length === 0) return null;
  return (
    <section className="card p-4">
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-text-muted uppercase">Time</h3>
      <TimeSummaryLine className="mb-2" />
      <ul className="divide-y divide-border">
        {rows.map((device) => (
          <li key={device.id} className="py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{device.name}</span>
              <SyncChip device={device} />
            </div>
            <p className="mt-0.5 text-[12px] text-text-muted">
              {followsStudio(device, master)
                ? 'Slave of openDAQ Studio on this computer'
                : followedDevice(device, master)
                  ? `Slave of ${followedDevice(device, master)}, which serves its time`
                  : roleText(device)}
              .{' '}
              {device.clock
                ? `Clock ${formatOffset(device.clock.offsetMs)} against this computer, measured to ±${formatMs(device.clock.uncertaintyMs)}.`
                : 'The device does not tell its clock.'}
            </p>
            {device.detail ? <p className="text-[12px] text-text-faint">{device.detail}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Who gives a device its time, in words, from the interface it follows. */
export function masterName(device: DeviceTime, master: TimeMaster | null = null): string {
  const source = syncSource(device);
  if (!source) return 'No source';
  if (followsStudio(device, master)) return 'openDAQ Studio';
  const followed = followedDevice(device, master);
  if (followed) return followed;
  if (source.grandmaster) return `PTP grandmaster ${source.grandmaster}`;
  switch (source.name) {
    case 'NetworkTime':
      return 'NTP server';
    case 'GnssTime':
      return 'GNSS satellites';
    case 'PhoneClock':
      return "The phone's own clock";
    case 'PtpSyncInterface':
      return 'PTP network';
    case 'InterfaceClockSync':
      return 'Clock input';
    default:
      return source.name;
  }
}

function FlowBox({
  title,
  subtitle,
  tone,
  onClick,
}: {
  title: string;
  subtitle: string;
  tone: 'source' | 'ok' | 'warn';
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'min-w-0 flex-1 rounded-[8px] border border-l-4 px-2.5 py-1.5 text-left',
        tone === 'source' && 'border-brand/50 bg-sunken',
        tone === 'ok' && 'border-ok/60 bg-ok-soft',
        tone === 'warn' && 'border-warn/60 bg-warn-soft',
        onClick && 'hover:brightness-95',
      )}
    >
      <div className="truncate text-[12px] font-medium">{title}</div>
      <div className="truncate text-[11px] text-text-muted">{subtitle}</div>
    </button>
  );
}

/**
 * How time flows on the Flow page: for each device, the source it takes its
 * time from and the device, with its role, its lock and its clock against
 * this computer's. A master's arrow points from the device to the network it
 * gives time to.
 */
export function TimeFlow({ onOpen }: { onOpen?: (deviceId: string) => void }) {
  const devices = useTime((state) => state.devices);
  const master = useTime((state) => state.master);
  const setMaster = useTime((state) => state.setMaster);
  const summary = summarize(devices);
  const rows = summary.devices.filter(reportsSync);
  if (rows.length === 0 && !master) return null;
  const followers = rows.filter((device) => followsStudio(device, master)).length;
  const deviceFollowers = rows.filter((device) => followedDevice(device, master)).length;
  const follow = (count: number) => (count === 1 ? '1 device follows it.' : `${count} devices follow it.`);
  return (
    <div className="border-b border-border bg-panel px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">Time</span>
        <TimeSummaryLine />
        <span className="ml-auto" />
        <AlignToggle />
        {master ? (
          <label className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-text-muted">
            <Switch checked={master.enabled} onChange={(on) => void setMaster(on)} label="Studio is the time master" />
            Studio is the time master
          </label>
        ) : null}
      </div>
      {master?.device ? (
        <p className="mb-1.5 text-[11.5px] text-text-muted">
          {`${master.device.name} serves its time at ${master.device.address}, and the devices that follow NTP are pointed at it instead of Studio. ${follow(deviceFollowers)}`}
        </p>
      ) : master?.enabled ? (
        <p className={cn('mb-1.5 text-[11.5px]', master.serving ? 'text-text-muted' : 'text-warn')}>
          {master.serving
            ? `openDAQ Studio serves this computer's time on ${master.addresses.map((address) => `${address}:${master.port}`).join(', ') || `port ${master.port}`}, and points devices that follow NTP at it as they connect. ${follow(followers)}`
            : `openDAQ Studio cannot serve time: ${master.error ?? 'the time server is not running'}.`}
        </p>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-2">
        {rows.map((device) => {
          const locked = device.sync?.locked === true;
          // A classic master gives time on the interface it follows; a phone
          // that serves its time takes it from its source, even its own
          // clock, and gives it on.
          const passesOn = servesTime(device) && (syncSource(device)?.mode === 'Input' || (device.serves?.length ?? 0) > 0);
          const isMaster = syncRole(device) === 'Master' && !passesOn;
          const source = (
            <FlowBox title={masterName(device, master)} subtitle={device.detail || syncSource(device)?.name || ''} tone="source" />
          );
          const target = (
            <FlowBox
              title={device.name}
              subtitle={[
                syncRole(device),
                locked ? 'locked' : 'not locked',
                device.clock ? `${formatOffset(device.clock.offsetMs)} against this computer` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              tone={locked ? 'ok' : 'warn'}
              onClick={onOpen ? () => onOpen(device.id) : undefined}
            />
          );
          return (
            <div key={device.id} className="flex items-center gap-1.5">
              {isMaster ? target : source}
              <span className={cn('shrink-0 text-[14px]', locked ? 'text-ok' : 'text-warn')} aria-hidden>
                →
              </span>
              {isMaster ? source : target}
              {passesOn ? (
                <>
                  <span className="shrink-0 text-[14px] text-ok" aria-hidden>
                    →
                  </span>
                  <FlowBox title="Devices that follow it" subtitle={device.serves?.join(', ') || 'Over NTP'} tone="source" />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
