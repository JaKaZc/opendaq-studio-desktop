import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Antenna,
  Blocks,
  CircleDot,
  Crosshair,
  Gauge,
  LineChart,
  Maximize2,
  RefreshCw,
  Share2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api } from '../../lib/api';
import { formatSampleRate } from '../../lib/format';
import { DEVICE_SIGNALS_PREFIX, layoutGraph, type BlockRow, type DiagramLayout, type LayoutBlock } from '../../lib/graphLayout';
import { useAsyncData } from '../../lib/useAsyncData';
import { usePolling } from '../../lib/usePolling';
import { cn } from '../../lib/utils';
import type { GraphNode, TopologyGraph } from '../../lib/types';
import { openInScope, showAsTrack } from '../../store/useTracks';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { go } from '../../store/useNav';
import { useTime, useTimePolling } from '../../store/useTime';
import { reportsSync, syncRole } from '../../lib/timeSync';
import { TimeFlow } from '../time/TimeSync';
import { Button, IconButton } from '../ui/Button';
import { Checkbox } from '../ui/Field';
import { Badge, EmptyState, Spinner } from '../ui/Feedback';

/** What a signal row shows while live values are on. */
interface LiveReading {
  text: string;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/** Movement past this many pixels is a pan; anything less is a click. */
const DRAG_THRESHOLD = 3;

interface KindStyle {
  fill: string;
  stroke: string;
  Icon: typeof Activity;
  label: string;
}

/** Anything without a colour of its own is drawn like a function block. */
const BLOCK_STYLE: KindStyle = {
  fill: 'var(--color-sunken)',
  stroke: 'var(--color-border-strong)',
  Icon: Blocks,
  label: 'Function block',
};

/** One colour per block kind, matching the icons the tree already uses. */
const KIND_STYLE: Record<string, KindStyle> = {
  channel: { fill: 'var(--color-brand-soft)', stroke: 'var(--color-brand)', Icon: Gauge, label: 'Channel' },
  functionBlock: BLOCK_STYLE,
  recorder: { fill: 'var(--color-sunken)', stroke: 'var(--color-brand)', Icon: CircleDot, label: 'Recorder' },
  deviceSignals: { fill: 'var(--color-ok-soft)', stroke: 'var(--color-ok)', Icon: Activity, label: 'Device signals' },
  server: { fill: 'var(--color-info-soft)', stroke: 'var(--color-info)', Icon: Antenna, label: 'Server' },
};

interface View {
  x: number;
  y: number;
  zoom: number;
}

/** What is under the pointer: a block, and the row of it when on one. */
interface Hover {
  blockId: string;
  rowId: string | null;
}

/**
 * The instance drawn as the dataflow it is.
 *
 * Each channel and function block is one block, as dataflow editors draw
 * them: its input ports on the left, the signals it produces on the right
 * with their live values, and a line for each signal connected to an input
 * port, with samples visibly travelling it. Devices are the boxes around what
 * belongs to them.
 *
 * Panning and zooming change one transform on the drawing directly, without
 * React drawing it again, so moving around a large instance stays fluid. The
 * mouse wheel, two fingers on a trackpad and a pinch all zoom about the
 * pointer; dragging pans, and so does the wheel with Shift held.
 */
export function TopologyPage() {
  useTimePolling();
  const timeDevices = useTime((state) => state.devices);
  const includeHidden = useSettings((state) => state.includeHidden);
  const treeRevision = useSession((state) => state.treeRevision);
  const selectedId = useSession((state) => state.selectedId);
  const select = useSession((state) => state.select);
  const reportError = useSession((state) => state.reportError);

  const [onlyConnected, setOnlyConnected] = useState(false);
  const [live, setLive] = useState<Record<string, LiveReading>>({});
  const interval = useSettings((state) => state.lastValueInterval);
  const [hovered, setHovered] = useState<Hover | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [zoomLabel, setZoomLabel] = useState(100);

  const surface = useRef<HTMLDivElement | null>(null);
  const scene = useRef<SVGGElement | null>(null);
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const dragging = useRef<{ x: number; y: number; viewX: number; viewY: number; panning: boolean } | null>(null);
  /** Set by a pan, so the click that ends it does not select anything. */
  const panned = useRef(false);

  const { data, loading, error, reload } = useAsyncData<TopologyGraph>(
    (signal) => api.topology.graph(includeHidden, signal),
    [includeHidden, treeRevision],
    { onError: (cause) => reportError(cause, 'Could not read the topology') },
  );

  const inspected = useMemo(() => (inspecting ? (data?.nodes.find((node) => node.id === inspecting) ?? null) : null), [data, inspecting]);

  const layout = useMemo<DiagramLayout | null>(() => (data ? layoutGraph(data, { onlyConnected }) : null), [data, onlyConnected]);

  // Every output row's signal, for its live value.
  const liveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of layout?.blocks ?? []) for (const row of block.outputs) ids.add(row.id);
    return ids;
  }, [layout]);

  /**
   * What flows, as one batched request for every signal's last value - the
   * same one the signal table makes - rather than one per row.
   */
  usePolling(
    async (signal) => {
      const response = await api.signals.lastValues(undefined, undefined, includeHidden, signal);
      const next: Record<string, LiveReading> = {};
      for (const value of response.values) {
        if (!liveIds.has(value.id)) continue;
        next[value.id] = { text: value.error ? 'no reading' : (value.displayValue ?? '-') };
      }
      setLive(next);
    },
    interval,
    [liveIds, includeHidden],
    { enabled: liveIds.size > 0 && interval > 0 },
  );

  /** Writes the view onto the drawing, without React drawing it again. */
  const applyView = useCallback(() => {
    const { x, y, zoom } = view.current;
    scene.current?.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    setZoomLabel(Math.round(zoom * 100));
  }, []);

  const zoomAbout = useCallback(
    (pointX: number, pointY: number, factor: number) => {
      const current = view.current;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      const ratio = zoom / current.zoom;
      view.current = { zoom, x: pointX - (pointX - current.x) * ratio, y: pointY - (pointY - current.y) * ratio };
      applyView();
    },
    [applyView],
  );

  const fit = useCallback(
    (cap: number = MAX_ZOOM) => {
      const box = surface.current?.getBoundingClientRect();
      if (!box || !layout || layout.width === 0) return;
      const zoom = Math.min(cap, Math.max(MIN_ZOOM, Math.min(box.width / layout.width, box.height / layout.height)));
      view.current = { x: (box.width - layout.width * zoom) / 2, y: (box.height - layout.height * zoom) / 2, zoom };
      applyView();
    },
    [layout, applyView],
  );

  // Centre the diagram the first time there is one; after that, the view is
  // the user's. Capped, so two devices are not blown up to fill a wall.
  const autoFitted = useRef(false);
  useEffect(() => {
    if (autoFitted.current || !layout || layout.blocks.length === 0) return;
    const frame = requestAnimationFrame(() => {
      autoFitted.current = true;
      fit(1.2);
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, fit]);

  // The drawing keeps its view when React draws it again for new values.
  useEffect(() => {
    applyView();
  });

  // The wheel, as a native listener: React's is passive, and the page must
  // not scroll while the diagram zooms. Every wheel zooms, because a mouse
  // with smooth scrolling and two fingers on a trackpad send the same small
  // pixel steps and cannot be told apart. A pinch arrives as a wheel with the
  // control key and moves in finer steps, so it zooms faster per step.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Lines and pages, from some mice and from Windows, in pixels.
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;
      const pinch = event.ctrlKey || event.metaKey;
      if (event.shiftKey || (!pinch && Math.abs(deltaX) > Math.abs(deltaY))) {
        // Shift turns a vertical wheel into a horizontal one on some systems;
        // a sideways swipe on a trackpad moves sideways.
        const sideways = deltaX !== 0 ? deltaX : deltaY;
        view.current = { ...view.current, x: view.current.x - sideways, y: view.current.y - (deltaX !== 0 ? deltaY : 0) };
        applyView();
        return;
      }
      const box = element.getBoundingClientRect();
      const step = Math.max(-120, Math.min(120, deltaY));
      zoomAbout(event.clientX - box.left, event.clientY - box.top, Math.exp(-step * (pinch ? 0.01 : 0.002)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAbout, applyView, layout]);

  /** The block a component is shown in: itself, or the block whose output it is. */
  const blockOf = useCallback(
    (id: string): string | null => {
      for (const block of layout?.blocks ?? []) {
        if (block.node.id === id || block.outputs.some((row) => row.id === id)) return block.node.id;
      }
      return null;
    },
    [layout],
  );

  /**
   * What stays bright: the connections of the row under the pointer, or of
   * the block, or of everything in a device, and the blocks at their ends.
   */
  const focus = useMemo(() => {
    if (!layout) return null;
    const groupIds = new Set((data?.groups ?? []).map((group) => group.id));
    const anchor = hovered ?? (inspecting ? { blockId: blockOf(inspecting) ?? inspecting, rowId: inspecting } : null);
    if (!anchor) return null;
    const blocks = new Set<string>();
    const edges = new Set<string>();
    const rowId = anchor.rowId;
    const isRow = rowId !== null && rowId !== anchor.blockId && !groupIds.has(rowId);
    if (groupIds.has(anchor.blockId)) {
      // A device: everything inside it, nested devices included.
      const boxes = new Set<string>();
      const collect = (id: string) => {
        if (boxes.has(id)) return;
        boxes.add(id);
        for (const group of data?.groups ?? []) if (group.parentId === id) collect(group.id);
      };
      collect(anchor.blockId);
      for (const block of layout.blocks) if (block.node.groupId && boxes.has(block.node.groupId)) blocks.add(block.node.id);
      for (const entry of layout.edges) if (blocks.has(entry.sourceBlock) || blocks.has(entry.targetBlock)) edges.add(entry.edge.id);
    } else {
      blocks.add(anchor.blockId);
      for (const entry of layout.edges) {
        const touches = isRow
          ? entry.sourceRow === rowId || entry.targetRow === rowId
          : entry.sourceBlock === anchor.blockId || entry.targetBlock === anchor.blockId;
        if (touches) edges.add(entry.edge.id);
      }
    }
    for (const entry of layout.edges) {
      if (edges.has(entry.edge.id)) {
        blocks.add(entry.sourceBlock);
        blocks.add(entry.targetBlock);
      }
    }
    return { blocks, edges, rowId: isRow ? rowId : null };
  }, [hovered, inspecting, layout, data, blockOf]);

  const inspect = useCallback(
    (id: string) => {
      setInspecting(id);
      void select(id);
    },
    [select],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    panned.current = false;
    dragging.current = { x: event.clientX, y: event.clientY, viewX: view.current.x, viewY: view.current.y, panning: false };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = dragging.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.panning) {
      // Capture only once this is unmistakably a drag, so a click still
      // reaches the block under the pointer.
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      start.panning = true;
      panned.current = true;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    view.current = { ...view.current, x: start.viewX + dx, y: start.viewY + dy };
    applyView();
  };

  const endDrag = () => {
    dragging.current = null;
  };

  const onBlock = useCallback(
    (block: LayoutBlock, row: BlockRow | null) => {
      if (panned.current) return;
      // A signal's row is the signal; a device's own signals block is the device.
      if (row?.side === 'output') return inspect(row.id);
      const id = block.node.id;
      inspect(id.startsWith(DEVICE_SIGNALS_PREFIX) ? id.slice(DEVICE_SIGNALS_PREFIX.length) : id);
    },
    [inspect],
  );

  const onHover = useCallback((next: Hover | null) => {
    setHovered((current) => (current?.blockId === next?.blockId && current?.rowId === next?.rowId ? current : next));
  }, []);

  if (!data) {
    return error ? (
      <EmptyState className="h-full" icon={<AlertTriangle size={20} aria-hidden />} title="Topology unavailable" description={error} />
    ) : (
      <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-text-muted">
        <Spinner size={14} /> Reading the topology…
      </div>
    );
  }

  const center = () => {
    const box = surface.current?.getBoundingClientRect();
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-2.5 py-1.5">
        <Share2 size={13} className="text-text-muted" aria-hidden />
        <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">Dataflow</span>
        <span className="ml-3">
          <Checkbox checked={onlyConnected} onChange={setOnlyConnected} label="Connected blocks only" />
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Badge tone="neutral" title="Signal connections into input ports">
            {data.stats.connections} connection{data.stats.connections === 1 ? '' : 's'}
          </Badge>
          <Badge tone="neutral">{layout?.blocks.length ?? 0} blocks</Badge>
          <IconButton label="Zoom out" onClick={() => zoomAbout(center().x, center().y, 1 / 1.2)}>
            <ZoomOut size={13} />
          </IconButton>
          <span className="num w-10 text-center text-[11px] text-text-muted">{zoomLabel}%</span>
          <IconButton label="Zoom in" onClick={() => zoomAbout(center().x, center().y, 1.2)}>
            <ZoomIn size={13} />
          </IconButton>
          <IconButton label="Fit the diagram to the window" onClick={() => fit()}>
            <Maximize2 size={13} />
          </IconButton>
          <IconButton label="Refresh" onClick={reload} disabled={loading}>
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          </IconButton>
        </div>
      </div>
      <TimeFlow onOpen={(id) => void select(id)} />

      <div
        ref={surface}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => onHover(null)}
        onClick={() => {
          if (!panned.current) setInspecting(null);
        }}
      >
        {layout && layout.blocks.length > 0 ? (
          <svg className="absolute inset-0 h-full w-full" role="img" aria-label="Signal flow through the instance">
            <g ref={scene}>
              {layout.groups.map((box) => {
                const time = timeDevices.find((device) => device.id === box.group.id);
                const locked = time?.sync?.locked === true;
                return (
                  <g
                    key={box.group.id}
                    className="cursor-pointer"
                    onPointerEnter={() => onHover({ blockId: box.group.id, rowId: null })}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!panned.current) inspect(box.group.id);
                    }}
                  >
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      rx={10}
                      fill="var(--color-panel)"
                      fillOpacity={box.depth === 0 ? 0.35 : 0.6}
                      stroke={box.group.id === inspecting ? 'var(--color-accent)' : 'var(--color-border)'}
                      strokeDasharray={box.group.kind === 'instance' ? '4 4' : undefined}
                    />
                    <text x={box.x + 12} y={box.y + 17} className="fill-text-muted text-[10.5px] font-semibold uppercase">
                      {box.group.name}
                      {time && reportsSync(time) ? (
                        <tspan className={locked ? 'fill-ok' : 'fill-warn'}>
                          {'  ·  '}
                          {[syncRole(time), locked ? 'locked' : 'not locked'].filter(Boolean).join(' · ')}
                        </tspan>
                      ) : null}
                    </text>
                  </g>
                );
              })}

              {layout.edges.map((entry) => {
                const dimmed = focus !== null && !focus.edges.has(entry.edge.id);
                return (
                  <g key={entry.edge.id} opacity={dimmed ? 0.12 : 1} pointerEvents="none">
                    <path d={entry.path} fill="none" stroke="var(--color-border-strong)" strokeWidth={1.6} />
                    {/* Samples visibly travel each connection, over the solid line,
                        so the structure still reads in any single frame. */}
                    {!dimmed ? (
                      <path
                        d={entry.path}
                        fill="none"
                        stroke="var(--color-brand)"
                        strokeWidth={2}
                        strokeLinecap="round"
                        opacity={0.9}
                        className="flow-edge"
                      />
                    ) : null}
                  </g>
                );
              })}

              {layout.blocks.map((block) => (
                <DiagramBlock
                  key={block.node.id}
                  block={block}
                  live={live}
                  selected={block.node.id === selectedId || block.node.id === inspecting}
                  dimmed={focus !== null && !focus.blocks.has(block.node.id)}
                  hoverRow={hovered?.blockId === block.node.id ? hovered.rowId : null}
                  activeRow={inspecting}
                  onHover={onHover}
                  onSelect={onBlock}
                />
              ))}
            </g>
          </svg>
        ) : (
          <EmptyState
            className="h-full"
            icon={<Crosshair size={20} aria-hidden />}
            title="Nothing to draw yet"
            description={
              onlyConnected
                ? 'No block is connected. Turn off "Connected blocks only" to see every block.'
                : 'Connect a device to see how its signals flow.'
            }
          />
        )}

        <Legend />
      </div>

      {inspected ? (
        <Inspector
          node={inspected}
          onClose={() => setInspecting(null)}
          onOpenInConfigure={() => {
            void select(inspected.id);
            go('devices');
          }}
          onShowTrack={() => showAsTrack(inspected.id)}
          onScope={() => openInScope(inspected.id, inspected.name)}
        />
      ) : null}
    </div>
  );
}

