import { useEffect, useMemo, useState } from 'react';
import { Activity, LineChart, Search, WifiOff } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { formatSampleRate } from '../../lib/format';
import { cn, isTypingTarget } from '../../lib/utils';
import { groupInOrder, signalOwnerId, signalOwnerName } from '../../lib/views';
import { useCollapsed } from '../../store/useCollapsed';
import { deviceIdOf, deviceName } from '../signals/signalData';
import { GroupToggle } from '../ui/GroupToggle';
import { useScope } from '../../store/useScope';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Input } from '../ui/Field';
import { Badge, EmptyState, Spinner } from '../ui/Feedback';
import { Section, SplitPane } from '../ui/Layout';
import { ScopeCanvas, type Readout } from './ScopeCanvas';
import { ScopeLegend } from './ScopeLegend';
import { ScopeSettings } from './ScopeSettings';
import { ScopeStatus } from './ScopeStatus';
import { ScopeToolbar } from './ScopeToolbar';
import { SpectrumCanvas } from './SpectrumCanvas';

/**
 * The scope workspace: pick signals on the left, plot and measure on the right.
 *
 * This is the part the SDK's demo application does not have - it previews one
 * signal at a time inside a row.  Overlaying several traces on a shared time base
 * with cursors, statistics and a spectrum is what makes the difference between
 * "I can see the value" and "I can tell what the signal is doing".
 */
export function ScopePage() {
  const [readout, setReadout] = useState<Readout | null>(null);
  const showSpectrum = useScope((state) => state.showSpectrum);
  const connection = useSession((state) => state.connection);
  const sidebarWidth = useSettings((state) => state.sidebarWidth);
  const setSetting = useSettings((state) => state.set);
  const [settingsFor, setSettingsFor] = useState<{
    signalId: string;
    name: string;
  } | null>(null);

  // Space pauses and resumes; L jumps back to the newest samples from anything.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const scope = useScope.getState();
      if (event.key === ' ') {
        event.preventDefault();
        scope.setPaused(!scope.paused);
      } else if (event.key === 'l' || event.key === 'L') {
        scope.goLive();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <SplitPane
      className="min-h-0 flex-1"
      size={sidebarWidth}
      onSizeChange={(size) => setSetting('sidebarWidth', size)}
      min={220}
      max={520}
      ariaLabel="Resize the signal list"
      first={<SignalPicker />}
      second={
        <div className="flex min-h-0 flex-1 flex-col bg-panel">
          <ScopeToolbar />

          {connection !== 'open' ? (
            <div className="flex items-center gap-2 border-b border-warn bg-warn-soft px-3 py-1.5 text-[11.5px] text-warn">
              <WifiOff size={13} />
              {connection === 'reconnecting'
                ? 'Reconnecting to the backend — the plot is paused until the stream resumes.'
                : 'Not connected to the backend.'}
            </div>
          ) : null}

          <ScopeStatus />

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col">
                <ScopeCanvas onReadout={setReadout} />
                {showSpectrum ? <SpectrumCanvas height={210} /> : null}
              </div>

              <div className="max-h-[38%] min-h-0 shrink-0 border-t border-border">
                <ScopeLegend readout={readout} onSettings={(signalId, name) => setSettingsFor({ signalId, name })} />
              </div>
            </div>
            {settingsFor ? (
              <ScopeSettings
                key={settingsFor.signalId}
                signalId={settingsFor.signalId}
                name={settingsFor.name}
                onClose={() => setSettingsFor(null)}
              />
            ) : null}
          </div>
        </div>
      }
    />
  );
}

