/**
 * Turning the topology graph into a diagram of blocks.
 *
 * The picture is drawn the way dataflow editors draw it. Each channel,
 * function block, recorder and server is one block: its input ports are rows
 * on the left, and the signals it produces are rows on the right, each with
 * its live value. A line runs only where something actually flows: from a
 * signal's row to the input port that reads it. Devices are the boxes drawn
 * around what belongs to them.
 *
 * Drawing every signal as a node of its own, as before, turned a phone with
 * dozens of sensor signals into a tangle of long lines. With signals as rows,
 * a device is a handful of blocks, and the lines left are the connections a
 * reader wants to follow.
 *
 * The layout:
 *
 * 1. **layer** each block by the longest path along connections, so a line
 *    always runs to the right; the columns are the same for every device;
 * 2. **order** each column by where its neighbours are, swept both ways;
 * 3. **place** each device as a band of its own, the devices inside a device
 *    first and its own blocks after them, each block level with the first
 *    block that feeds it where there is room;
 * 4. put the blocks with no connection in a grid **to the right** of every
 *    column of the flow, where no line runs through them.
 *
 * It is a pure function of the payload, so it can be tested without a DOM,
 * and the same input always gives the same picture.
 */

import type { GraphEdge, GraphGroup, GraphNode, TopologyGraph } from './types';

export interface LayoutOptions {
  /** Draw domain (timestamp) signals as rows too. */
  showDomain?: boolean;
  /** Leave out the blocks no connection reads from or into. */
  onlyConnected?: boolean;
}

/** An input port on the left of a block, or an output signal on its right. */
export interface BlockRow {
  /** The port's or the signal's global ID. */
  id: string;
  name: string;
  side: 'input' | 'output';
  /** Offset of the row's middle from the block's top edge. */
  y: number;
  /** On an input port: the signal connected to it. */
  signalId: string | null;
  requiresSignal: boolean;
  /** On an output: the signal itself. */
  signal: GraphNode | null;
}

export interface LayoutBlock {
  /** The component, or for the signals a device produces itself, a stand-in. */
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  inputs: BlockRow[];
  outputs: BlockRow[];
  /** Whether a connection reads from it or into it. */
  connected: boolean;
  /** Its place along the flow, from the left. */
  layer: number;
}

export interface LayoutEdge {
  edge: GraphEdge;
  sourceBlock: string;
  targetBlock: string;
  /** The signal's output row and the input port's row. */
  sourceRow: string;
  targetRow: string;
  path: string;
  labelX: number;
  labelY: number;
}

export interface LayoutGroup {
  group: GraphGroup;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Nesting level, so a device inside a device draws inset. */
  depth: number;
}

