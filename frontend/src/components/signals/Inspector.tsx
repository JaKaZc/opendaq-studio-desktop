import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, ExternalLink, FileCode2, LineChart, Plus, Settings2, Trash2, Waves, X } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { cleanValue } from '../../lib/tracks';
import type { ComponentNode, DataDescriptor, FunctionBlockFit, SignalInfo } from '../../lib/types';
import { useAsyncData } from '../../lib/useAsyncData';
import { cn } from '../../lib/utils';
import { groupInOrder, signalOwnerId, signalOwnerName, walk } from '../../lib/views';
import { useCollapsed } from '../../store/useCollapsed';
import { useDialogs } from '../../store/useDialogs';
import { go } from '../../store/useNav';
import { useSession } from '../../store/useSession';
import { openInScope, useTracks } from '../../store/useTracks';
import { traces } from '../../store/traceStore';
import { Button } from '../ui/Button';
import { GroupToggle } from '../ui/GroupToggle';
import { arrayReading, peakOf } from './arrayValues';
import { deviceIdOf, deviceName, inputSources, isArraySignal, isImageSignal, producerOf, useSignalData } from './signalData';
import { openPictureWindow } from './PictureWindow';
import { addPainter } from './trackLoop';

export const INSPECTOR_WIDTH = 340;

/**
 * What openDAQ says about the selection, in one column: a signal's value and
 * data descriptor, the function block that produces it, and the function
 * blocks it can be processed with; a device's signals; and, with nothing
 * selected, the components whose status is not OK.
 */