/** Chartable signals, searchable, with the ones already plotted marked. */
function SignalPicker() {
  const includeHidden = useSettings((state) => state.includeHidden);
  const treeRevision = useSession((state) => state.treeRevision);
  const reportError = useSession((state) => state.reportError);
  // Select the store-owned array first, then derive ids with useMemo. Returning
  // a new array from a Zustand selector makes React's external-store snapshot
  // appear to change on every read, which can trigger React error #185.
  const traces = useScope((state) => state.traces);
  const addTrace = useScope((state) => state.addTrace);
  const removeTrace = useScope((state) => state.removeTrace);
  const setTraces = useScope((state) => state.setTraces);
  const clearTraces = useScope((state) => state.clearTraces);

  const [query, setQuery] = useState('');
  const [groupByDevice, setGroupByDevice] = useState(true);
  const tree = useSession((state) => state.tree);
  const collapsed = useCollapsed((state) => state.collapsed);
  const searching = query.trim() !== '';

  const traceIds = useMemo(() => traces.map((trace) => trace.signalId), [traces]);

  // Refetched when the tree changes, so signals from a newly connected device
  // show up without the user reloading.
  const { data: signals, loading } = useAsyncData(
    (signal) => api.signals.list({ chartableOnly: true, includeHidden }, signal).then((r) => r.signals),
    [includeHidden, treeRevision],
    { onError: (error) => reportError(error, 'Could not list signals') },
  );

  // Each signal with the channel or function block that owns it, so signals of
  // the same name on one device can be told apart, sorted by owner.
  const owned = useMemo(
    () =>
      (signals ?? [])
        .map((signal) => ({ signal, owner: signalOwnerName(signal, tree) }))
        .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '')),
    [signals, tree],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return owned;
    return owned.filter(({ signal, owner }) => `${owner ?? ''} ${signal.name} ${signal.id}`.toLowerCase().includes(needle));
  }, [query, owned]);

  const groups = useMemo(() => {
    if (!groupByDevice) return [{ key: '', label: '', signals: filtered }];
    const byDevice = new Map<string | null, typeof filtered>();
    for (const entry of filtered) {
      const key = deviceIdOf(entry.signal, tree);
      const bucket = byDevice.get(key);
      if (bucket) bucket.push(entry);
      else byDevice.set(key, [entry]);
    }
    // The instance's own signals come last.
    return [...byDevice.entries()]
      .map(([deviceId, entries]) => ({
        key: deviceId ?? 'instance',
        label: deviceName(deviceId, tree),
        signals: entries,
        last: deviceId === null,
      }))
      .sort((a, b) => Number(a.last) - Number(b.last) || a.label.localeCompare(b.label));
  }, [filtered, groupByDevice, tree]);

  const selected = new Set(traceIds);

  const renderRow = ({ signal, owner }: (typeof filtered)[number], indent: number, grouped: boolean) => {
    const active = selected.has(signal.id);
    return (
      <li key={signal.id}>
        <button
          type="button"
          aria-pressed={active}
          onClick={() => (active ? removeTrace(signal.id) : addTrace(signal.id, owner ? `${owner} · ${signal.name}` : signal.name))}
          className={cn(
            'flex w-full items-center gap-2 py-1 pr-2 text-left text-[12px]',
            indent === 2 ? 'pl-11' : indent === 1 ? 'pl-7' : 'pl-2',
            'row-hover',
            active && 'row-selected',
          )}
          title={signal.id}
        >
          <span
            className={cn('size-2.5 shrink-0 rounded-sm border', active ? 'border-transparent' : 'border-border-strong')}
            style={
              active
                ? {
                    backgroundColor:
                      useScope.getState().traces.find((trace) => trace.signalId === signal.id)?.color ?? 'var(--color-brand)',
                  }
                : undefined
            }
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">
            {owner && !grouped ? <span className="text-text-faint">{owner} · </span> : null}
            {signal.name}
          </span>
          {signal.sampleRate ? <span className="shrink-0 text-[10px] text-text-faint">{formatSampleRate(signal.sampleRate)}</span> : null}
          {signal.unit?.symbol ? <Badge>{signal.unit.symbol}</Badge> : null}
        </button>
      </li>
    );
  };

  return (
    <Section
      title="Signals"
      count={filtered.length}
      className="min-h-0 flex-1 border-r border-border bg-panel"
      bodyClassName="flex min-h-0 flex-col"
      actions={
        <>
          <IconButton
            label="Plot all visible signals"
            size="sm"
            disabled={filtered.length === 0}
            onClick={() =>
              setTraces(
                filtered.slice(0, 8).map(({ signal, owner }) => ({
                  signalId: signal.id,
                  name: owner ? `${owner} · ${signal.name}` : signal.name,
                })),
              )
            }
          >
            <LineChart size={12} />
          </IconButton>
          <Button size="sm" variant="ghost" disabled={traceIds.length === 0} onClick={clearTraces}>
            Clear
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-faint" />
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search signals…"
            aria-label="Search signals"
            className="pl-6.5"
          />
        </div>
        <Checkbox checked={groupByDevice} onChange={setGroupByDevice} label="Group by device and channel" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !signals ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
            <Spinner size={13} /> Loading signals…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Activity size={20} aria-hidden />}
            title={query ? 'No matching signals' : 'No plottable signals'}
            description={
              query
                ? 'Try a shorter search.'
                : 'Only scalar numeric signals with a domain signal can be plotted. Connect a device to get started.'
            }
          />
        ) : (
          groups.map((group) => {
            if (!group.key) return <ul key="all">{group.signals.map((entry) => renderRow(entry, 0, false))}</ul>;
            const deviceKey = `scope:${group.key}`;
            return (
              <div key={group.key}>
                <div className="sticky top-0 z-10 flex items-center gap-1 bg-sunken px-1 py-0.5 text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
                  <GroupToggle groupKey={deviceKey} label={group.label} />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="font-normal tracking-normal text-text-faint normal-case">{group.signals.length}</span>
                </div>
                {collapsed.has(deviceKey) && !searching
                  ? null
                  : groupInOrder(group.signals, ({ signal }) => signalOwnerId(signal)).map((owned) => {
                      const ownerName = owned.items[0]?.owner ?? null;
                      if (!owned.key || !ownerName)
                        return <ul key={`${group.key}:device`}>{owned.items.map((entry) => renderRow(entry, 1, true))}</ul>;
                      const ownerKey = `scope:${owned.key}`;
                      return (
                        <div key={owned.key}>
                          <div className="flex items-center gap-1 py-0.5 pr-2 pl-4 text-[12px] text-text-muted">
                            <GroupToggle groupKey={ownerKey} label={ownerName} />
                            <span className="min-w-0 flex-1 truncate font-medium">{ownerName}</span>
                            <span className="text-[10.5px] text-text-faint">{owned.items.length}</span>
                          </div>
                          {collapsed.has(ownerKey) && !searching ? null : <ul>{owned.items.map((entry) => renderRow(entry, 2, true))}</ul>}
                        </div>
                      );
                    })}
              </div>
            );
          })
        )}
      </div>
    </Section>
  );
}