/**
 * What the clicked thing actually is.
 *
 * It reads from the graph payload rather than fetching: everything worth showing
 * here already travelled with the diagram, and a panel that flickers while it
 * loads is worse than one that appears instantly.
 */
function Inspector({
  node,
  onClose,
  onOpenInConfigure,
  onShowTrack,
  onScope,
}: {
  node: GraphNode;
  onClose: () => void;
  onOpenInConfigure: () => void;
  onShowTrack: () => void;
  onScope: () => void;
}) {
  const detail = node.detail as Record<string, unknown>;
  const rows: [string, string][] = [];
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '' || value === false) return;
    rows.push([label, value === true ? 'yes' : String(value)]);
  };

  if (node.kind === 'signal') {
    push('Unit', (detail.unit as { symbol?: string } | null)?.symbol);
    push('Sample rate', typeof detail.sampleRate === 'number' ? formatSampleRate(detail.sampleRate) : null);
    push('Sample type', detail.sampleType);
    push('Timestamped by', detail.domainSignalName);
    push('Domain signal', detail.isDomain);
    push('Streamed', detail.streamed);
    push('Public', detail.public);
  } else if (node.kind === 'device' || node.kind === 'instance') {
    push('Connection', detail.connectionString);
    push('Manufacturer', detail.manufacturer);
    push('Model', detail.model);
    push('Serial number', detail.serialNumber);
    push('Operation mode', detail.operationMode);
    push('Locked', detail.locked);
    push('Protocols', Array.isArray(detail.protocols) ? detail.protocols.join(', ') : null);
  } else {
    push('Type', detail.typeName || detail.typeId);
    push('Recording', detail.recording);
  }
  push('Active', node.active ? null : 'no');

  return (
    <div className="flex shrink-0 items-start gap-4 border-t border-border bg-panel px-3 py-2">
      <div className="min-w-44">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
          {node.name}
          <Badge tone="neutral">{node.kind}</Badge>
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-text-faint" title={node.id}>
          {node.id}
        </div>
      </div>

      <dl className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5 text-[11.5px]">
            <dt className="text-text-faint">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
        {rows.length === 0 ? <span className="text-[11.5px] text-text-faint">No further detail</span> : null}
      </dl>

      <div className="flex shrink-0 items-center gap-1.5">
        {node.kind === 'signal' && detail.isDomain !== true ? (
          <>
            <Button size="sm" icon={<LineChart size={12} />} onClick={onShowTrack}>
              Show as a track
            </Button>
            <Button size="sm" onClick={onScope}>
              Open in the Scope
            </Button>
          </>
        ) : null}
        <Button size="sm" onClick={onOpenInConfigure}>
          Open in Devices
        </Button>
        <IconButton label="Close" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  );
}

