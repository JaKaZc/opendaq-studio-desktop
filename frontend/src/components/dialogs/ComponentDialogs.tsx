import { useState } from 'react';
import { Copy } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { usePolling } from '../../lib/usePolling';
import {
  formatDaqValue,
  formatEngineering,
  formatSampleRate,
  isEnumerationValue,
} from '../../lib/format';
import { copyToClipboard } from '../../lib/utils';
import type { DataDescriptor, StatusSummary } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button, IconButton } from '../ui/Button';
import { CommitInput, Switch } from '../ui/Field';
import { Badge, EmptyState, InfoRow, Spinner, StatusDot, statusTone } from '../ui/Feedback';
import { Modal } from '../ui/Modal';

/**
 * Attribute editor.
 *
 * openDAQ marks some attributes as locked per component, and a device can lock
 * anything - so the dialog reads `lockedAttributes` and disables those rows rather
 * than letting the user discover the restriction through a failed write.
 */
export function AttributesDialog({ componentId }: { componentId: string }) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const {
    data: attributes,
    loading,
    setData: setAttributes,
  } = useAsyncData(
    (signal) => api.components.attributes(componentId, signal).then((r) => r.attributes),
    [componentId],
    { onError: (error) => reportError(error, 'Could not read attributes') },
  );

  // The write endpoint returns the full attribute list, so the dialog updates
  // from the response rather than refetching.
  const write = async (key: string, value: unknown) => {
    const result = await actions.setAttribute(componentId, key, value as never);
    if (result) setAttributes(result.attributes);
  };

  return (
    <Modal
      open
      onClose={close}
      title="Attributes"
      description={componentId}
      size="md"
      footer={<Button onClick={close}>Close</Button>}
    >
      {loading && !attributes ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : !attributes ? (
        <EmptyState title="No attributes" />
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <tbody>
            {attributes.map((attribute) => (
              <tr key={attribute.key} className="border-b border-border/60 last:border-b-0">
                <th scope="row" className="w-40 px-1 py-1.5 text-left font-normal text-text-muted">
                  {attribute.label}
                  {attribute.locked ? (
                    <Badge className="ml-1.5" title="This component does not allow changing it">
                      locked
                    </Badge>
                  ) : null}
                </th>
                <td className="px-1 py-1">
                  {attribute.valueType === 'bool' ? (
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={Boolean(attribute.value)}
                        disabled={attribute.locked}
                        label={attribute.label}
                        onChange={(next) => void write(attribute.key, next)}
                      />
                      <span className="text-[11.5px] text-text-muted">
                        {attribute.value ? 'Yes' : 'No'}
                      </span>
                    </div>
                  ) : attribute.valueType === 'list' ? (
                    <CommitInput
                      value={(Array.isArray(attribute.value) ? attribute.value : []).join(', ')}
                      disabled={attribute.locked}
                      mono={false}
                      align="left"
                      ariaLabel={attribute.label}
                      onCommit={(next) =>
                        void write(
                          attribute.key,
                          next
                            .split(',')
                            .map((part) => part.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  ) : attribute.locked ? (
                    <span className="num flex items-center gap-1.5 break-all text-text-muted">
                      {formatDaqValue(attribute.value) || '—'}
                      {String(attribute.value ?? '').length > 0 ? (
                        <IconButton
                          label="Copy"
                          size="sm"
                          onClick={() => void copyToClipboard(String(attribute.value))}
                        >
                          <Copy size={11} />
                        </IconButton>
                      ) : null}
                    </span>
                  ) : (
                    <CommitInput
                      value={String(attribute.value ?? '')}
                      mono={false}
                      align="left"
                      ariaLabel={attribute.label}
                      onCommit={(next) => void write(attribute.key, next)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** Every status the component reports, refreshed while the dialog is open. */
export function StatusesDialog({ componentId }: { componentId: string }) {
  const close = useDialogs((state) => state.close);
  const [summary, setSummary] = useState<StatusSummary | null>(null);

  usePolling(
    async (signal) => {
      setSummary(await api.components.statuses(componentId, signal));
    },
    1000,
    [componentId],
  );

  const entries = Object.entries(summary?.statuses ?? {});

  return (
    <Modal
      open
      onClose={close}
      title="Statuses"
      description={componentId}
      size="md"
      footer={<Button onClick={close}>Close</Button>}
    >
      {entries.length === 0 ? (
        <EmptyState title="No statuses" description="This component does not report any status values." />
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-sunken text-left text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
              <th scope="col" className="px-2 py-1">
                Status
              </th>
              <th scope="col" className="px-2 py-1">
                Value
              </th>
              <th scope="col" className="px-2 py-1">
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, entry]) => {
              const value = isEnumerationValue(entry.value) ? entry.value.name : formatDaqValue(entry.value);
              const level =
                value === 'Ok' || value === 'Connected'
                  ? 'ok'
                  : value === 'Warning' || value === 'Reconnecting'
                    ? 'warning'
                    : value === 'Error' || value === 'Unrecoverable'
                      ? 'error'
                      : 'none';
              return (
                <tr key={name} className="border-b border-border/60">
                  <th scope="row" className="px-2 py-1 text-left font-normal">
                    {name}
                  </th>
                  <td className="px-2 py-1">
                    <span className="flex items-center gap-1.5">
                      <StatusDot level={level} />
                      <Badge tone={statusTone(level)}>{value}</Badge>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-text-muted">{entry.message || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/**
 * Value and domain descriptors of a signal.
 *
 * The descriptor is where the answers live when data looks wrong: the sample type,
 * the tick resolution, the data rule, the epoch the domain counts from. The SDK
 * demo shows a subset; this shows all of it, and can export it as JSON to attach
 * to a bug report.
 */
export function DescriptorDialog({ signalId }: { signalId: string }) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const { data: signal, loading } = useAsyncData(
    (abort) => api.signals.detail(signalId, abort),
    [signalId],
    { onError: (error) => reportError(error, 'Could not read the descriptor') },
  );

  return (
    <Modal
      open
      onClose={close}
      title={signal ? `${signal.name} — data descriptor` : 'Data descriptor'}
      description={signalId}
      size="lg"
      footer={
        <>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      {loading && !signal ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : !signal ? (
        <EmptyState title="Descriptor unavailable" />
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="rounded-[var(--radius-control)] bg-sunken px-2.5 py-2">
            <InfoRow label="Sample rate" mono>
              {formatSampleRate(signal.sampleRate)}
            </InfoRow>
            <InfoRow label="Sample type" mono>
              {signal.sampleType ?? '—'}
            </InfoRow>
            <InfoRow label="Unit">
              {signal.unit ? `${signal.unit.symbol} (${signal.unit.quantity || 'unspecified'})` : '—'}
            </InfoRow>
            <InfoRow label="Domain signal" mono>
              {signal.domainSignalName ?? '—'}
            </InfoRow>
            <InfoRow label="Plottable">
              {signal.chartable ? (
                <Badge tone="ok">yes</Badge>
              ) : (
                <Badge tone="warn" title="Only scalar numeric signals can be plotted">no</Badge>
              )}
            </InfoRow>
            {signal.lastValue ? (
              <InfoRow label="Last value" mono>
                {signal.lastValue.displayValue ?? '—'}
              </InfoRow>
            ) : null}
          </dl>

          <DescriptorTable title="Value descriptor" descriptor={signal.descriptor ?? null} />
          <DescriptorTable title="Domain descriptor" descriptor={signal.domainDescriptor ?? null} />
        </div>
      )}
    </Modal>
  );
}

function DescriptorTable({ title, descriptor }: { title: string; descriptor: DataDescriptor | null }) {
  if (!descriptor) {
    return (
      <div>
        <h3 className="section-bar rounded-t-[var(--radius-control)]">{title}</h3>
        <p className="rounded-b-[var(--radius-control)] border border-t-0 border-border px-2.5 py-2 text-[12px] text-text-muted">
          Not available.
        </p>
      </div>
    );
  }

  const rule = descriptor.rule;
  const resolution = descriptor.tickResolution;

  return (
    <div>
      <h3 className="section-bar rounded-t-[var(--radius-control)]">{title}</h3>
      <dl className="rounded-b-[var(--radius-control)] border border-t-0 border-border px-2.5 py-2">
        <InfoRow label="Name">{descriptor.name || '—'}</InfoRow>
        <InfoRow label="Sample type" mono>
          {descriptor.sampleType ?? '—'}
        </InfoRow>
        <InfoRow label="Unit">
          {descriptor.unit ? `${descriptor.unit.symbol} · ${descriptor.unit.quantity || '—'}` : '—'}
        </InfoRow>
        <InfoRow label="Value range" mono>
          {descriptor.valueRange
            ? `${formatDaqValue(descriptor.valueRange.low)} … ${formatDaqValue(descriptor.valueRange.high)}`
            : '—'}
        </InfoRow>
        <InfoRow label="Data rule" mono>
          {rule
            ? `${rule.type ?? '—'}${
                Object.keys(rule.parameters).length
                  ? ` (${Object.entries(rule.parameters)
                      .map(([key, value]) => `${key}=${formatDaqValue(value)}`)
                      .join(', ')})`
                  : ''
              }`
            : '—'}
        </InfoRow>
        {resolution ? (
          <InfoRow label="Tick resolution" mono>
            {resolution.numerator}/{resolution.denominator} s
            <span className="ml-2 text-text-faint">
              ({formatEngineering(resolution.numerator / resolution.denominator, 's', 3)})
            </span>
          </InfoRow>
        ) : null}
        {descriptor.origin ? (
          <InfoRow label="Origin" mono>
            {descriptor.origin}
          </InfoRow>
        ) : null}
        {descriptor.dimensions.length > 0 ? (
          <InfoRow label="Dimensions">
            {descriptor.dimensions
              .map((dimension) => `${dimension.name || '?'}[${dimension.size ?? '?'}]`)
              .join(', ')}
          </InfoRow>
        ) : null}
        {descriptor.structFieldCount > 0 ? (
          <InfoRow label="Struct fields">{descriptor.structFieldNames.join(', ')}</InfoRow>
        ) : null}
        {descriptor.postScaling ? (
          <InfoRow label="Post scaling" mono>
            {descriptor.postScaling}
          </InfoRow>
        ) : null}
        {Object.keys(descriptor.metadata).length > 0 ? (
          <InfoRow label="Metadata" mono>
            {Object.entries(descriptor.metadata)
              .map(([key, value]) => `${key}=${formatDaqValue(value)}`)
              .join(', ')}
          </InfoRow>
        ) : null}
        {descriptor.referenceDomainInfo ? (
          <InfoRow label="Reference domain" mono>
            {Object.entries(descriptor.referenceDomainInfo)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => `${key}=${formatDaqValue(value)}`)
              .join(', ') || '—'}
          </InfoRow>
        ) : null}
      </dl>
    </div>
  );
}

/** Everything a discovered device advertises, before connecting to it. */
export function DeviceInfoDialog({
  connectionString,
  parentId,
}: {
  connectionString: string;
  parentId: string | null;
}) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const { data: device, loading } = useAsyncData(
    (signal) => api.topology.deviceInfo(connectionString, parentId ?? undefined, signal),
    [connectionString, parentId],
    { onError: (error) => reportError(error, 'Could not read device info') },
  );

  return (
    <Modal
      open
      onClose={close}
      title={device?.name ? `${device.name} — device information` : 'Device information'}
      description={connectionString}
      size="lg"
      footer={
        <>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      {loading && !device ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
          <Spinner size={14} /> Reading device information…
        </div>
      ) : !device ? (
        <EmptyState
          title="Not available"
          description="This device did not answer discovery, so there is nothing to show yet."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="rounded-[var(--radius-control)] bg-sunken px-2.5 py-2">
            <InfoRow label="Name">{device.name || '—'}</InfoRow>
            <InfoRow label="Manufacturer">{device.manufacturer || '—'}</InfoRow>
            <InfoRow label="Model">{device.model || '—'}</InfoRow>
            <InfoRow label="Serial number" mono>
              {device.serialNumber || '—'}
            </InfoRow>
            <InfoRow label="Location">{device.location || '—'}</InfoRow>
            <InfoRow label="Device class">{device.deviceClass || '—'}</InfoRow>
            <InfoRow label="SDK version" mono>
              {device.sdkVersion || '—'}
            </InfoRow>
            <InfoRow label="MAC address" mono>
              {device.macAddress || '—'}
            </InfoRow>
          </dl>

          {device.serverCapabilities.length > 0 ? (
            <div>
              <h3 className="section-bar rounded-t-[var(--radius-control)]">Server capabilities</h3>
              <div className="scroll-x rounded-b-[var(--radius-control)] border border-t-0 border-border">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="bg-sunken text-left text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
                      <th scope="col" className="px-2 py-1">
                        Protocol
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Type
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Transport
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Connection string
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {device.serverCapabilities.map((capability) => (
                      <tr key={capability.protocolId} className="border-b border-border/60 last:border-b-0">
                        <th scope="row" className="px-2 py-1 text-left font-normal">
                          {capability.protocolName || capability.protocolId}
                        </th>
                        <td className="px-2 py-1 text-text-muted">{capability.protocolType || '—'}</td>
                        <td className="px-2 py-1 text-text-muted">{capability.connectionType || '—'}</td>
                        <td className="px-2 py-1">
                          <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                            <span>{capability.connectionString}</span>
                            {Object.entries(capability.addresses).map(([type, address]) => (
                              <span key={type} className="text-text-faint">
                                {type}: {address}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-text-muted">
              This device exposes no network server capabilities, which is normal for a local or simulated
              device.
            </p>
          )}

          {device.properties && Object.keys(device.properties).length > 0 ? (
            <details className="rounded-[var(--radius-control)] border border-border">
              <summary className="cursor-pointer px-2.5 py-1.5 text-[12px] font-medium">
                All advertised properties ({Object.keys(device.properties).length})
              </summary>
              <dl className="border-t border-border px-2.5 py-2">
                {Object.entries(device.properties).map(([key, value]) => (
                  <InfoRow key={key} label={key} mono>
                    {formatDaqValue(value) || '—'}
                  </InfoRow>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
