import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Cpu, ListPlus, Plus } from 'lucide-react';
import { groupTracks } from '../../lib/tracks';
import { usePolling } from '../../lib/usePolling';
import { cn, isTypingTarget } from '../../lib/utils';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { openInScope, resumeTrackSubscription, setStreamedTracks, useTracks } from '../../store/useTracks';
import { traces } from '../../store/traceStore';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Feedback';
import { Inspector } from './Inspector';
import { Ruler } from './Ruler';
import { pollArrays } from './arrayValues';
import { PictureTrackRow } from './PictureTrackRow';
import { findNode, groupInOrder, signalOwnerId, signalOwnerName } from '../../lib/views';
import { useCollapsed } from '../../store/useCollapsed';
import { GroupToggle } from '../ui/GroupToggle';
import { deviceIdOf, deviceName, inputSources, isArraySignal, isImageSignal, useSignalData } from './signalData';
import { currentWindow } from './trackLoop';
import { HEADER_WIDTH, TrackRow } from './TrackRow';
import { TransportBar } from './TransportBar';

const SEED_LIMIT = 24;

/**
 * Every signal of the instance as a track, one under the other on one time
 * axis. The recorder function blocks run from the bar above, and whatever is
 * clicked is explained, as openDAQ describes it, in the inspector on the right.
 */
