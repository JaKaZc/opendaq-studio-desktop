import { useMemo, useState } from 'react';
import { ListPlus, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { groupInOrder, signalOwnerId, signalOwnerName } from '../../lib/views';
import { useCollapsed } from '../../store/useCollapsed';
import { useSession } from '../../store/useSession';
import { useTracks } from '../../store/useTracks';
import { GroupToggle } from '../ui/GroupToggle';
import { deviceIdOf, deviceName, useSignalData } from './signalData';

/**
 * Choose which signals are tracks: every chartable signal, grouped by device
 * and then by the channel or function block that owns it. Each group folds,
 * and the box of a channel adds or removes all of its signals. A search shows
 * every match whether or not its group is folded.
 */
export function TrackPicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const tree = useSession((state) => state.tree);
  const signals = useSignalData((state) => state.signals);
  const tracks = useTracks((state) => state.tracks);
  const addTracks = useTracks((state) => state.addTracks);
  const removeTrack = useTracks((state) => state.removeTrack);
  const collapsed = useCollapsed((state) => state.collapsed);
  const searching = query.trim() !== '';
  const shown = new Set(tracks);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Each signal with the channel or function block that owns it, so signals
    // of the same name on one device can be told apart, sorted by owner.
    const owned = signals
      .map((signal) => ({ signal, owner: signalOwnerName(signal, tree) }))
      .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? ''));
    const map = new Map<string | null, typeof owned>();
    for (const entry of owned) {
      const { signal, owner } = entry;
      if (needle && !`${owner ?? ''} ${signal.name} ${signal.id}`.toLowerCase().includes(needle)) continue;
      const device = deviceIdOf(signal, tree);
      map.set(device, [...(map.get(device) ?? []), entry]);
    }
    return [...map.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null));
  }, [query, signals, tree]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[12px] font-medium hover:border-border-strong',
          open && 'border-accent/50 text-accent',
        )}
      >
        <ListPlus size={13} /> Tracks
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="animate-enter absolute top-9 right-0 z-50 flex max-h-[70vh] w-80 flex-col rounded-[12px] border border-border bg-elevated shadow-popover">
            <div className="relative border-b border-border p-2">
              <Search size={12} className="pointer-events-none absolute top-1/2 left-4.5 -translate-y-1/2 text-text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a signal"
                aria-label="Find a signal"
                className="h-7 w-full rounded-full bg-sunken pr-2 pl-7 text-[12px] outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {groups.length === 0 ? <p className="px-4 py-4 text-[12px] text-text-muted">No signal matches.</p> : null}
              {groups.map(([device, list]) => {
                const deviceKey = `picker:${device ?? 'instance'}`;
                return (
                  <div key={device ?? 'instance'}>
                    <div className="flex items-center gap-1 px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-text-faint uppercase">
                      <GroupToggle groupKey={deviceKey} label={deviceName(device, tree)} />
                      <span className="min-w-0 flex-1 truncate">{deviceName(device, tree)}</span>
                      <span className="font-normal tracking-normal normal-case">{list.length}</span>
                    </div>
                    {collapsed.has(deviceKey) && !searching
                      ? null
                      : groupInOrder(list, ({ signal }) => signalOwnerId(signal)).map((owned) => {
                          const ownerKey = `picker:${owned.key ?? `${device ?? 'instance'}:device`}`;
                          const ownerName = owned.items[0]?.owner ?? null;
                          const ids = owned.items.map(({ signal }) => signal.id);
                          const count = ids.filter((id) => shown.has(id)).length;
                          return (
                            <div key={ownerKey}>
                              {ownerName ? (
                                <div className="mx-1.5 flex items-center gap-1.5 rounded-[6px] py-0.5 pr-2.5 pl-3 text-[12px] text-text-muted">
                                  <GroupToggle groupKey={ownerKey} label={ownerName} />
                                  <input
                                    type="checkbox"
                                    checked={count === ids.length}
                                    ref={(box) => {
                                      if (box) box.indeterminate = count > 0 && count < ids.length;
                                    }}
                                    onChange={() =>
                                      count === ids.length ? ids.forEach(removeTrack) : addTracks(ids.filter((id) => !shown.has(id)))
                                    }
                                    aria-label={`All signals of ${ownerName}`}
                                    className="size-3.5 accent-[var(--color-accent)]"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-medium">{ownerName}</span>
                                  <span className="text-[11px] text-text-faint">
                                    {count}/{ids.length}
                                  </span>
                                </div>
                              ) : null}
                              {ownerName && collapsed.has(ownerKey) && !searching
                                ? null
                                : owned.items.map(({ signal }) => (
                                    <label
                                      key={signal.id}
                                      className={cn(
                                        'row-hover mx-1.5 flex cursor-pointer items-center gap-2 rounded-[6px] py-1 pr-2.5 text-[12.5px]',
                                        ownerName ? 'pl-12' : 'pl-3',
                                      )}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={shown.has(signal.id)}
                                        onChange={() => (shown.has(signal.id) ? removeTrack(signal.id) : addTracks([signal.id]))}
                                        className="size-3.5 accent-[var(--color-accent)]"
                                      />
                                      <span className="min-w-0 flex-1 truncate">{signal.name}</span>
                                      {signal.shape === 'array' ? (
                                        <span
                                          className="rounded border border-border px-1 text-[10px] text-text-faint"
                                          title="An array per sample, such as a spectrum"
                                        >
                                          array
                                        </span>
                                      ) : null}
                                      {/* A picture's unit names its file format, which says nothing here. */}
                                      <span className="text-[11px] text-text-faint">
                                        {signal.image ? (signal.image === 'plot' ? 'plot' : 'picture') : (signal.unit?.symbol ?? '')}
                                      </span>
                                    </label>
                                  ))}
                            </div>
                          );
                        })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