export interface DiagramLayout {
  blocks: LayoutBlock[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  width: number;
  height: number;
}

const BLOCK_WIDTH = 232;
const BLOCK_HEADER = 42;
const ROW = 18;
const BLOCK_PADDING = 8;
const COLUMN_GAP = 96;
const ROW_GAP = 18;
const GROUP_PADDING = 20;
const GROUP_HEADER = 26;
const MARGIN = 32;
const ORDER_PASSES = 4;
/** Blocks with no connection are laid out in rows of this many. */
const GRID_COLUMNS = 4;
/** The prefix of the stand-in block for the signals a device produces itself. */
export const DEVICE_SIGNALS_PREFIX = 'signals:';

const BLOCK_KINDS = new Set(['channel', 'functionBlock', 'recorder', 'server']);

function blockHeight(rows: number): number {
  return BLOCK_HEADER + (rows === 0 ? 0 : rows * ROW + BLOCK_PADDING);
}

function isDomain(node: GraphNode): boolean {
  return (node.detail as { isDomain?: boolean }).isDomain === true;
}

const EMPTY: DiagramLayout = { blocks: [], edges: [], groups: [], width: 0, height: 0 };

export function layoutGraph(graph: TopologyGraph, options: LayoutOptions = {}): DiagramLayout {
  const { showDomain = false, onlyConnected = false } = options;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

  // Blocks, and the signals each produces. Signals a device produces itself
  // go to a stand-in block of the device's own signals.
  const blocks = new Map<string, GraphNode>();
  const outputs = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (BLOCK_KINDS.has(node.kind)) {
      blocks.set(node.id, node);
      outputs.set(node.id, []);
    }
  }
  const producerOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'produces') continue;
    const signal = nodes.get(edge.target);
    const source = nodes.get(edge.source);
    if (!signal || !source || signal.kind !== 'signal') continue;
    if (!showDomain && isDomain(signal)) continue;
    let owner = source.id;
    if (!blocks.has(owner)) {
      owner = `${DEVICE_SIGNALS_PREFIX}${source.id}`;
      if (!blocks.has(owner)) {
        const isDevice = source.kind === 'device' || source.kind === 'instance';
        blocks.set(owner, {
          id: owner,
          kind: 'deviceSignals',
          name: source.name ? `${source.name} signals` : 'Signals',
          groupId: isDevice ? source.id : source.groupId,
          active: true,
          status: null,
          detail: {},
        });
        outputs.set(owner, []);
      }
    }
    outputs.get(owner)!.push(signal);
    producerOf.set(signal.id, owner);
  }

  // Connections between blocks: a signal read through an input port.
  const connections: GraphEdge[] = [];
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'signal') continue;
    const source = producerOf.get(edge.source);
    if (!source || !blocks.has(edge.target)) continue;
    connections.push(edge);
    if (!inbound.has(edge.target)) inbound.set(edge.target, new Set());
    inbound.get(edge.target)!.add(source);
    if (!outbound.has(source)) outbound.set(source, new Set());
    outbound.get(source)!.add(edge.target);
  }
  const connected = new Set([...inbound.keys(), ...outbound.keys()]);
  if (onlyConnected) {
    for (const id of [...blocks.keys()]) if (!connected.has(id)) blocks.delete(id);
  }
  if (blocks.size === 0) return EMPTY;

  // Longest path layering, tolerant of a block reading its own output.
  const layer = new Map<string, number>();
  const active = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (active.has(id)) return 0;
    active.add(id);
    let best = 0;
    for (const source of inbound.get(id) ?? []) best = Math.max(best, depth(source) + 1);
    active.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of blocks.keys()) depth(id);

  // How many columns the flow takes, the same for every device.
  const flowLayers = [...connected].filter((id) => blocks.get(id)?.kind !== 'server').map((id) => layer.get(id) ?? 0);
  const flowColumns = flowLayers.length ? Math.max(...flowLayers) + 1 : 0;
  const step = BLOCK_WIDTH + COLUMN_GAP;

  const known = new Set(graph.groups.map((group) => group.id));
  const childrenOf = (parentId: string | null) =>
    graph.groups.filter((group) => (group.parentId !== null && known.has(group.parentId) ? group.parentId : null) === parentId);
  const groupDepth = new Map<string, number>();
  for (const group of graph.groups) {
    let d = 0;
    for (let parent = group.parentId; parent !== null && known.has(parent) && d < 16; d += 1) {
      parent = graph.groups.find((g) => g.id === parent)?.parentId ?? null;
    }
    groupDepth.set(group.id, d);
  }

  const placed = new Map<string, LayoutBlock>();
  let cursor = MARGIN;
  let rightmost = MARGIN;

  const rowsOf = (node: GraphNode) => node.ports?.length ?? 0;
  const heightOf = (node: GraphNode) => blockHeight(rowsOf(node) + (outputs.get(node.id)?.length ?? 0));

  const place = (node: GraphNode, x: number, y: number) => {
    const ports = node.ports ?? [];
    const inputs: BlockRow[] = ports.map((port, index) => ({
      id: port.id,
      name: port.name,
      side: 'input',
      y: BLOCK_HEADER + index * ROW + ROW / 2,
      signalId: port.signalId,
      requiresSignal: port.requiresSignal,
      signal: null,
    }));
    const rows: BlockRow[] = (outputs.get(node.id) ?? []).map((signal, index) => ({
      id: signal.id,
      name: signal.name,
      side: 'output',
      y: BLOCK_HEADER + (ports.length + index) * ROW + ROW / 2,
      signalId: null,
      requiresSignal: false,
      signal,
    }));
    placed.set(node.id, {
      node,
      x,
      y,
      width: BLOCK_WIDTH,
      height: heightOf(node),
      inputs,
      outputs: rows,
      connected: connected.has(node.id),
      layer: layer.get(node.id) ?? 0,
    });
    rightmost = Math.max(rightmost, x + BLOCK_WIDTH);
  };

  const placeBand = (members: GraphNode[], left: number) => {
    if (members.length === 0) return;
    const top = cursor;
    // Servers publish what the instance holds; they go with the rest.
    const flowing = members.filter((node) => connected.has(node.id) && node.kind !== 'server');
    const rest = members.filter((node) => !flowing.includes(node));
    let bottom = top;

    if (flowing.length > 0) {
      const layers = [...new Set(flowing.map((node) => layer.get(node.id) ?? 0))].sort((a, b) => a - b);
      const columns = layers.map((l) => flowing.filter((node) => (layer.get(node.id) ?? 0) === l));
      // Order each column by where its neighbours are, a few sweeps both ways.
      const position = new Map<string, number>();
      for (const column of columns) column.forEach((node, index) => position.set(node.id, index));
      for (let pass = 0; pass < ORDER_PASSES; pass += 1) {
        const order = pass % 2 === 0 ? columns : [...columns].reverse();
        for (const column of order) {
          const score = (node: GraphNode) => {
            const near = [...(inbound.get(node.id) ?? []), ...(outbound.get(node.id) ?? [])]
              .map((id) => position.get(id))
              .filter((value): value is number => value !== undefined);
            return near.length ? near.reduce((a, b) => a + b, 0) / near.length : position.get(node.id)!;
          };
          const scores = new Map(column.map((node) => [node.id, score(node)]));
          column.sort((a, b) => scores.get(a.id)! - scores.get(b.id)!);
          column.forEach((node, index) => position.set(node.id, index));
        }
      }
      // Each block level with the first block that feeds it, where there is room.
      columns.forEach((column, c) => {
        let next = top;
        for (const node of column) {
          const sources = [...(inbound.get(node.id) ?? [])]
            .map((id) => placed.get(id)?.y)
            .filter((value): value is number => value !== undefined);
          const y = Math.max(next, sources.length ? Math.min(...sources) : next);
          place(node, left + (layers[c] as number) * step, y);
          next = y + heightOf(node) + ROW_GAP;
        }
        bottom = Math.max(bottom, next - ROW_GAP);
      });
    }

    if (rest.length > 0) {
      const gridLeft = left + flowColumns * step;
      let rowTop = top;
      for (let i = 0; i < rest.length; i += GRID_COLUMNS) {
        const row = rest.slice(i, i + GRID_COLUMNS);
        let tallest = 0;
        row.forEach((node, j) => {
          place(node, gridLeft + j * (BLOCK_WIDTH + ROW_GAP), rowTop);
          tallest = Math.max(tallest, heightOf(node));
        });
        rowTop += tallest + ROW_GAP;
      }
      bottom = Math.max(bottom, rowTop - ROW_GAP);
    }
    cursor = bottom;
  };

  // The devices inside first, then the blocks of the device itself, such as
  // the function blocks of the instance that read the devices' signals.
  const visit = (group: GraphGroup, left: number) => {
    cursor += GROUP_HEADER;
    const children = childrenOf(group.id);
    children.forEach((child, index) => {
      if (index > 0) cursor += GROUP_PADDING;
      visit(child, left + GROUP_PADDING);
    });
    const own = [...blocks.values()].filter((node) => node.groupId === group.id);
    if (children.length > 0 && own.length > 0) cursor += GROUP_PADDING;
    placeBand(own, left + GROUP_PADDING);
    cursor += GROUP_PADDING;
  };
  placeBand(
    [...blocks.values()].filter((node) => !node.groupId || !known.has(node.groupId)),
    MARGIN,
  );
  for (const root of childrenOf(null)) {
    cursor += GROUP_PADDING;
    visit(root, MARGIN);
  }
  const tallest = cursor;

  // Deepest first: a parent's box includes the boxes of the devices inside.
  const groups: LayoutGroup[] = [];
  const byDepth = [...graph.groups].sort((a, b) => (groupDepth.get(b.id) ?? 0) - (groupDepth.get(a.id) ?? 0));
  for (const group of byDepth) {
    const members = [...placed.values()].filter((entry) => entry.node.groupId === group.id);
    const childIds = new Set(graph.groups.filter((other) => other.parentId === group.id).map((other) => other.id));
    const nested = groups.filter((entry) => childIds.has(entry.group.id));
    const rects = [...members, ...nested];
    if (rects.length === 0) continue;
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const top = Math.min(...rects.map((r) => r.y));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    groups.push({
      group,
      x: left - GROUP_PADDING,
      y: top - GROUP_HEADER,
      width: right - left + GROUP_PADDING * 2,
      height: bottom - top + GROUP_HEADER + GROUP_PADDING,
      depth: groupDepth.get(group.id) ?? 0,
    });
  }
  // Outermost first, so nested boxes paint on top of their parent.
  groups.sort((a, b) => a.depth - b.depth);

  const edges: LayoutEdge[] = [];
  for (const edge of connections) {
    const source = placed.get(producerOf.get(edge.source) ?? '');
    const target = placed.get(edge.target);
    if (!source || !target) continue;
    const out = source.outputs.find((row) => row.id === edge.source);
    const into = target.inputs.find((row) => row.signalId === edge.source);
    const startX = source.x + source.width;
    const startY = source.y + (out?.y ?? BLOCK_HEADER / 2);
    const endX = target.x;
    const endY = target.y + (into?.y ?? BLOCK_HEADER / 2);
    // Enough pull that a backwards connection loops out rather than cutting through.
    const span = Math.max(48, Math.abs(endX - startX) * 0.5);
    edges.push({
      edge,
      sourceBlock: source.node.id,
      targetBlock: target.node.id,
      sourceRow: out?.id ?? edge.source,
      targetRow: into?.id ?? target.node.id,
      path: `M${startX} ${startY} C${startX + span} ${startY} ${endX - span} ${endY} ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: (startY + endY) / 2,
    });
  }

  const groupRight = groups.length ? Math.max(...groups.map((g) => g.x + g.width)) : rightmost;
  return {
    blocks: [...placed.values()],
    edges,
    groups,
    width: Math.max(rightmost, groupRight) + MARGIN,
    height: tallest + MARGIN,
  };
}

/** The block and row at a point of the diagram, for hover and click. */
export function hitTest(layout: DiagramLayout, x: number, y: number): { block: LayoutBlock; row: BlockRow | null } | null {
  for (const block of layout.blocks) {
    if (x < block.x || x > block.x + block.width || y < block.y || y > block.y + block.height) continue;
    const dy = y - block.y;
    const row = [...block.inputs, ...block.outputs].find((entry) => Math.abs(dy - entry.y) <= ROW / 2) ?? null;
    return { block, row };
  }
  return null;
}

export const LAYOUT_METRICS = { BLOCK_WIDTH, BLOCK_HEADER, ROW, GROUP_HEADER };