export function SignalsPage() {
  const tree = useSession((state) => state.tree);
  const treeRevision = useSession((state) => state.treeRevision);
  const openDialog = useDialogs((state) => state.open);
  const refresh = useSignalData((state) => state.refresh);
  const loaded = useSignalData((state) => state.loaded);
  const signals = useSignalData((state) => state.signals);
  const byId = useSignalData((state) => state.byId);
  const tracks = useTracks((state) => state.tracks);
  const seeded = useTracks((state) => state.seeded);
  const selection = useTracks((state) => state.selection);
  const size = useTracks((state) => state.size);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const collapsed = useCollapsed((state) => state.collapsed);

  usePolling(
    async (signal) => {
      await refresh(signal);
      // A track that could not be streamed when it was added, such as a
      // function block output before its first sample, is asked for again.
      const { byId } = useSignalData.getState();
      if (useTracks.getState().tracks.some((id) => byId.get(id)?.chartable && !traces.meta(id))) resumeTrackSubscription();
    },
    10_000,
    [treeRevision],
  );

  // Only tracks of signals the instance has, with a number per sample,
  // stream; array tracks poll their latest array, and picture tracks their
  // latest picture. A remembered track streams again once its device is back.
  useEffect(() => {
    if (!loaded) return;
    setStreamedTracks((id) => {
      const signal = byId.get(id);
      return signal !== undefined && !isArraySignal(signal) && !isImageSignal(signal);
    });
  }, [byId, loaded]);

  const arrayTracks = useMemo(() => tracks.filter((id) => isArraySignal(byId.get(id))), [tracks, byId]);
  usePolling((signal) => pollArrays(arrayTracks, signal), 300, [arrayTracks.join('|')], { enabled: arrayTracks.length > 0 });

  // A fresh install starts with every device signal as a track.
  useEffect(() => {
    if (!loaded || seeded || !tree) return;
    const channels = signals.filter((signal) => signal.chartable && deviceIdOf(signal, tree) !== null).map((signal) => signal.id);
    if (channels.length) useTracks.getState().seed(channels.slice(0, SEED_LIMIT));
  }, [loaded, seeded, signals, tree]);

  const sources = useMemo(() => inputSources(tree), [tree]);
  const visible = useMemo(() => tracks.filter((id) => byId.has(id)), [tracks, byId]);
  const groups = useMemo(
    () =>
      groupTracks(
        visible,
        (id) => deviceIdOf(byId.get(id), tree),
        (id) => sources.get(id) ?? null,
      ),
    [visible, byId, tree, sources],
  );

  const signalOwnerIdOf = useCallback(
    (id: string) => {
      const signal = byId.get(id);
      return signal ? signalOwnerId(signal) : null;
    },
    [byId],
  );
  // Every group on the page, devices and the channels in them, for
  // collapsing or expanding them all at once.
  const groupKeys = useMemo(
    () =>
      groups.flatMap((group) => [
        `signals:${group.deviceId ?? 'instance'}`,
        ...groupInOrder(group.tracks, (id) => {
          const signal = byId.get(id);
          return signal ? signalOwnerId(signal) : null;
        }).flatMap((owned) => (owned.key ? [`signals:${owned.key}`] : [])),
      ]),
    [groups, byId],
  );
  // Only the groups in view count: a channel inside a collapsed device is
  // out of sight.
  const anyExpanded = groupKeys.some((key) => {
    if (collapsed.has(key)) return false;
    const device = groups.find((group) => key === `signals:${group.deviceId ?? 'instance'}`);
    if (device) return true;
    const owner = groups.find((group) => group.tracks.some((id) => key === `signals:${signalOwnerIdOf(id)}`));
    return !owner || !collapsed.has(`signals:${owner.deviceId ?? 'instance'}`);
  });

  const select = useCallback((id: string) => useTracks.getState().select({ kind: 'track', id }), []);
  const remove = useCallback((id: string) => useTracks.getState().removeTrack(id), []);
  const scope = useCallback((id: string) => {
    const signal = useSignalData.getState().byId.get(id);
    const root = useSession.getState().tree;
    openInScope(id, signal ? `${deviceName(deviceIdOf(signal, root), root)} ${signal.name}` : undefined);
  }, []);

  usePointerAndWheel(scrollRef);
  useTrackKeys(visible);

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-panel">
        <TransportBar />
        <Ruler
          label={
            <span className="flex w-full min-w-0 items-center gap-2 pr-2">
              <span className="truncate">
                {visible.length} track{visible.length === 1 ? '' : 's'}
              </span>
              {groupKeys.length > 0 ? (
                <button
                  type="button"
                  onClick={() => useCollapsed.getState().setAll(groupKeys, anyExpanded)}
                  title={anyExpanded ? 'Collapse every group' : 'Expand every group'}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-text-muted hover:bg-sunken hover:text-text"
                >
                  {anyExpanded ? <ChevronsDownUp size={12} aria-hidden /> : <ChevronsUpDown size={12} aria-hidden />}
                  {anyExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              ) : null}
            </span>
          }
        />
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="grid" aria-label="Tracks">
          {visible.length === 0 ? (
            <EmptyTracks hasChannels={signals.length > 0} onAddDevice={() => openDialog({ kind: 'addDevice', parentId: null })} />
          ) : (
            groups.map((group) => {
              const name = deviceName(group.deviceId, tree);
              const deviceSelected = selection?.kind === 'device' && selection.id === group.deviceId;
              return (
                <div key={group.deviceId ?? 'instance'} role="rowgroup">
                  <div
                    className={cn(
                      'sticky top-0 z-10 flex h-7 w-full items-center gap-1.5 border-b border-border/70 bg-sunken/95 pr-4 pl-2 text-[11px] font-semibold tracking-[0.06em] text-text-muted uppercase backdrop-blur',
                      deviceSelected && 'text-accent',
                    )}
                  >
                    <GroupToggle groupKey={`signals:${group.deviceId ?? 'instance'}`} label={name} />
                    <button
                      type="button"
                      onClick={() => group.deviceId && useTracks.getState().select({ kind: 'device', id: group.deviceId })}
                      className={cn(
                        'flex min-w-0 items-center gap-2 text-left uppercase',
                        group.deviceId ? 'hover:text-text' : 'cursor-default',
                      )}
                    >
                      <Cpu size={12} aria-hidden />
                      <span className="truncate">{name}</span>
                    </button>
                    <span className="font-normal tracking-normal text-text-faint normal-case">
                      {group.tracks.length} track
                      {group.tracks.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {collapsed.has(`signals:${group.deviceId ?? 'instance'}`)
                    ? null
                    : groupInOrder(group.tracks, (id) => {
                        const signal = byId.get(id);
                        return signal ? signalOwnerId(signal) : null;
                      }).map((owned) => {
                        const ownerKey = `signals:${owned.key ?? `${group.deviceId ?? 'instance'}:device`}`;
                        const ownerName = owned.key
                          ? ((tree && findNode(tree, owned.key)?.name) ?? owned.key.split('/').pop() ?? '')
                          : null;
                        return (
                          <div key={ownerKey} role="rowgroup">
                            {ownerName ? (
                              <div className="flex h-6 items-center gap-1.5 border-b border-border/50 bg-panel pr-4 pl-6 text-[11px] text-text-muted">
                                <GroupToggle groupKey={ownerKey} label={ownerName} />
                                <span className="truncate font-medium">{ownerName}</span>
                                <span className="text-text-faint">
                                  {owned.items.length} track
                                  {owned.items.length === 1 ? '' : 's'}
                                </span>
                              </div>
                            ) : null}
                            {ownerName && collapsed.has(ownerKey)
                              ? null
                              : owned.items.map((id) => {
                                  const signal = byId.get(id)!;
                                  const source = sources.get(id);
                                  const sourceName = source ? byId.get(source)?.name : undefined;
                                  const unit = signal.unit?.symbol ?? '';
                                  // The group names the device, so a row names the channel
                                  // or function block that owns the signal, if any.
                                  const owner = signalOwnerName(signal, tree) ?? name;
                                  if (signal.image) {
                                    const pictureSize = signal.imageSize;
                                    return (
                                      <PictureTrackRow
                                        key={id}
                                        signalId={id}
                                        name={signal.name}
                                        detail={owner}
                                        dimensions={pictureSize ?? null}
                                        selected={selection?.kind === 'track' && selection.id === id}
                                        size={size}
                                        onSelect={select}
                                        onRemove={remove}
                                      />
                                    );
                                  }
                                  return (
                                    <TrackRow
                                      key={id}
                                      signalId={id}
                                      name={signal.name}
                                      detail={sourceName ? `from ${sourceName}` : [owner, unit || 'no unit'].join(' · ')}
                                      unit={unit}
                                      derived={Boolean(source)}
                                      isArray={isArraySignal(signal)}
                                      selected={selection?.kind === 'track' && selection.id === id}
                                      size={size}
                                      onSelect={select}
                                      onRemove={remove}
                                      onScope={scope}
                                    />
                                  );
                                })}
                          </div>
                        );
                      })}
                </div>
              );
            })
          )}
          {visible.length ? (
            <div className="grid" style={{ gridTemplateColumns: `${HEADER_WIDTH}px minmax(0,1fr)` }}>
              <AddTrackHint />
            </div>
          ) : null}
        </div>
      </div>
      {/* On a narrow window the inspector opens over the tracks, and only for a selection. */}
      <div
        className={cn(
          'min-h-0',
          selection ? 'absolute inset-y-0 right-0 z-20 flex shadow-popover xl:static xl:shadow-none' : 'hidden xl:flex',
        )}
      >
        <Inspector />
      </div>
    </div>
  );
}

function AddTrackHint() {
  return (
    <p className="col-span-2 px-4 py-3 text-[11.5px] text-text-faint">
      Add or remove signals with <span className="font-medium text-text-muted">Tracks</span> above. Click a device name to see all of its
      signals.
    </p>
  );
}

function EmptyTracks({ hasChannels, onAddDevice }: { hasChannels: boolean; onAddDevice: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md px-6 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
        <ListPlus size={20} />
      </span>
      <h2 className="mt-3 text-[16px] font-semibold">{hasChannels ? 'No signal is shown' : 'Connect a device to begin'}</h2>
      <p className="mt-1 text-[12.5px] text-text-muted">
        {hasChannels
          ? 'Every chartable signal can be a track. Choose the signals with Tracks in the bar above.'
          : 'Each signal of a connected device appears here as a live track.'}
      </p>
      {!hasChannels ? (
        <Button className="mt-4" variant="primary" icon={<Plus size={13} />} onClick={onAddDevice}>
          Add a device
        </Button>
      ) : null}
    </div>
  );
}

/** The time under the pointer, from the ruler's plot area, which every lane shares. */
function timeAt(clientX: number): number | null {
  const plot = document.querySelector<HTMLElement>('[data-track-plot]');
  if (!plot) return null;
  const rect = plot.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || rect.width <= 0) return null;
  const { start, end } = currentWindow();
  return start + ((clientX - rect.left) / rect.width) * (end - start);
}

