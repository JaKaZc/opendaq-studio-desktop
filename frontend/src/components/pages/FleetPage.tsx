import { useCallback, useEffect, useState } from 'react';
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Cpu,
  ExternalLink,
  LayoutDashboard,
  Pause,
  Play,
  Thermometer,
  Wifi,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { FleetDevice } from '../../lib/fleet';
import { formatOffset } from '../../lib/timeSync';
import type { OperationMode } from '../../lib/types';
import { cn } from '../../lib/utils';
import { go } from '../../store/useNav';
import { useSession } from '../../store/useSession';
import { SyncChip } from '../time/TimeSync';

/**
 * Every connected device at a glance: its connection, mode, status, channels
 * and time, and for a phone its battery, temperature, processor, Wi-Fi and
 * Dashboard. Run all and Idle all set every device's operation mode at once.
 * The page reads the fleet every three seconds while it is shown.
 */
export function FleetPage() {
  const [devices, setDevices] = useState<FleetDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const select = useSession((state) => state.select);
  const reportError = useSession((state) => state.reportError);

  const refresh = useCallback(async () => {
    try {
      setDevices((await api.topology.fleet()).devices);
    } catch {
      // The next round tries again.
    }
  }, []);

  useEffect(() => {
    // The first read right away, then every three seconds.
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const setMode = async (targets: FleetDevice[], mode: OperationMode) => {
    setBusy(true);
    try {
      for (const device of targets) {
        if (device.operationModes.includes(mode)) await api.topology.setOperationMode(device.id, mode);
      }
      await refresh();
    } catch (error) {
      reportError(error, 'Could not change the operation mode');
    } finally {
      setBusy(false);
    }
  };

  const list = devices ?? [];
  const connected = list.filter((device) => device.connected).length;
  const running = list.filter((device) => device.operationMode === 'Operation' || device.operationMode === 'SafeOperation').length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">Fleet</span>
        <span className="text-[12px] text-text-muted">
          {list.length === 1 ? '1 device' : `${list.length} devices`} · {connected} connected · {running} running
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy || list.length === 0}
            onClick={() => void setMode(list, 'Operation')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50"
          >
            <Play size={12} aria-hidden /> Run all
          </button>
          <button
            type="button"
            disabled={busy || list.length === 0}
            onClick={() => void setMode(list, 'Idle')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-3 text-[12px] font-medium hover:border-border-strong disabled:opacity-50"
          >
            <Pause size={12} aria-hidden /> Idle all
          </button>
        </div>
      </div>

      {devices === null ? (
        <p className="p-6 text-[13px] text-text-muted">Reading the devices…</p>
      ) : list.length === 0 ? (
        <p className="p-6 text-[13px] text-text-muted">No device is connected. Add one with Add in the header.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3 p-4">
          {list.map((device) => (
            <FleetCard
              key={device.id}
              device={device}
              busy={busy}
              onMode={(mode) => void setMode([device], mode)}
              onOpen={() => {
                void select(device.id);
                go('devices');
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BatteryIcon({ level, charging }: { level: number | null | undefined; charging: boolean }) {
  if (charging) return <BatteryCharging size={14} aria-hidden />;
  if (level == null) return <BatteryMedium size={14} aria-hidden />;
  if (level < 20) return <BatteryLow size={14} className="text-err" aria-hidden />;
  if (level > 80) return <BatteryFull size={14} aria-hidden />;
  return <BatteryMedium size={14} aria-hidden />;
}

function Reading({ icon, label, value, warn }: { icon: React.ReactNode; label: string; value: string; warn?: boolean }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-[12px]', warn ? 'text-warn' : 'text-text')} title={label}>
      <span className="text-text-muted">{icon}</span>
      <span className="num tabular">{value}</span>
    </div>
  );
}

function FleetCard({
  device,
  busy,
  onMode,
  onOpen,
}: {
  device: FleetDevice;
  busy: boolean;
  onMode: (mode: OperationMode) => void;
  onOpen: () => void;
}) {
  const system = device.system;
  const level = system?.BatteryLevel;
  const charging = (system?.Charging ?? 0) > 0.5;
  const temperature = system?.BatteryTemperature;
  const cpu = system?.Cpu;
  const wifi = system?.WifiSignal;
  const statusColour = device.status.level === 'Error' ? 'bg-err' : device.status.level === 'Warning' ? 'bg-warn' : 'bg-ok';
  const modeLabel = (mode: OperationMode) => (mode === 'SafeOperation' ? 'Safe' : mode);

  return (
    <section className="card flex flex-col gap-2.5 p-4">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', device.connected ? statusColour : 'bg-text-faint')} aria-hidden />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left text-[14px] font-semibold hover:text-accent">
            {device.name}
          </button>
          <div className="truncate text-[11.5px] text-text-faint">
            {[device.manufacturer, device.model].filter(Boolean).join(' ') || device.connectionString}
          </div>
        </div>
        {device.time ? <SyncChip device={device.time} /> : null}
      </div>

      {!device.connected ? <p className="text-[12px] text-err">Disconnected.</p> : null}
      {device.status.message ? <p className="text-[12px] text-warn">{device.status.message}</p> : null}

      {system ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-[8px] bg-sunken px-3 py-2">
          <Reading
            icon={<BatteryIcon level={level} charging={charging} />}
            label="Battery"
            value={level == null ? 'n/a' : `${level.toFixed(0)} %${system.BatteryPower != null && charging ? ` · ${system.BatteryPower.toFixed(1)} W` : ''}`}
            warn={level != null && level < 20 && !charging}
          />
          <Reading
            icon={<Thermometer size={14} aria-hidden />}
            label="Battery temperature"
            value={temperature == null ? 'n/a' : `${temperature.toFixed(1)} °C`}
            warn={temperature != null && temperature > 40}
          />
          <Reading icon={<Cpu size={14} aria-hidden />} label="Processor time of the app" value={cpu == null ? 'n/a' : `${cpu.toFixed(1)} %`} />
          <Reading
            icon={<Wifi size={14} aria-hidden />}
            label="Wi-Fi signal"
            value={wifi == null ? 'n/a' : `${wifi.toFixed(0)} dBm`}
            warn={wifi != null && wifi < -75}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
        <span>
          {device.channels.active} of {device.channels.total} channels active
        </span>
        {device.time?.clock ? <span>Clock {formatOffset(device.time.clock.offsetMs)}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {device.operationModes.length > 0 ? (
          <div className="inline-flex overflow-hidden rounded-full border border-border" role="group" aria-label="Operation mode">
            {device.operationModes
              .filter((mode) => mode !== 'Unknown')
              .map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={busy}
                  onClick={() => onMode(mode)}
                  className={cn(
                    'px-2.5 py-1 text-[11.5px]',
                    device.operationMode === mode ? 'bg-accent text-white' : 'text-text-muted hover:text-text',
                  )}
                >
                  {modeLabel(mode)}
                </button>
              ))}
          </div>
        ) : null}
        {device.dashboard?.addresses[0] ? (
          <a
            href={device.dashboard.addresses[0]}
            target="_blank"
            rel="noreferrer"
            title={device.dashboard.pin ? `PIN for changes: ${device.dashboard.pin}` : undefined}
            className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
          >
            <LayoutDashboard size={12} aria-hidden /> Dashboard
            {device.dashboard.pin ? <span className="text-text-faint"> · PIN {device.dashboard.pin}</span> : null}
            <ExternalLink size={11} aria-hidden />
          </a>
        ) : null}
      </div>
    </section>
  );
}