/** The outline of a block's header: rounded at the top, square below. */
function headerPath(width: number, height: number, radius: number): string {
  return `M0 ${height} V${radius} A${radius} ${radius} 0 0 1 ${radius} 0 H${width - radius} A${radius} ${radius} 0 0 1 ${width} ${radius} V${height} Z`;
}

/**
 * One block: a header with its name and type, its input ports on the left
 * and the signals it produces on the right with their live values.
 */
const DiagramBlock = memo(function DiagramBlock({
  block,
  live,
  selected,
  dimmed,
  hoverRow,
  activeRow,
  onHover,
  onSelect,
}: {
  block: LayoutBlock;
  live: Record<string, LiveReading>;
  selected: boolean;
  dimmed: boolean;
  hoverRow: string | null;
  activeRow: string | null;
  onHover: (hover: Hover | null) => void;
  onSelect: (block: LayoutBlock, row: BlockRow | null) => void;
}) {
  const { node, width, height } = block;
  const style: KindStyle = KIND_STYLE[node.kind] ?? BLOCK_STYLE;
  const worst = node.status?.level;
  const header = 42;
  const rowHeight = 18;
  const hasRows = block.inputs.length + block.outputs.length > 0;

  // Always drawn, transparent when idle, so the whole row takes the pointer.
  const rowBackground = (row: BlockRow) => (
    <rect
      x={1}
      y={row.y - rowHeight / 2}
      width={width - 2}
      height={rowHeight}
      fill={row.id === activeRow ? 'var(--color-accent-soft)' : row.id === hoverRow ? 'var(--color-sunken)' : 'transparent'}
    />
  );

  return (
    <g
      transform={`translate(${block.x} ${block.y})`}
      opacity={dimmed ? 0.25 : node.active ? 1 : 0.6}
      className="cursor-pointer"
      onPointerEnter={() => onHover({ blockId: node.id, rowId: null })}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(block, null);
      }}
    >
      <title>{describe(node)}</title>
      <rect width={width} height={height} rx={8} fill="var(--color-panel)" />
      <path d={headerPath(width, header, 8)} fill={style.fill} />
      {hasRows ? <line x1={0} x2={width} y1={header} y2={header} stroke="var(--color-border)" /> : null}
      <rect x={0} y={0} width={4} height={height} rx={2} fill={style.stroke} />
      <rect
        width={width}
        height={height}
        rx={8}
        fill="none"
        stroke={selected ? 'var(--color-accent)' : style.stroke}
        strokeWidth={selected ? 2 : 1}
      />
      <text x={12} y={19} className="fill-text text-[12px] font-semibold">
        {truncate(node.name, 28)}
      </text>
      <text x={12} y={34} className="fill-text-faint text-[10px]">
        {truncate(subtitle(node), 36)}
      </text>
      {worst && worst !== 'ok' && worst !== 'none' ? (
        <circle cx={width - 12} cy={14} r={4} fill={worst === 'error' ? 'var(--color-err)' : 'var(--color-warn)'} />
      ) : null}

      {block.inputs.map((row) => (
        <g
          key={row.id}
          onPointerEnter={() => onHover({ blockId: node.id, rowId: row.id })}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(block, row);
          }}
        >
          {rowBackground(row)}
          <circle
            cx={0}
            cy={row.y}
            r={4}
            fill={row.signalId ? 'var(--color-ok)' : 'var(--color-panel)'}
            stroke={row.requiresSignal && !row.signalId ? 'var(--color-warn)' : 'var(--color-border-strong)'}
          />
          <text x={10} y={row.y + 3.5} className="fill-text-muted text-[10.5px]">
            {truncate(row.name, 34)}
          </text>
        </g>
      ))}

      {block.outputs.map((row) => {
        const reading = live[row.id]?.text;
        const value = reading ? truncate(reading, 16) : null;
        return (
          <g
            key={row.id}
            onPointerEnter={() => onHover({ blockId: node.id, rowId: row.id })}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(block, row);
            }}
          >
            <title>{row.signal ? describe(row.signal) : row.name}</title>
            {rowBackground(row)}
            <text x={12} y={row.y + 3.5} className="fill-text text-[10.5px] font-medium">
              {truncate(row.name, value ? 34 - value.length : 34)}
            </text>
            {value ? (
              <text x={width - 12} y={row.y + 3.5} textAnchor="end" className="num fill-text text-[10.5px]">
                {value}
              </text>
            ) : null}
            <circle cx={width} cy={row.y} r={3.5} fill="var(--color-ok)" />
          </g>
        );
      })}
    </g>
  );
});

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-2 rounded-[var(--radius-panel)] border border-border bg-panel/90 px-2 py-1.5 text-[10.5px] text-text-muted backdrop-blur-sm">
      {Object.entries(KIND_STYLE).map(([kind, entry]) => (
        <span key={kind} className="flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ backgroundColor: entry.stroke }} aria-hidden />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------- labels

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function subtitle(node: GraphNode): string {
  const detail = node.detail as Record<string, unknown>;
  if (node.kind === 'signal') {
    const unit = (detail.unit as { symbol?: string } | null)?.symbol;
    const rate = typeof detail.sampleRate === 'number' ? formatSampleRate(detail.sampleRate) : null;
    return [unit, rate].filter(Boolean).join(' · ') || (detail.isDomain ? 'domain' : 'signal');
  }
  if (node.kind === 'server') return String(detail.typeId ?? 'server');
  if (node.kind === 'channel') return 'Channel';
  if (node.kind === 'deviceSignals') return 'Signals of the device itself';
  return String(detail.typeName || detail.typeId || 'Function block');
}

function describe(node: GraphNode): string {
  const lines = [`${node.name} — ${node.kind}`];
  const detail = node.detail as Record<string, unknown>;
  if (node.kind === 'signal') {
    const unit = (detail.unit as { symbol?: string } | null)?.symbol;
    const rate = typeof detail.sampleRate === 'number' ? formatSampleRate(detail.sampleRate) : null;
    if (unit || rate) lines.push([unit, rate].filter(Boolean).join(' · '));
    if (detail.sampleType) lines.push(`sample type: ${String(detail.sampleType)}`);
    if (detail.domainSignalName) lines.push(`timestamped by: ${String(detail.domainSignalName)}`);
    if (detail.streamed) lines.push('streamed');
  }
  if (!node.active) lines.push('inactive');
  return lines.join('\n');
}

export { KIND_STYLE };
