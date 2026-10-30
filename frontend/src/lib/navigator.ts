/**
 * The Configure navigator, as data.
 *
 * openDAQ stores a device as folders - `Dev`, `IO`, `FB`, `Sig`, `IP`, `Srv` -
 * and a tree that shows them makes someone click through `Devices ›
 * Inputs/Outputs › AI` to reach a channel. People think in devices and what is
 * on them, so this projection puts a device's channels, blocks and sub-devices
 * directly under it, and turns the folders that *mean* something ("AI", "CAN")
 * into captions above their rows. Storage-only folders disappear.
 *
 * The flat filters answer "where is this one thing": every row carries where it
 * lives as a second line, because without the tree around it a list of eight
 * "AI0"s is useless.
 *
 * The SDK's structure is not hidden for good - the complete tree is one menu
 * item away - but it is no longer what everyone has to read first.
 */

import type { ComponentNode } from './types';

export type NavFilter = 'all' | 'devices' | 'channels' | 'signals' | 'blocks';

export const NAV_FILTERS: { id: NavFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'devices', label: 'Devices' },
  { id: 'channels', label: 'Channels' },
  { id: 'signals', label: 'Signals' },
  { id: 'blocks', label: 'Blocks' },
];

export interface NavNode {
  node: ComponentNode;
  children: NavNode[];
  /**
   * The caption this row sits under among its siblings ("AI", "Function
   * blocks"). Shown once, above the first row of the group.
   */
  group: string | null;
  /** A second line saying where the component lives, for the flat filters. */
  context: string | null;
  /** The value signal whose live reading the row shows. */
  liveSignalId: string | null;
}

const BLOCK_KINDS = new Set(['functionBlock', 'recorder']);
/** Folders that exist only to store things; their contents are placed by kind. */
const STORAGE_FOLDERS = new Set(['Dev', 'IO', 'FB', 'Sig', 'IP', 'Srv']);

const GROUP_DEVICES = 'Devices';
const GROUP_BLOCKS = 'Function blocks';
const GROUP_CHANNELS = 'Channels';
const GROUP_COMPONENTS = 'Components';

function isBlock(node: ComponentNode): boolean {
  return BLOCK_KINDS.has(node.kind);
}

function isDeviceLike(node: ComponentNode): boolean {
  return node.kind === 'device' || node.kind === 'instance';
}

/**
 * The value signal a component's row reads: its first output that has a domain
 * signal - one without is a clock, not a measurement - or, failing that, its
 * first output at all.
 *
 * Only channels and blocks have one. A device's own signals are usually its
 * clock, and its row has better things to say (its mode, what is on it).
 */
export function liveSignalOf(node: ComponentNode, includeHidden = false): string | null {
  if (node.kind === 'signal') return node.id;
  if (node.kind !== 'channel' && !isBlock(node)) return null;
  const outputs = node.children.find((child) => child.kind === 'folder' && child.localId === 'Sig');
  const signals = (outputs?.children ?? []).filter(
    (child) => child.kind === 'signal' && (includeHidden || child.visible),
  );
  return (signals.find((signal) => signal.signal?.domainSignalId) ?? signals[0])?.id ?? null;
}

/**
 * The signals a channel's or block's Track button shows: every output signal
 * with a domain, so not the clock itself, or the live one if none has one.
 */
export function trackSignalsOf(node: ComponentNode, includeHidden = false): string[] {
  if (node.kind === 'signal') return [node.id];
  if (node.kind !== 'channel' && !isBlock(node)) return [];
  const outputs = node.children.find((child) => child.kind === 'folder' && child.localId === 'Sig');
  const withDomain = (outputs?.children ?? []).filter(
    (child) => child.kind === 'signal' && (includeHidden || child.visible) && child.signal?.domainSignalId,
  );
  if (withDomain.length) return withDomain.map((signal) => signal.id);
  const live = liveSignalOf(node, includeHidden);
  return live ? [live] : [];
}

// --------------------------------------------------------------------------- "all"

interface Placed {
  node: ComponentNode;
  group: string;
  /** Sort bucket, so a device reads channels → blocks → devices → the rest. */
  bucket: number;
}

/**
 * What goes directly under a device in the navigator, found through its folders.
 *
 * `label` is the caption the folder path so far gives: a channel inside
 * `IO/AI` is under "AI"; one inside `IO/AI/Fast` under "AI / Fast".
 */
