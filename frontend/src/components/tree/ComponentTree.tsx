import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  FolderTree,
  LineChart,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { ellipsize } from '../../lib/format';
import {
  buildNavigator,
  deviceSummary,
  expandableIds,
  filterNav,
  flattenNav,
  NAV_FILTERS,
  navCounts,
  openByDefault,
  trackSignalsOf,
  type NavFilter,
  type NavNode,
  type NavRow,
} from '../../lib/navigator';
import type { ComponentNode, LastValue } from '../../lib/types';
import { usePolling } from '../../lib/usePolling';
import { nodeBadges, pathTo, searchComponents } from '../../lib/views';
import { DeviceSyncChip } from '../time/TimeSync';
import { useDialogs } from '../../store/useDialogs';
import { openInScope, showAsTrack, showAsTracks, useTracks } from '../../store/useTracks';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { Button } from '../ui/Button';
import { Badge, EmptyState, ErrorState, Skeleton, StatusDot } from '../ui/Feedback';
import { ContextMenu, MenuButton, useContextMenu, type MenuItem } from '../ui/Menu';
import { NodeIcon, kindLabel } from './NodeIcon';

/** Horizontal step per level, and where level 0 starts inside the list. */
const INDENT = 16;
const GUTTER = 8;
/** How far into a row its icon's centre sits: a device's tile is wider. */
const ICON_CENTRE = { tile: 15, icon: 15 };

/** Readings kept per row for its trend; module scope so they survive a remount. */

/**
 * The Configure navigator.
 *
 * Devices first, with what is on them directly beneath - the SDK's storage
 * folders are gone and the folders that mean something ("AI", "CAN") are
 * captions (see `lib/navigator.ts`). Channels and blocks show their live
 * reading, so the list is a view of the running system rather than an index of
 * it. Filter chips replace the old tabs; the SDK's complete tree is one menu
 * item away for when its structure is the question.
 *
 * Rows are flattened from the projection so keyboard navigation, search and
 * rendering share one list, and only rows that are open exist in it.
 */
