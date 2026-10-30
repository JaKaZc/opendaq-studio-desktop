import { useMemo, useState } from 'react';
import { AlertCircle, Check, Info, Plus, RefreshCw, Search, Star } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { cn, loadPreference, savePreference } from '../../lib/utils';
import type { ConnectionPlan } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Field, Input, Select } from '../ui/Field';
import { Badge, EmptyState, InfoRow, Spinner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { Tabs } from '../ui/Layout';
import { ConfigEditor, ConfigSummary, type ConfigValues } from './ConfigEditor';

const RECENT_KEY = 'recent-connections';
const MAX_RECENT = 12;

/**
 * Connect a device.
 *
 * Three ways in, because that is how people actually work:
 * 1. pick a discovered device,
 * 2. paste a connection string,
 * 3. re-use one that worked before (kept in this browser).
 *
 * The advanced tab mirrors the SDK's own connection configuration - which
 * configuration protocol to use, which address family, which streaming protocols
 * to allow - driven by whatever the backend reports for the entered string, so it
 * only ever offers combinations the SDK considers legal.
 */
export function AddDeviceDialog({
  parentId,
  initialConnectionString,
}: {
  parentId: string | null;
  /** Filled in when the dialog was opened by a command such as "connect daqref://device0". */
  initialConnectionString?: string;
}) {
  const close = useDialogs((state) => state.close);
  const openDialog = useDialogs((state) => state.open);
  const reportError = useSession((state) => state.reportError);

  const [tab, setTab] = useState<'discover' | 'manual' | 'advanced'>(initialConnectionString ? 'manual' : 'discover');
  const [connectionString, setConnectionString] = useState(initialConnectionString ?? '');
  const [query, setQuery] = useState('');
  const [values, setValues] = useState<ConfigValues>({});
  const [connecting, setConnecting] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadPreference<string[]>(RECENT_KEY, []));

  // --- discovery ---------------------------------------------------------
  const {
    data: devices,
    loading: scanning,
    reload: scan,
  } = useAsyncData(
    (signal) => api.topology.discover(parentId ?? undefined, signal).then((r) => r.devices),
    [parentId],
    { onError: (error) => reportError(error, 'Discovery failed') },
  );

  // --- connection plan ---------------------------------------------------
  // Debounced, because each request runs a discovery match on the backend. The
  // plan is *derived* from the settled text, so clearing the field clears the
  // plan without any imperative reset.
  const settledConnectionString = useDebouncedValue(connectionString.trim(), 350);
  const { data: planData, loading: planLoading } = useAsyncData(
    (signal) => api.topology.connectionPlan(settledConnectionString, parentId ?? undefined, signal),
    [settledConnectionString, parentId],
    { enabled: settledConnectionString.length > 0 },
  );
  const plan = settledConnectionString ? planData : null;

  const filteredDevices = useMemo(() => {
    if (!devices) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter(
      (device) =>
        device.name.toLowerCase().includes(needle) ||
        device.connectionString.toLowerCase().includes(needle) ||
        device.manufacturer.toLowerCase().includes(needle) ||
        device.model.toLowerCase().includes(needle),
    );
  }, [devices, query]);

  const rememberConnection = (value: string) => {
    const next = [value, ...recent.filter((entry) => entry !== value)].slice(0, MAX_RECENT);
    setRecent(next);
    savePreference(RECENT_KEY, next);
  };

  const connect = async () => {
    const trimmed = connectionString.trim();
    if (!trimmed) return;
    setConnecting(true);
    const result = await actions.addDevice(trimmed, parentId, Object.keys(values).length ? values : undefined);
    setConnecting(false);
    if (!result) return;

    rememberConnection(trimmed);
    if (result.ignoredConfigKeys.length > 0) {
      useSession
        .getState()
        .notify(
          'warning',
          'Some configuration settings were ignored',
          result.ignoredConfigKeys.join(', '),
        );
    }
    void useSession.getState().select(result.componentId);

    if (keepOpen) {
      setConnectionString('');
      setValues({});
      scan();
    } else {
      close();
    }
  };

  const blocked = (plan?.errors.length ?? 0) > 0;
  const canConnect = connectionString.trim().length > 0 && !connecting && !blocked;

  return (
    <Modal
      open
      onClose={close}
      title="Add device"
      description="Connect a device to this openDAQ instance."
      size="lg"
      persistent
      footer={
        <>
          <Checkbox checked={keepOpen} onChange={setKeepOpen} label="Keep open after connecting" />
          <span className="flex-1" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<Plus size={12} />} loading={connecting} disabled={!canConnect} onClick={connect}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Connection string"
          hint={plan?.impliedProtocol ? `protocol: ${plan.impliedProtocol}` : undefined}
          error={plan?.errors[0]}
        >
          <div className="flex items-center gap-1.5">
            <Input
              data-autofocus
              mono
              value={connectionString}
              onChange={(event) => setConnectionString(event.target.value)}
              placeholder="daqref://device0  ·  daq.nd://192.168.1.20  ·  daq://openDAQ_serial"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canConnect) void connect();
              }}
              invalid={blocked}
            />
            {planLoading ? <Spinner size={14} className="shrink-0 text-text-faint" /> : null}
            {plan && !planLoading && !blocked ? (
              <Check size={15} className="shrink-0 text-ok" aria-label="Connection string looks valid" />
            ) : null}
            {blocked ? <AlertCircle size={15} className="shrink-0 text-err" aria-hidden /> : null}
          </div>
        </Field>

        <Tabs
          ariaLabel="How to find the device"
          active={tab}
          size="sm"
          onChange={(id) => setTab(id as typeof tab)}
          tabs={[
            {
              id: 'discover',
              label: 'Discovered',
              badge: devices ? <Badge>{devices.length}</Badge> : undefined,
            },
            { id: 'manual', label: 'Recent', badge: recent.length ? <Badge>{recent.length}</Badge> : undefined },
            {
              id: 'advanced',
              label: 'Connection options',
              hint: 'Configuration and streaming protocols',
              disabled: !plan,
            },
          ]}
        />

        {tab === 'discover' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Search
                  size={12}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-faint"
                />
                <Input
                  size="sm"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter discovered devices…"
                  aria-label="Filter discovered devices"
                  className="pl-6.5"
                />
              </div>
              <Button size="sm" icon={<RefreshCw size={12} className={scanning ? 'animate-spin' : undefined} />} onClick={scan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan again'}
              </Button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-border">
              {scanning && !devices ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-text-muted">
                  <Spinner size={14} /> Looking for devices…
                </div>
              ) : filteredDevices.length === 0 ? (
                <EmptyState
                  title={query ? 'No matching devices' : 'No devices found'}
                  description={
                    query
                      ? 'Try a shorter filter.'
                      : 'Nothing answered discovery. Enter a connection string above, or check that the device and this host are on the same network.'
                  }
                />
              ) : (
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-sunken text-left text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
                      <th scope="col" className="px-2 py-1">
                        Device
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Location
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Connection string
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Protocols
                      </th>
                      <th scope="col" className="w-8 px-1 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDevices.map((device) => {
                      const selected = device.connectionString === connectionString;
                      return (
                        <tr
                          key={device.connectionString}
                          onClick={() => setConnectionString(device.connectionString)}
                          onDoubleClick={() => {
                            setConnectionString(device.connectionString);
                            void connect();
                          }}
                          className={cn(
                            'cursor-default border-b border-border/60',
                            'row-hover',
                            selected && 'row-selected',
                            // This viewer's own server. It is listed because it
                            // really is discoverable, but connecting to it over a
                            // configuration protocol makes the instance mirror
                            // itself until the process dies.
                            device.isSelf && 'opacity-60',
                          )}
                        >
                          <th scope="row" className="max-w-0 px-2 py-1 text-left font-normal">
                            <span
                              className="flex min-w-0 items-center gap-1.5"
                              title={`${device.manufacturer} ${device.model}`.trim()}
                            >
                              <span className="truncate">
                                {device.name || device.model || 'Unnamed device'}
                              </span>
                              {device.isSelf ? (
                                <Badge tone="warn" title={device.selfReason}>
                                  this instance
                                </Badge>
                              ) : null}
                            </span>
                          </th>
                          <td className="max-w-0 px-2 py-1 text-text-muted">
                            <span className="block truncate">{device.location || '—'}</span>
                          </td>
                          <td className="max-w-0 px-2 py-1">
                            <span className="block truncate font-mono text-[11px]">
                              {device.connectionString}
                            </span>
                          </td>
                          <td className="px-2 py-1">
                            <span className="flex flex-wrap gap-1">
                              {device.serverCapabilities.length === 0 ? (
                                <span className="text-text-faint">local</span>
                              ) : (
                                device.serverCapabilities.slice(0, 3).map((capability) => (
                                  <Badge key={capability.protocolId} title={capability.protocolName}>
                                    {capability.protocolId.replace('OpenDAQ', '')}
                                  </Badge>
                                ))
                              )}
                            </span>
                          </td>
                          <td className="px-1 py-0.5">
                            <IconButton
                              label="Device information"
                              size="sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDialog({
                                  kind: 'deviceInfo',
                                  connectionString: device.connectionString,
                                  parentId,
                                });
                              }}
                            >
                              <Info size={12} />
                            </IconButton>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'manual' ? (
          <div className="rounded-[var(--radius-control)] border border-border">
            {recent.length === 0 ? (
              <EmptyState
                icon={<Star size={18} aria-hidden />}
                title="No recent connections"
                description="Connection strings you use are remembered in this browser so you can reconnect with one click."
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {recent.map((entry) => (
                  <li key={entry} className="flex items-center gap-2 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => setConnectionString(entry)}
                      onDoubleClick={() => {
                        setConnectionString(entry);
                        void connect();
                      }}
                      className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] hover:text-accent"
                    >
                      {entry}
                    </button>
                    <IconButton
                      label="Forget this connection"
                      size="sm"
                      onClick={() => {
                        const next = recent.filter((item) => item !== entry);
                        setRecent(next);
                        savePreference(RECENT_KEY, next);
                      }}
                    >
                      ×
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === 'advanced' && plan ? (
          <ConnectionOptions plan={plan} values={values} onChange={setValues} />
        ) : null}

        {plan?.deviceInfo ? (
          <dl className="rounded-[var(--radius-control)] bg-sunken px-2.5 py-2">
            <InfoRow label="Manufacturer">{plan.deviceInfo.manufacturer || '—'}</InfoRow>
            <InfoRow label="Model">{plan.deviceInfo.model || '—'}</InfoRow>
            <InfoRow label="Serial number" mono>
              {plan.deviceInfo.serialNumber || '—'}
            </InfoRow>
            <InfoRow label="SDK version" mono>
              {plan.deviceInfo.sdkVersion || '—'}
            </InfoRow>
          </dl>
        ) : null}
      </div>
    </Modal>
  );
}

/** Configuration protocol, address family, streaming protocols and the config tree. */
function ConnectionOptions({
  plan,
  values,
  onChange,
}: {
  plan: ConnectionPlan;
  values: ConfigValues;
  onChange: (values: ConfigValues) => void;
}) {
  // Which Device.<protocol> subsection is relevant. This is a *view* choice, not
  // a config value: the backend derives the protocol from the connection string,
  // and only the settings under the chosen section are worth showing.
  const [configProtocol, setConfigProtocol] = useState(plan.impliedProtocol ?? plan.configProtocols[0] ?? '');
  const streamingKey = 'General.AllowedStreamingProtocols';
  const addressKey = 'General.PrimaryAddressType';
  const autoConnectKey = 'General.AutomaticallyConnectStreaming';

  const allowed = Array.isArray(values[streamingKey])
    ? (values[streamingKey] as string[])
    : plan.streamingProtocols;

  const toggleStreaming = (protocol: string) => {
    const next = allowed.includes(protocol)
      ? allowed.filter((entry) => entry !== protocol)
      : [...allowed, protocol];
    onChange({ ...values, [streamingKey]: next });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Configuration protocol"
          hint={plan.configProtocols.length === 0 ? 'streaming only' : undefined}
        >
          <Select
            size="sm"
            value={configProtocol}
            disabled={plan.configProtocols.length <= 1}
            aria-label="Configuration protocol"
            onChange={(event) => setConfigProtocol(event.target.value)}
          >
            {plan.configProtocols.length === 0 ? <option value="">Streaming only</option> : null}
            {plan.configProtocols.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocol}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Address family" hint={plan.hasTcpIp ? undefined : 'not a TCP/IP device'}>
          <Select
            size="sm"
            value={String(values[addressKey] ?? '')}
            disabled={plan.addressTypes.length === 0}
            aria-label="Address family"
            onChange={(event) => onChange({ ...values, [addressKey]: event.target.value })}
          >
            <option value="">Device default</option>
            {plan.addressTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {plan.hasStreaming && plan.streamingProtocols.length > 0 ? (
        <Field label="Streaming protocols" hint="data path used once the device is connected">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-[var(--radius-control)] border border-border px-2.5 py-2">
            {plan.streamingProtocols.map((protocol) => (
              <Checkbox
                key={protocol}
                checked={allowed.includes(protocol)}
                onChange={() => toggleStreaming(protocol)}
                label={protocol.replace('OpenDAQ', '')}
              />
            ))}
            <Checkbox
              checked={values[autoConnectKey] === undefined ? true : Boolean(values[autoConnectKey])}
              onChange={(next) => onChange({ ...values, [autoConnectKey]: next })}
              label="Connect streaming automatically"
            />
          </div>
        </Field>
      ) : null}

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
          All configuration options
        </span>
        <ConfigSummary values={values} onClear={() => onChange({})} />
      </div>

      <div className="max-h-64 overflow-y-auto">
        <ConfigEditor
          tree={plan.config}
          values={values}
          onChange={onChange}
          hiddenPaths={[
            streamingKey,
            addressKey,
            autoConnectKey,
            // Other protocols' sections would be dead weight in the tree.
            ...plan.configProtocols
              .filter((protocol) => protocol !== configProtocol)
              .map((protocol) => `Device.${protocol}`),
            ...plan.streamingProtocols
              .filter((protocol) => !allowed.includes(protocol))
              .map((protocol) => `Streaming.${protocol}`),
          ]}
        />
      </div>
    </div>
  );
}