export function Inspector() {
  const selection = useTracks((state) => state.selection);
  return (
    <aside
      className="flex min-h-0 shrink-0 flex-col border-l border-border bg-panel"
      style={{ width: INSPECTOR_WIDTH }}
      aria-label="Inspector"
    >
      {selection?.kind === 'track' ? (
        <TrackInspector key={selection.id} signalId={selection.id} />
      ) : selection?.kind === 'device' ? (
        <DeviceInspector key={selection.id} deviceId={selection.id} />
      ) : (
        <InstanceInspector />
      )}
    </aside>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3.5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">{title}</h3>
        {aside ? <div className="ml-auto">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Header({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  const select = useTracks((state) => state.select);
  return (
    <div className="flex items-start gap-2.5 px-4 pt-4 pb-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold">{title}</h2>
        <p className="truncate text-[11.5px] text-text-faint">{detail}</p>
      </div>
      <button
        type="button"
        onClick={() => select(null)}
        aria-label="Close the inspector"
        className="rounded p-1 text-text-faint hover:bg-sunken hover:text-text"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-faint">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --------------------------------------------------------------------------- nothing selected

function InstanceInspector() {
  const tree = useSession((state) => state.tree);
  const info = useSession((state) => state.info);
  const signals = useSignalData((state) => state.signals);
  const tracks = useTracks((state) => state.tracks);
  const select = useTracks((state) => state.select);

  // Components whose openDAQ status container reports anything other than OK.
  const { devices, flagged } = useMemo(() => {
    let count = 0;
    const list: ComponentNode[] = [];
    if (tree) {
      walk(tree, (node) => {
        if (node.kind === 'device' && node.id !== tree.id) count += 1;
        if (node.status.level === 'warning' || node.status.level === 'error') list.push(node);
      });
    }
    return { devices: count, flagged: list };
  }, [tree]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-4 pt-4 pb-3">
        <h2 className="truncate text-[15px] font-semibold">{tree?.displayName || tree?.name || 'openDAQ instance'}</h2>
        <p className="mt-0.5 text-[12px] text-text-muted">
          {devices} device{devices === 1 ? '' : 's'}, {signals.length} chartable signal{signals.length === 1 ? '' : 's'} and {tracks.length}{' '}
          track
          {tracks.length === 1 ? '' : 's'} shown.
        </p>
      </div>

      <Section title="Component statuses">
        {flagged.length === 0 ? (
          <p className="text-[12px] text-text-muted">Every component reports an OK status.</p>
        ) : (
          <ul className="space-y-1.5">
            {flagged.map((node) => (
              <li
                key={node.id}
                className={cn(
                  'rounded-[10px] border px-3 py-2 text-[12px]',
                  node.status.level === 'error' ? 'border-err/30 bg-err-soft' : 'border-warn/30 bg-warn-soft',
                )}
              >
                <div className="font-medium">{node.displayName || node.name}</div>
                {node.status.message ? <p className="text-text-muted">{node.status.message}</p> : null}
                {node.kind === 'device' ? (
                  <button
                    type="button"
                    onClick={() => select({ kind: 'device', id: node.id })}
                    className="mt-1 text-[11.5px] font-medium text-accent hover:underline"
                  >
                    Show its signals
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {info ? (
        <Section title="openDAQ">
          <Rows
            rows={[
              ['SDK', info.sdkVersion ?? 'unknown'],
              ['Instance', tree?.localId ?? '-'],
            ]}
          />
        </Section>
      ) : null}

      <Section title="Getting around">
        <ul className="space-y-1.5 text-[12px] text-text-muted">
          <li>Click a track to see its data descriptor and to process it with a function block.</li>
          <li>Hover over the tracks to read every signal at the same moment.</li>
          <li>
            Press <Kbd>Space</Kbd> to pause and hold <Kbd>⌘</Kbd> while scrolling to zoom.
          </li>
          <li>Add a CSV or Parquet recorder and connect the tracks to record them.</li>
        </ul>
      </Section>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-sunken px-1 text-[10.5px] text-text">{children}</kbd>;
}

// --------------------------------------------------------------------------- a track

function TrackInspector({ signalId }: { signalId: string }) {
  const tree = useSession((state) => state.tree);
  const openDialog = useDialogs((state) => state.open);
  const signal = useSignalData((state) => state.byId.get(signalId));
  const byId = useSignalData((state) => state.byId);
  const sourceId = useMemo(() => inputSources(tree).get(signalId) ?? null, [tree, signalId]);
  const producer = useMemo(() => producerOf(tree, signalId), [tree, signalId]);
  const source = sourceId ? byId.get(sourceId) : undefined;
  const descriptor = useAsyncData((abort) => api.signals.descriptor(signalId, abort), [signalId]);
  // A picture's unit names its file format, which says nothing here.
  const unit = signal && isImageSignal(signal) ? '' : (signal?.unit?.symbol ?? '');
  const device = deviceName(deviceIdOf(signal, tree) ?? deviceIdOf(source, tree), tree);
  const owner = signal ? signalOwnerName(signal, tree) : null;

  if (!signal) {
    return (
      <>
        <Header icon={<Waves size={14} />} title={signalId.split('/').pop() || signalId} detail="This signal is not available now." />
        <p className="px-4 text-[12px] text-text-muted">The device may be disconnected. The track comes back when the signal does.</p>
      </>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Header
        icon={<Waves size={14} />}
        title={signal.name}
        detail={
          source ? `${producer?.name ?? 'A function block'} reading ${source.name}` : [device, owner, unit].filter(Boolean).join(' · ')
        }
      />
      {isArraySignal(signal) ? <ArrayValue signalId={signalId} unit={unit} /> : <LiveValue signalId={signalId} unit={unit} />}
      <DescriptorSection
        descriptor={descriptor.data?.descriptor ?? null}
        domain={descriptor.data?.domainDescriptor ?? null}
        signal={signal}
      >
        <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => openDialog({ kind: 'descriptor', signalId })}>
          The full data descriptor
        </Button>
        {!isArraySignal(signal) && !isImageSignal(signal) ? (
          <Button
            size="sm"
            className="ml-1.5"
            icon={<LineChart size={12} />}
            onClick={() => openInScope(signalId, owner ? `${owner} · ${signal.name}` : `${device} ${signal.name}`)}
          >
            Open in the Scope
          </Button>
        ) : null}
        {isImageSignal(signal) ? (
          <Button
            size="sm"
            className="ml-1.5"
            icon={<ExternalLink size={12} />}
            onClick={() => openPictureWindow(signalId, signal.name, signal.imageSize)}
          >
            Open in a new window
          </Button>
        ) : null}
      </DescriptorSection>
      {producer ? <Producer block={producer} /> : null}
      <ProcessWith signal={signal} />
      <Section title="Signal">
        <Rows
          rows={[
            [
              'Global id',
              <span key="id" className="font-mono text-[11px]" title={signal.id}>
                {signal.id}
              </span>,
            ],
            ['Public', signal.public ? 'Yes' : 'No'],
            ['Streamed', signal.streamed ? 'Yes' : 'No'],
            ['Active', signal.active ? 'Yes' : 'No'],
          ]}
        />
        <Button
          className="mt-3"
          size="sm"
          icon={<Settings2 size={12} />}
          onClick={() => {
            void useSession.getState().select(signal.parentId ?? signal.id);
            go('devices');
          }}
        >
          Open its {signal.parentId ? 'component' : 'signal'} in Devices
        </Button>
      </Section>
    </div>
  );
}

function LiveValue({ signalId, unit }: { signalId: string; unit: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let shown = '';
    let span = 0;
    let measured = 0;
    return addPainter(({ start, end }) => {
      const buffer = traces.buffer(signalId);
      const cursor = useTracks.getState().cursor;
      if (buffer && performance.now() - measured > 500) {
        const extent = buffer.extent(start, end);
        span = extent ? extent.max - extent.min : 0;
        measured = performance.now();
      }
      const value = buffer ? (cursor !== null ? (buffer.valueAt(cursor, 0.05)?.value ?? null) : buffer.latestValue()) : null;
      const text = value === null ? '-' : formatNumber(cleanValue(value, span), 6);
      if (text !== shown && ref.current) {
        ref.current.textContent = text;
        shown = text;
      }
    });
  }, [signalId]);
  return (
    <div className="flex items-baseline gap-1.5 px-4 pb-3.5">
      <span ref={ref} className="kpi-number num text-[34px] leading-none tabular">
        -
      </span>
      <span className="text-[13px] text-text-muted">{unit}</span>
    </div>
  );
}

function ratio(value: { numerator: number; denominator: number } | null | undefined): string {
  if (!value) return '-';
  return `${value.numerator}/${value.denominator}`;
}

function range(descriptor: DataDescriptor | null): string {
  const value = descriptor?.valueRange;
  if (!value || (value.low === null && value.high === null)) return '-';
  return `${value.low === null ? '-∞' : formatNumber(value.low, 6)} to ${value.high === null ? '∞' : formatNumber(value.high, 6)}`;
}

/** The parts of the value and domain descriptors that say what a sample is. */
function DescriptorSection({
  descriptor,
  domain,
  signal,
  children,
}: {
  descriptor: DataDescriptor | null;
  domain: DataDescriptor | null;
  signal: SignalInfo;
  children: React.ReactNode;
}) {
  return (
    <Section title="Data descriptor">
      <Rows
        rows={[
          ['Sample type', descriptor?.sampleType ?? signal.sampleType ?? '-'],
          ['Unit', descriptor?.unit ? `${descriptor.unit.symbol}${descriptor.unit.quantity ? ` (${descriptor.unit.quantity})` : ''}` : '-'],
          ['Value range', range(descriptor)],
          ['Rule', descriptor?.rule?.type ?? '-'],
          ...(descriptor?.postScaling ? ([['Post scaling', descriptor.postScaling]] as [string, string][]) : []),
          ['Domain', domain ? `${domain.name || 'time'}${domain.unit?.symbol ? ` in ${domain.unit.symbol}` : ''}` : '-'],
          ['Domain rule', domain?.rule?.type ?? '-'],
          ['Tick resolution', ratio(domain?.tickResolution)],
          ['Origin', domain?.origin || '-'],
          ['Sample rate', signal.sampleRate ? `${formatNumber(signal.sampleRate, 6)} Hz` : 'not constant'],
        ]}
      />
      <div className="mt-3">{children}</div>
    </Section>
  );
}

/**
 * The function block types that work on this signal, as the SDK reports it:
 * each type was added for a moment with the signal connected, and only those
 * whose status stayed OK are offered. The others are listed with the reason the
 * block gave, such as a missing second input or a sample type it cannot read.
 */
function ProcessWith({ signal }: { signal: SignalInfo }) {
  const notify = useSession((state) => state.notify);
  const readOnly = useSession((state) => Boolean(state.info?.readOnly));
  const fit = useAsyncData((abort) => api.signals.functionBlockFit(signal.id, abort), [signal.id]);
  const [typeId, setTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  // Recorders and writers have their own place, in the bar above the tracks.
  const candidates = (fit.data?.types ?? []).filter((type) => !/recorder|writer/i.test(`${type.id} ${type.name}`));
  const working = candidates.filter((type) => type.works);
  const others = candidates.filter((type) => !type.works);
  const chosen = working.find((type) => type.id === typeId) ?? working.find((type) => /statistics/i.test(type.id)) ?? working[0];

  const add = async (type: FunctionBlockFit) => {
    setBusy(true);
    try {
      const block = await api.topology.addFunctionBlock(type.id);
      const { ports } = await api.topology.inputPorts(block.componentId);
      const port = ports[0];
      if (port) await api.topology.connectPort(port.id, signal.id);
      await useSession.getState().refreshTree({ silent: true });
      // Outputs can be shown once they have a descriptor, which some blocks set
      // only after their first input arrives.
      let outputs: string[] = [];
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await useSignalData.getState().refresh();
        const tree = useSession.getState().tree;
        const known = useSignalData.getState().byId;
        outputs = [...inputSources(tree).entries()]
          .filter(([id, source]) => source === signal.id && id.startsWith(`${block.componentId}/`) && known.has(id))
          .map(([id]) => id);
        if (outputs.length || !type.outputs.length) break;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        await useSession.getState().refreshTree({ silent: true });
      }
      useTracks.getState().addTracks(outputs, signal.id);
      notify(
        'success',
        `${block.name} reads ${signal.name}`,
        outputs.length
          ? `Its ${outputs.length} output signal${outputs.length === 1 ? ' is a track' : 's are tracks'} under ${signal.name}.`
          : 'Its outputs are listed under the block in Devices.',
      );
    } catch (error) {
      notify('error', `${type.name} was not added`, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (readOnly) return null;
  return (
    <Section title="Process with a function block">
      {fit.loading && !fit.data ? (
        <p className="text-[12px] text-text-muted">Asking each function block type whether it can read this signal.</p>
      ) : working.length === 0 ? (
        <p className="text-[12px] text-text-muted">No function block type of the loaded modules can process this signal on its own.</p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-text-muted">
            These function block types report an OK status with this signal connected. The block is added with its default configuration.
          </p>
          <select
            value={chosen?.id ?? ''}
            onChange={(event) => setTypeId(event.target.value)}
            aria-label="Function block type"
            className="h-8 w-full rounded-[var(--radius-control)] border border-border bg-panel px-2 text-[12.5px] outline-none focus:border-accent/60"
          >
            {working.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
                {type.description ? ` - ${type.description}` : ''}
              </option>
            ))}
          </select>
          {chosen && chosen.outputs.some((output) => output.shape === 'array') ? (
            <p className="mt-1.5 text-[11.5px] text-text-faint">
              Its output is an array per sample, such as a spectrum. The track shows the latest array.
            </p>
          ) : null}
          <Button
            className="mt-2"
            size="sm"
            variant="primary"
            icon={<Plus size={12} />}
            loading={busy}
            disabled={!chosen}
            onClick={() => chosen && void add(chosen)}
          >
            Add {chosen?.name ?? 'the function block'}
          </Button>
        </>
      )}
      {others.length ? (
        <details className="mt-3 text-[11.5px]">
          <summary className="cursor-pointer text-text-muted hover:text-text">
            {others.length} other type{others.length === 1 ? '' : 's'} cannot process this signal
          </summary>
          <ul className="mt-1.5 space-y-1">
            {others.map((type) => (
              <li key={type.id}>
                <span className="font-medium text-text">{type.name}</span>
                <span className="text-text-faint">: {type.reason ?? 'It does not report an OK status.'}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

/** The largest element of the newest array, for an array track such as a spectrum. */
function ArrayValue({ signalId, unit }: { signalId: string; unit: string }) {
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const detailRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let shown = '';
    return addPainter(() => {
      const reading = arrayReading(signalId);
      const peak = reading ? peakOf(reading.values) : null;
      const text = peak ? formatNumber(peak.value, 6) : '-';
      const detail = peak && reading ? `peak at element ${peak.index} of ${reading.values.length}` : 'waiting for the first array';
      if (text + detail !== shown) {
        if (valueRef.current) valueRef.current.textContent = text;
        if (detailRef.current) detailRef.current.textContent = detail;
        shown = text + detail;
      }
    });
  }, [signalId]);
  return (
    <div className="px-4 pb-3.5">
      <div className="flex items-baseline gap-1.5">
        <span ref={valueRef} className="kpi-number num text-[34px] leading-none tabular">
          -
        </span>
        <span className="text-[13px] text-text-muted">{unit}</span>
      </div>
      <span ref={detailRef} className="text-[11.5px] text-text-faint">
        waiting for the first array
      </span>
    </div>
  );
}

function Producer({ block }: { block: ComponentNode }) {
  const readOnly = useSession((state) => Boolean(state.info?.readOnly));
  return (
    <Section title="Produced by">
      <p className="text-[12px] text-text-muted">
        <span className="font-medium text-text">{block.displayName || block.name}</span>
        {block.functionBlock?.typeName ? `, a ${block.functionBlock.typeName} function block.` : '.'}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          icon={<Settings2 size={12} />}
          onClick={() => {
            void useSession.getState().select(block.id);
            go('devices');
          }}
        >
          Its properties
        </Button>
        {!readOnly ? (
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => actions.removeFunctionBlock(block.id, block.name)}>
            Remove it
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

// --------------------------------------------------------------------------- a device

function DeviceInspector({ deviceId }: { deviceId: string }) {
  const tree = useSession((state) => state.tree);
  const signals = useSignalData((state) => state.signals);
  const tracks = useTracks((state) => state.tracks);
  const addTracks = useTracks((state) => state.addTracks);
  const removeTrack = useTracks((state) => state.removeTrack);
  const collapsed = useCollapsed((state) => state.collapsed);
  const channels = signals.filter((signal) => deviceIdOf(signal, tree) === deviceId);
  const shown = new Set(tracks);
  const name = deviceName(deviceId, tree);
  // The signals by the channel or function block that owns them, in the order
  // of the owners' names; the device's own signals come first.
  const owned = groupInOrder(
    channels
      .map((signal) => ({ signal, owner: signalOwnerName(signal, tree) }))
      .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '')),
    ({ signal }) => signalOwnerId(signal),
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Header icon={<Cpu size={14} />} title={name} detail={`${channels.length} chartable signal${channels.length === 1 ? '' : 's'}`} />
      <Section
        title="Tracks"
        aside={
          <button
            type="button"
            onClick={() => addTracks(channels.map((signal) => signal.id))}
            className="text-[11.5px] font-medium text-accent hover:underline"
          >
            Show all
          </button>
        }
      >
        {owned.map((group) => {
          const ownerName = group.items[0]?.owner ?? null;
          const ids = group.items.map(({ signal }) => signal.id);
          const count = ids.filter((id) => shown.has(id)).length;
          const groupKey = `inspector:${group.key ?? `${deviceId}:device`}`;
          return (
            <div key={groupKey}>
              {ownerName ? (
                <div className="-mx-1.5 flex items-center gap-1.5 rounded-[6px] py-0.5 pr-1.5 text-[12px] text-text-muted">
                  <GroupToggle groupKey={groupKey} label={ownerName} />
                  <input
                    type="checkbox"
                    checked={count === ids.length}
                    ref={(box) => {
                      if (box) box.indeterminate = count > 0 && count < ids.length;
                    }}
                    onChange={() => (count === ids.length ? ids.forEach(removeTrack) : addTracks(ids.filter((id) => !shown.has(id))))}
                    aria-label={`All signals of ${ownerName}`}
                    className="size-3.5 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{ownerName}</span>
                  <span className="text-[11px] text-text-faint">
                    {count}/{ids.length}
                  </span>
                </div>
              ) : null}
              {ownerName && collapsed.has(groupKey) ? null : (
                <ul className="space-y-0.5">
                  {group.items.map(({ signal }) => (
                    <li key={signal.id}>
                      <label
                        className={cn(
                          'row-hover -mx-1.5 flex cursor-pointer items-center gap-2 rounded-[6px] py-1 pr-1.5 text-[12.5px]',
                          ownerName ? 'pl-11' : 'pl-1.5',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={shown.has(signal.id)}
                          onChange={() => (shown.has(signal.id) ? removeTrack(signal.id) : addTracks([signal.id]))}
                          className="size-3.5 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{signal.name}</span>
                        {/* A picture's unit names its file format, which says nothing here. */}
                        <span className="text-[11px] text-text-faint">
                          {signal.image ? (signal.image === 'plot' ? 'plot' : 'picture') : (signal.unit?.symbol ?? '')}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </Section>
      <Section title="Device">
        <Button
          size="sm"
          icon={<Settings2 size={12} />}
          onClick={() => {
            void useSession.getState().select(deviceId);
            go('devices');
          }}
        >
          Its properties
        </Button>
      </Section>
    </div>
  );
}