export function ComponentTree() {
  const tree = useSession((state) => state.tree);
  const treeLoading = useSession((state) => state.treeLoading);
  const treeError = useSession((state) => state.treeError);
  const selectedId = useSession((state) => state.selectedId);
  const select = useSession((state) => state.select);
  const refreshTree = useSession((state) => state.refreshTree);
  const openDialog = useDialogs((state) => state.open);

  const filter = useSettings((state) => state.navFilter);
  const completeTree = useSettings((state) => state.navCompleteTree);
  const includeHidden = useSettings((state) => state.includeHidden);
  const interval = useSettings((state) => state.lastValueInterval);
  const setSetting = useSettings((state) => state.set);
  const toggleSetting = useSettings((state) => state.toggle);

  const [query, setQuery] = useState('');
  /** Only the rows someone has opened or closed, `id -> open`; the rest is derived. */
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [values, setValues] = useState<Record<string, LastValue>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const projection = useMemo(
    () => (tree ? buildNavigator(tree, filter, includeHidden, completeTree) : []),
    [tree, filter, includeHidden, completeTree],
  );
  const counts = useMemo(() => (tree ? navCounts(tree, includeHidden) : null), [tree, includeHidden]);

  /** Everything above the selection opens, so a component picked elsewhere is shown. */
  const reveal = useMemo(
    () => new Set(tree && selectedId ? pathTo(tree, selectedId) : []),
    [tree, selectedId],
  );

  const searchHits = useMemo(() => {
    if (!tree || !query.trim()) return null;
    return new Set(searchComponents(tree, query, 200).map((hit) => hit.node.id));
  }, [tree, query]);

  const rows = useMemo(() => {
    const source = searchHits ? filterNav(projection, searchHits) : projection;
    const isOpen = (entry: NavNode) =>
      searchHits !== null || (overrides.get(entry.node.id) ?? (reveal.has(entry.node.id) || openByDefault(entry)));
    return flattenNav(source, isOpen);
  }, [projection, searchHits, overrides, reveal]);

  /** Where each row's indent guides fall: under the icon of every ancestor. */
  const guides = useMemo(() => {
    const centres: number[] = [];
    return rows.map((row) => {
      const kind = row.entry.node.kind;
      const own = GUTTER + row.depth * INDENT + (kind === 'device' || kind === 'instance' ? ICON_CENTRE.tile : ICON_CENTRE.icon);
      centres[row.depth] = own;
      return centres.slice(0, row.depth);
    });
  }, [rows]);

  // ---------------------------------------------------------------- live values

  const liveIds = useMemo(() => {
    const ids = rows.map((row) => row.entry.liveSignalId).filter((id): id is string => id !== null);
    return [...new Set(ids)].slice(0, 200);
  }, [rows]);
  const liveKey = liveIds.join('|');

  usePolling(
    async (signal) => {
      const response = await api.signals.lastValues(liveIds, undefined, includeHidden, signal);
      const next: Record<string, LastValue> = {};
      for (const value of response.values) next[value.id] = value;
      setValues(next);
    },
    Math.max(250, interval || 1000),
    [liveKey, includeHidden],
    { enabled: liveIds.length > 0 && interval > 0 },
  );

  // ---------------------------------------------------------------- expansion

  const toggle = useCallback((row: NavRow) => {
    setOverrides((current) => new Map(current).set(row.entry.node.id, !row.expanded));
  }, []);

  const expandable = useMemo(() => expandableIds(projection), [projection]);
  const setAll = useCallback(
    (open: boolean) => setOverrides(new Map(expandable.map((id) => [id, open]))),
    [expandable],
  );
  const allOpen = expandable.length > 0 && rows.filter((row) => row.expanded).length >= expandable.length;

  const changeFilter = (next: NavFilter) => {
    // Rows differ between filters, so what was opened in one means nothing here.
    setOverrides(new Map());
    setSetting('navFilter', next);
  };

  // ---------------------------------------------------------------- keyboard

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const index = rows.findIndex((row) => row.entry.node.id === selectedId);
      const current = index >= 0 ? rows[index] : undefined;
      const go = (row: NavRow | undefined) => row && void select(row.entry.node.id);
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          go(rows[Math.min(rows.length - 1, index + 1)]);
          break;
        case 'ArrowUp':
          event.preventDefault();
          go(rows[Math.max(0, index - 1)]);
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (current && current.entry.children.length > 0 && !current.expanded) toggle(current);
          else if (current?.expanded) go(rows[index + 1]);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (current?.expanded) toggle(current);
          else if (current?.parentId) void select(current.parentId);
          break;
        case 'Enter':
        case ' ':
          if (current && current.entry.children.length > 0) {
            event.preventDefault();
            toggle(current);
          }
          break;
        case 'Home':
          event.preventDefault();
          go(rows[0]);
          break;
        case 'End':
          event.preventDefault();
          go(rows[rows.length - 1]);
          break;
        default:
          break;
      }
    },
    [rows, select, selectedId, toggle],
  );

  useEffect(() => {
    if (!selectedId) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-node-id="${cssEscape(selectedId)}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, rows.length]);

  const menuItems: MenuItem[] = [
    {
      id: 'expand',
      label: allOpen ? 'Collapse all' : 'Expand all',
      icon: allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />,
      onSelect: () => setAll(!allOpen),
    },
    {
      id: 'complete',
      label: completeTree ? 'Back to the device view' : 'Complete tree',
      hint: completeTree ? undefined : 'with SDK folders',
      icon: <FolderTree size={13} />,
      onSelect: () => {
        setOverrides(new Map());
        toggleSetting('navCompleteTree');
      },
    },
    {
      id: 'hidden',
      label: includeHidden ? 'Hide hidden components' : 'Show hidden components',
      icon: includeHidden ? <EyeOff size={13} /> : <Eye size={13} />,
      onSelect: () => {
        toggleSetting('includeHidden');
        void refreshTree();
      },
    },
    {
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshCw size={13} />,
      separatorBefore: true,
      onSelect: () => void refreshTree(),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="@container space-y-2.5 border-b border-border px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-faint"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a device, channel, signal…"
              aria-label="Find components"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuery('');
                  event.currentTarget.blur();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  listRef.current?.focus();
                  const first = rows[0];
                  if (first && !rows.some((row) => row.entry.node.id === selectedId)) void select(first.entry.node.id);
                }
              }}
              className="h-8 w-full rounded-full border border-transparent bg-sunken pr-7 pl-8 text-[12.5px] transition-colors outline-none placeholder:text-text-faint hover:border-border focus:border-accent/50 focus:bg-panel"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-text-faint hover:text-text"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
          <MenuButton
            items={menuItems}
            ariaLabel="Navigator options"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-sunken hover:text-text"
          >
            {treeLoading ? <RefreshCw size={14} className="animate-spin" /> : <MoreHorizontal size={15} />}
          </MenuButton>
        </div>

        {completeTree ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-sunken px-3 py-1.5 text-[11.5px] text-text-muted">
            <FolderTree size={13} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Complete tree, with the SDK's own folders</span>
            <button
              type="button"
              onClick={() => {
                setOverrides(new Map());
                toggleSetting('navCompleteTree');
              }}
              className="shrink-0 font-medium text-accent hover:underline"
            >
              Done
            </button>
          </div>
        ) : (
          <div
            role="tablist"
            aria-label="Show"
            className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]"
          >
            {NAV_FILTERS.map((entry) => {
              const active = entry.id === filter;
              const count = counts && entry.id !== 'all' && counts[entry.id] > 0 ? counts[entry.id] : null;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={count !== null ? `${entry.label}: ${count}` : entry.label}
                  onClick={() => changeFilter(entry.id)}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors',
                    active
                      ? 'border-accent bg-accent text-panel'
                      : 'border-border text-text-muted hover:border-border-strong hover:text-text',
                  )}
                >
                  {entry.label}
                  {count !== null ? (
                    <span className={cn('hidden tabular text-[10.5px] @[23.5rem]:inline', active ? 'opacity-75' : 'text-text-faint')}>
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        ref={listRef}
        role="tree"
        aria-label="openDAQ components"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="@container min-h-0 flex-1 overflow-auto py-1.5 outline-none"
      >
        {treeError ? (
          <ErrorState title="Could not load the components" message={treeError} />
        ) : !tree && treeLoading ? (
          <div className="space-y-2 px-4 py-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <Skeleton key={index} className={index % 3 === 0 ? 'h-8' : 'h-5'} style={{ width: `${92 - index * 6}%` }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={query ? 'Nothing matches' : 'Nothing here yet'}
            description={
              query
                ? 'No name, id, description or tag matches this search.'
                : filter === 'blocks'
                  ? 'Add a function block to process or record signals.'
                  : 'Connect a device to see it here.'
            }
          />
        ) : (
          rows.map((row, index) => (
            <NavRowView
              key={`${row.parentId ?? ''}>${row.entry.node.id}`}
              row={row}
              guides={guides[index] ?? []}
              selected={row.entry.node.id === selectedId}
              flat={filter !== 'all' && !completeTree}
              value={row.entry.liveSignalId ? values[row.entry.liveSignalId] : undefined}
              onSelect={() => void select(row.entry.node.id)}
              onToggle={() => toggle(row)}
            />
          ))
        )}
      </div>

      {tree ? (
        <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={12} />}
            onClick={() => openDialog({ kind: 'addDevice', parentId: tree.id })}
            title="Connect a device"
          >
            Device
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={12} />}
            onClick={() => openDialog({ kind: 'addFunctionBlock', parentId: tree.id })}
            title="Add a function block"
          >
            Block
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One row, and the group caption above it when it starts a group. */
function NavRowView({
  row,
  guides,
  selected,
  flat,
  value,
  onSelect,
  onToggle,
}: {
  row: NavRow;
  guides: number[];
  selected: boolean;
  flat: boolean;
  value: LastValue | undefined;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { entry, depth, expanded } = row;
  const { node } = entry;
  const menu = useContextMenu();
  const items = useNodeMenu(node);
  const hasChildren = entry.children.length > 0;
  const big = !flat && (node.kind === 'device' || node.kind === 'instance');
  const badges = nodeBadges(node);
  const indent = GUTTER + depth * INDENT;

  const guideLines = guides.map((x) => (
    <span key={x} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: x }} />
  ));

  return (
    <>
      {row.caption ? (
        <div role="presentation" className="relative h-7">
          {guideLines}
          <span
            className="absolute bottom-1 text-[10px] font-semibold tracking-[0.08em] text-text-faint uppercase"
            style={{ left: indent + 8 }}
          >
            {row.caption}
          </span>
        </div>
      ) : null}

      <div className="relative" style={{ paddingLeft: indent, paddingRight: 8 }}>
        {guideLines}
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-level={depth + 1}
          data-node-id={node.id}
          data-signal-id={entry.liveSignalId ?? undefined}
          data-signal-label={node.displayName || node.localId}
          onClick={onSelect}
          onDoubleClick={() => hasChildren && onToggle()}
          onContextMenu={(event) => {
            onSelect();
            menu.open(event);
          }}
          title={`${kindLabel(node.kind)} — ${node.id}`}
          className={cn(
            'group relative flex cursor-default items-center gap-2.5 rounded-[9px] pr-1.5 pl-2 select-none',
            big ? 'my-0.5 h-12' : entry.context ? 'h-10' : 'h-8',
            'row-hover',
            selected && 'row-selected',
            !node.active && 'opacity-55',
          )}
        >
          {big ? <DeviceTile node={node} /> : <NodeIcon kind={node.kind} size={14} />}

          <div className="min-w-[4.5rem] flex-1 leading-tight">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'truncate',
                  big ? 'text-[13px] font-semibold' : 'text-[12.5px]',
                  selected && !big && 'font-medium',
                )}
              >
                {node.displayName || node.localId}
              </span>
              {badges.level === 'warning' || badges.level === 'error' ? (
                <StatusDot level={badges.level} title={node.status.message ?? badges.level} />
              ) : null}
              {node.kind === 'device' ? <DeviceSyncChip deviceId={node.id} /> : null}
            </div>
            {big || entry.context ? (
              <div className="mt-0.5 truncate text-[11px] text-text-faint">
                {big ? deviceSummary(entry) || kindLabel(node.kind) : entry.context}
              </div>
            ) : null}
          </div>

          {badges.labels.filter((label) => label !== 'err' && label !== 'warn').slice(0, 2).map((label) => (
            <Badge key={label} tone={label === 'recording' ? 'brand' : label === 'disconnected' ? 'err' : 'neutral'}>
              {label}
            </Badge>
          ))}

          {entry.liveSignalId ? (
            <LiveReading value={value} signalIds={trackSignalsOf(node, useSettings.getState().includeHidden)} />
          ) : null}

          {hasChildren ? (
            <button
              type="button"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-sunken hover:text-text"
            >
              <ChevronRight
                size={13}
                className="transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)]"
                style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
              />
            </button>
          ) : null}
        </div>
      </div>

      {menu.anchor ? (
        <ContextMenu items={items} anchor={menu.anchor} onClose={menu.close} ariaLabel={`Actions for ${node.name}`} />
      ) : null}
    </>
  );
}

/** A device's icon on a tile, with its connection as a dot on the corner. */
function DeviceTile({ node }: { node: ComponentNode }) {
  const connected = node.device?.connected ?? true;
  return (
    <span className="relative flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-border bg-surface">
      <NodeIcon kind={node.kind} size={15} />
      {node.kind === 'device' ? (
        <span
          aria-label={connected ? 'Connected' : 'Disconnected'}
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-panel',
            connected ? 'bg-ok' : 'bg-err',
          )}
        />
      ) : null}
    </span>
  );
}