/**
 * The pointer reads every track at once; scrolling with ⌘ or Ctrl zooms the
 * time window, and scrolling sideways moves back in time, which pauses.
 */
function usePointerAndWheel(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const move = (event: PointerEvent) => useTracks.getState().setCursor(timeAt(event.clientX));
    const leave = () => useTracks.getState().setCursor(null);
    const wheel = (event: WheelEvent) => {
      const tracks = useTracks.getState();
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        tracks.setWindow(tracks.windowSeconds * (event.deltaY > 0 ? 1.15 : 1 / 1.15));
        return;
      }
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (!sideways) return;
      event.preventDefault();
      const plot = document.querySelector<HTMLElement>('[data-track-plot]');
      const width = plot?.getBoundingClientRect().width || 1000;
      const { end } = currentWindow();
      const latest = traces.latestTime() ?? end;
      const next = end + (sideways / width) * tracks.windowSeconds;
      // Scrolling past the newest sample is back to live.
      tracks.pause(next >= latest ? null : next);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('wheel', wheel);
    };
  }, [ref]);
}

/** Space pauses, the arrow keys move the selection, Esc clears it, + and - zoom. */
function useTrackKeys(visible: readonly string[]) {
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (useDialogs.getState().paletteOpen) return;
      const tracks = useTracks.getState();
      const list = visibleRef.current;
      const current = tracks.selection?.kind === 'track' ? list.indexOf(tracks.selection.id) : -1;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          tracks.pause(tracks.frozenEnd === null ? (traces.latestTime() ?? Date.now() / 1000) : null);
          break;
        case 'ArrowDown':
        case 'ArrowUp': {
          if (!list.length) return;
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const next = current < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, current + step));
          tracks.select({ kind: 'track', id: list[next]! });
          break;
        }
        case 'Escape':
          tracks.select(null);
          break;
        case '+':
        case '=':
          tracks.setWindow(tracks.windowSeconds / 1.5);
          break;
        case '-':
          tracks.setWindow(tracks.windowSeconds * 1.5);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