function placeUnder(parent: ComponentNode, visible: (node: ComponentNode) => boolean): Placed[] {
  const root = parent.kind === 'instance';
  const bucket = (kind: 'channel' | 'block' | 'device' | 'other') =>
    root
      ? { device: 0, block: 1, channel: 2, other: 3 }[kind]
      : { channel: 0, block: 1, device: 2, other: 3 }[kind];

  const placed: Placed[] = [];
  const visit = (node: ComponentNode, label: string | null) => {
    for (const child of node.children) {
      if (!visible(child)) continue;
      if (child.kind === 'folder') {
        if (child.localId === 'Sig' || child.localId === 'IP' || child.localId === 'Srv') continue;
        if (child.isDefaultFolder && STORAGE_FOLDERS.has(child.localId)) {
          visit(child, label);
        } else {
          visit(child, label ? `${label} / ${child.name}` : child.name);
        }
        continue;
      }
      if (child.kind === 'signal' || child.kind === 'inputPort' || child.kind === 'server') continue;
      if (child.kind === 'channel') {
        placed.push({ node: child, group: label ?? GROUP_CHANNELS, bucket: bucket('channel') });
      } else if (isBlock(child)) {
        placed.push({ node: child, group: label ?? GROUP_BLOCKS, bucket: bucket('block') });
      } else if (isDeviceLike(child)) {
        placed.push({ node: child, group: label ?? GROUP_DEVICES, bucket: bucket('device') });
      } else {
        placed.push({ node: child, group: label ?? GROUP_COMPONENTS, bucket: bucket('other') });
      }
    }
  };
  visit(parent, null);
  // Stable: tree order within a bucket, which is the order the device reports.
  return placed.map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.bucket - b.entry.bucket || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Blocks nested in a channel or block, through its `FB` folder. */
function nestedBlocks(node: ComponentNode, visible: (node: ComponentNode) => boolean, includeHidden: boolean): NavNode[] {
  const found: NavNode[] = [];
  const visit = (current: ComponentNode) => {
    for (const child of current.children) {
      if (!visible(child)) continue;
      if (isBlock(child)) {
        found.push({
          node: child,
          children: nestedBlocks(child, visible, includeHidden),
          group: null,
          context: null,
          liveSignalId: liveSignalOf(child, includeHidden),
        });
      } else if (child.kind === 'folder' && child.localId === 'FB') {
        visit(child);
      }
    }
  };
  visit(node);
  return found;
}

function buildAll(root: ComponentNode, includeHidden: boolean): NavNode[] {
  const visible = (node: ComponentNode) => includeHidden || node.visible;
  const build = (node: ComponentNode, group: string | null): NavNode => {
    let children: NavNode[];
    if (isDeviceLike(node)) {
      children = placeUnder(node, visible).map((placed) => build(placed.node, placed.group));
    } else if (node.kind === 'channel' || isBlock(node)) {
      children = nestedBlocks(node, visible, includeHidden);
    } else {
      // A custom component: show what it holds that the navigator knows how to place.
      children = placeUnder(node, visible).map((placed) => build(placed.node, placed.group));
    }
    return { node, children, group, context: null, liveSignalId: liveSignalOf(node, includeHidden) };
  };
  return [build(root, null)];
}

// --------------------------------------------------------------------------- flat

/** Every node in tree order, with its ancestors, for the flat filters. */
function withAncestors(
  root: ComponentNode,
  visible: (node: ComponentNode) => boolean,
): { node: ComponentNode; ancestors: ComponentNode[] }[] {
  const out: { node: ComponentNode; ancestors: ComponentNode[] }[] = [];
  const walk = (node: ComponentNode, ancestors: ComponentNode[]) => {
    if (!visible(node)) return;
    out.push({ node, ancestors });
    for (const child of node.children) walk(child, [...ancestors, node]);
  };
  walk(root, []);
  return out;
}

const nameOf = (node: ComponentNode) => node.displayName || node.name || node.localId;

/**
 * "RefCh0 · RefDev0": the nearest named owner and the device it is on.
 *
 * Storage folders are skipped - "Sig" tells nobody anything - and the device is
 * left out when the owner *is* the device.
 */
export function contextFor(ancestors: readonly ComponentNode[]): string | null {
  const meaningful = ancestors.filter((node) => !(node.kind === 'folder' && node.isDefaultFolder));
  const owner = meaningful[meaningful.length - 1];
  if (!owner) return null;
  const device = [...meaningful].reverse().find(isDeviceLike);
  if (!device || device === owner) return nameOf(owner);
  return `${nameOf(owner)} · ${nameOf(device)}`;
}

function buildFlat(root: ComponentNode, filter: Exclude<NavFilter, 'all'>, includeHidden: boolean): NavNode[] {
  const visible = (node: ComponentNode) => includeHidden || node.visible;
  const entries = withAncestors(root, visible);
  const row = (node: ComponentNode, ancestors: ComponentNode[], children: NavNode[] = []): NavNode => ({
    node,
    children,
    group: null,
    context: contextFor(ancestors),
    liveSignalId: liveSignalOf(node, includeHidden),
  });

  switch (filter) {
    case 'devices':
      return entries.filter(({ node }) => node.kind === 'device').map(({ node, ancestors }) => row(node, ancestors));
    case 'channels':
      return entries
        .filter(({ node }) => node.kind === 'channel')
        .map(({ node, ancestors }) => row(node, ancestors, nestedBlocks(node, visible, includeHidden)));
    case 'signals':
      return entries.filter(({ node }) => node.kind === 'signal').map(({ node, ancestors }) => row(node, ancestors));
    case 'blocks':
      // Top-level blocks only: one nested in another appears under it.
      return entries
        .filter(({ node, ancestors }) => isBlock(node) && !ancestors.some((ancestor) => isBlock(ancestor) || ancestor.kind === 'channel'))
        .map(({ node, ancestors }) => row(node, ancestors, nestedBlocks(node, visible, includeHidden)));
  }
}

// --------------------------------------------------------------------------- public

/** The navigator's rows for a filter, or the SDK's complete tree when asked. */
export function buildNavigator(
  root: ComponentNode,
  filter: NavFilter,
  includeHidden: boolean,
  completeTree = false,
): NavNode[] {
  if (completeTree) return buildComplete(root, includeHidden);
  return filter === 'all' ? buildAll(root, includeHidden) : buildFlat(root, filter, includeHidden);
}

/** Every component exactly where the SDK keeps it, folders included. */
function buildComplete(root: ComponentNode, includeHidden: boolean): NavNode[] {
  const build = (node: ComponentNode): NavNode => ({
    node,
    children: node.children.filter((child) => includeHidden || child.visible).map(build),
    group: null,
    context: null,
    liveSignalId: node.kind === 'signal' ? node.id : null,
  });
  return includeHidden || root.visible ? [build(root)] : [];
}

/** How many rows each filter chip would show. */
export function navCounts(root: ComponentNode, includeHidden: boolean): Record<NavFilter, number> {
  const visible = (node: ComponentNode) => includeHidden || node.visible;
  const counts: Record<NavFilter, number> = { all: 0, devices: 0, channels: 0, signals: 0, blocks: 0 };
  for (const { node } of withAncestors(root, visible)) {
    if (node.kind === 'device') counts.devices += 1;
    else if (node.kind === 'channel') counts.channels += 1;
    else if (node.kind === 'signal') counts.signals += 1;
    else if (isBlock(node)) counts.blocks += 1;
  }
  counts.all = counts.devices + counts.channels + counts.blocks;
  return counts;
}

/** Devices start open, so the system is visible on load; everything else closed. */
export function openByDefault(entry: NavNode): boolean {
  return isDeviceLike(entry.node);
}

/**
 * Keep rows that match, and the rows that lead to them.
 *
 * A match keeps its own subtree too: finding a device should show what is on it.
 */
export function filterNav(nodes: readonly NavNode[], matches: ReadonlySet<string>): NavNode[] {
  const keep = (entry: NavNode): NavNode | null => {
    if (matches.has(entry.node.id)) return entry;
    const children = entry.children.map(keep).filter((child): child is NavNode => child !== null);
    return children.length > 0 ? { ...entry, children } : null;
  };
  return nodes.map(keep).filter((entry): entry is NavNode => entry !== null);
}

export interface NavRow {
  entry: NavNode;
  depth: number;
  parentId: string | null;
  /** A caption to draw above this row: the first of its group among its siblings. */
  caption: string | null;
  expanded: boolean;
}

/** The rows on screen, depth first, with captions where a group starts. */
export function flattenNav(nodes: readonly NavNode[], isOpen: (entry: NavNode) => boolean): NavRow[] {
  const rows: NavRow[] = [];
  const push = (list: readonly NavNode[], depth: number, parentId: string | null) => {
    let previousGroup: string | null = null;
    for (const entry of list) {
      const caption = entry.group && entry.group !== previousGroup ? entry.group : null;
      previousGroup = entry.group;
      const expanded = entry.children.length > 0 && isOpen(entry);
      rows.push({ entry, depth, parentId, caption, expanded });
      if (expanded) push(entry.children, depth + 1, entry.node.id);
    }
  };
  push(nodes, 0, null);
  return rows;
}

/** Ids of every row that has children, for expand / collapse all. */
export function expandableIds(nodes: readonly NavNode[]): string[] {
  const ids: string[] = [];
  const push = (list: readonly NavNode[]) => {
    for (const entry of list) {
      if (entry.children.length > 0) ids.push(entry.node.id);
      push(entry.children);
    }
  };
  push(nodes);
  return ids;
}

/** "Safe operation · 2 channels", the second line of a device row. */
export function deviceSummary(entry: NavNode): string {
  const mode = entry.node.device?.operationMode;
  const parts: string[] = [];
  if (mode && mode !== 'Unknown') parts.push(mode === 'SafeOperation' ? 'Safe operation' : mode);
  const count = (kind: (node: ComponentNode) => boolean) => entry.children.filter((child) => kind(child.node)).length;
  const channels = count((node) => node.kind === 'channel');
  const blocks = count(isBlock);
  const devices = count((node) => node.kind === 'device');
  if (devices) parts.push(`${devices} device${devices === 1 ? '' : 's'}`);
  if (channels) parts.push(`${channels} channel${channels === 1 ? '' : 's'}`);
  if (blocks) parts.push(`${blocks} block${blocks === 1 ? '' : 's'}`);
  if (entry.node.device && !entry.node.device.connected) parts.unshift('Disconnected');
  return parts.join(' · ');
}