/**
 * The signal's last value as openDAQ reports it; on hover, a way to show it
 * as a track. On a channel or block that shows all of its signals.
 */
function LiveReading({ value, signalIds }: { value: LastValue | undefined; signalIds: string[] }) {
  const isTrack = useTracks((state) => signalIds.every((id) => state.tracks.includes(id)));
  const many = signalIds.length > 1;
  const label = isTrack ? (many ? 'Show their tracks' : 'Show its track') : many ? `Show its ${signalIds.length} signals as tracks` : 'Show as a track';
  const text = value?.error ? 'error' : value?.displayValue;
  if (!text) return null;

  return (
    <span className="relative flex min-w-0 shrink items-center gap-2">
      <span
        className={cn(
          'num max-w-[6.5rem] min-w-0 truncate text-right text-[11.5px] tabular transition-opacity group-hover:opacity-0',
          value?.error ? 'text-err' : 'text-text-muted',
        )}
        title={value?.error ?? text ?? undefined}
      >
        {text ?? ''}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          showAsTracks(signalIds);
        }}
        className="absolute right-0 flex h-6 items-center gap-1 rounded-full border border-border bg-panel px-2 text-[11px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text disabled:text-text-faint"
      >
        <LineChart size={11} /> Track
      </button>
    </span>
  );
}

/** The context-menu entries that apply to one node. */
function useNodeMenu(node: ComponentNode): MenuItem[] {
  const openDialog = useDialogs((state) => state.open);

  return useMemo(() => {
    const items: MenuItem[] = [];
    const isDevice = node.kind === 'device' || node.kind === 'instance';
    const isBlock = node.kind === 'functionBlock' || node.kind === 'recorder' || node.kind === 'channel';

    if (node.kind === 'signal') {
      items.push({
        id: 'track',
        label: 'Show as a track',
        icon: <Activity size={13} />,
        onSelect: () => showAsTrack(node.id),
      });
      items.push({
        id: 'scope',
        label: 'Open in the Scope',
        icon: <LineChart size={13} />,
        onSelect: () => openInScope(node.id, node.name),
      });
      items.push({
        id: 'descriptor',
        label: 'Data descriptor…',
        onSelect: () => openDialog({ kind: 'descriptor', signalId: node.id }),
      });
    }

    if (node.kind === 'channel' || node.kind === 'functionBlock' || node.kind === 'recorder') {
      const signals = trackSignalsOf(node, useSettings.getState().includeHidden);
      if (signals.length) {
        items.push({
          id: 'tracks',
          label: signals.length === 1 ? 'Show its signal as a track' : `Show its ${signals.length} signals as tracks`,
          icon: <Activity size={13} />,
          onSelect: () => showAsTracks(signals),
        });
      }
    }

    if (isDevice) {
      items.push({
        id: 'addDevice',
        label: 'Add device…',
        icon: <Plus size={13} />,
        separatorBefore: items.length > 0,
        onSelect: () => openDialog({ kind: 'addDevice', parentId: node.id }),
      });
    }

    if (isDevice || (isBlock && node.functionBlock?.hasFunctionBlockTypes)) {
      items.push({
        id: 'addFunctionBlock',
        label: 'Add function block…',
        icon: <Plus size={13} />,
        onSelect: () => openDialog({ kind: 'addFunctionBlock', parentId: node.id }),
      });
    }

    items.push({
      id: 'attributes',
      label: 'Attributes…',
      separatorBefore: items.length > 0,
      onSelect: () => openDialog({ kind: 'attributes', componentId: node.id }),
    });

    if (Object.keys(node.status.statuses).length > 0) {
      items.push({
        id: 'statuses',
        label: 'Statuses…',
        onSelect: () => openDialog({ kind: 'statuses', componentId: node.id }),
      });
    }

    items.push({
      id: 'active',
      label: node.active ? 'Deactivate' : 'Activate',
      disabled: !node.parentActive,
      hint: node.parentActive ? undefined : 'parent inactive',
      onSelect: () => void actions.setActive(node.id, !node.active),
    });

    // Update blocks apply to any property object, matching the SDK demo.
    items.push({ id: 'update-heading', label: 'Property updates', heading: true, separatorBefore: true });
    items.push({
      id: 'beginUpdate',
      label: 'Begin update block',
      disabled: node.updating,
      onSelect: () => void actions.beginUpdate(node.id),
    });
    items.push({
      id: 'endUpdate',
      label: 'Commit update block',
      disabled: !node.updating,
      onSelect: () => void actions.endUpdate(node.id),
    });
    items.push({
      id: 'clearProperties',
      label: 'Reset all properties',
      onSelect: () => actions.clearProperties(node.id, node.name),
    });

    if (node.kind === 'device' && !node.device?.isRoot) {
      items.push({
        id: 'lock',
        label: node.device?.locked ? 'Unlock' : 'Lock',
        icon: node.device?.locked ? <Unlock size={13} /> : <Lock size={13} />,
        separatorBefore: true,
        onSelect: () =>
          node.device?.locked
            ? void actions.setLock(node.id, false)
            : void actions.setLock(node.id, true),
      });
      if (node.device?.locked) {
        items.push({
          id: 'forceUnlock',
          label: 'Force unlock…',
          onSelect: () => actions.forceUnlock(node.id, node.name),
        });
      }
      items.push({
        id: 'removeDevice',
        label: 'Disconnect device…',
        icon: <Trash2 size={13} />,
        destructive: true,
        onSelect: () => actions.removeDevice(node.id, node.name),
      });
    }

    if (node.kind === 'functionBlock' || node.kind === 'recorder') {
      items.push({
        id: 'removeBlock',
        label: 'Remove function block…',
        icon: <Trash2 size={13} />,
        destructive: true,
        separatorBefore: true,
        onSelect: () => actions.removeFunctionBlock(node.id, node.name),
      });
    }

    if (node.kind === 'server') {
      items.push({
        id: 'discoveryOn',
        label: 'Enable discovery',
        separatorBefore: true,
        onSelect: () => void actions.setServerDiscovery(node.id, true),
      });
      items.push({
        id: 'discoveryOff',
        label: 'Disable discovery',
        onSelect: () => void actions.setServerDiscovery(node.id, false),
      });
      items.push({
        id: 'removeServer',
        label: 'Stop server…',
        icon: <Trash2 size={13} />,
        destructive: true,
        onSelect: () => actions.removeServer(node.id, node.name),
      });
    }

    items.push({
      id: 'copyId',
      label: 'Copy global id',
      separatorBefore: true,
      onSelect: () => void navigator.clipboard?.writeText(node.id).catch(() => undefined),
      hint: ellipsize(node.id, 24, true),
    });

    return items;
  }, [node, openDialog]);
}

/** `CSS.escape` is not in every target browser we care about. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
