import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration, formatEngineering, formatTimeOfDay, niceTicks } from '../../lib/format';
import { clamp } from '../../lib/utils';
import type { ColumnSeries } from '../../lib/trace';
import { traces } from '../../store/traceStore';
import { triggerState } from '../../store/triggerState';
import { liveEdge, useScope, visibleWindow, type TraceConfig } from '../../store/useScope';
import { useElementSize } from '../ui/Layout';
import {
  drawColumnSeries,
  drawCursor,
  gapToleranceColumns,
  drawEmptyMessage,
  drawFrame,
  drawGrid,
  makeXMapper,
  makeYMapper,
  padScale,
  readPlotTheme,
  setupCanvas,
  type PlotBox,
  type ValueScale,
} from './plotting';
import { evaluateTrigger } from './triggerLoop';

const AXIS_LEFT = 62;
const AXIS_BOTTOM = 22;
const AXIS_TOP = 8;
const AXIS_RIGHT = 10;

interface Readout {
  time: number | null;
  values: { signalId: string; name: string; color: string; value: number | null }[];
  deltaTime: number | null;
  deltaValues: { signalId: string; name: string; color: string; delta: number | null }[] | null;
}

/**
 * The live plot.
 *
 * Rendering runs entirely inside `requestAnimationFrame` reading the trace
 * buffers directly - React never sees a sample.  The only state that crosses back
 * into React is the readout under the pointer, throttled to a few times a second.
 *
 * Interaction follows what people expect from a scope:
 * - drag to pan (which freezes the view),
 * - wheel to zoom the time axis around the pointer,
 * - shift-drag to place the two measurement cursors,
 * - double-click to return to rolling.
 */
export function ScopeCanvas({ onReadout }: { onReadout?: (readout: Readout) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesCache = useRef(new Map<string, ColumnSeries>());
  const { ref: boxRef, width, height } = useElementSize<HTMLDivElement>();

  const traceConfigs = useScope((state) => state.traces);
  const showGrid = useScope((state) => state.showGrid);
  const stacked = useScope((state) => state.stacked);
  const cursorA = useScope((state) => state.cursorA);
  const cursorB = useScope((state) => state.cursorB);
  const windowSeconds = useScope((state) => state.windowSeconds);
  const xMode = useScope((state) => state.xMode);
  const syncResolution = useScope((state) => state.syncResolution);
  const zoomBy = useScope((state) => state.zoomBy);
  const freezeAt = useScope((state) => state.freezeAt);
  const setCursor = useScope((state) => state.setCursor);

  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  // Ask the backend for roughly two points per pixel.
  useEffect(() => {
    if (width > 0) syncResolution(width - AXIS_LEFT - AXIS_RIGHT);
  }, [syncResolution, width, windowSeconds]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = boxRef.current;
    if (!canvas || !container) return;

    const setup = setupCanvas(canvas, container.clientWidth, container.clientHeight);
    if (!setup) return;
    const { context } = setup;
    const theme = readPlotTheme(container);

    context.fillStyle = theme.background;
    context.fillRect(0, 0, setup.width, setup.height);

    const plot: PlotBox = {
      left: AXIS_LEFT,
      top: AXIS_TOP,
      width: Math.max(10, setup.width - AXIS_LEFT - AXIS_RIGHT),
      height: Math.max(10, setup.height - AXIS_TOP - AXIS_BOTTOM),
    };

    const state = useScope.getState();
    const visible = traceConfigs.filter((trace) => trace.visible);

    if (visible.length === 0) {
      drawEmptyMessage(context, plot, 'Add a signal to start plotting', theme.text);
      drawFrame(context, plot, theme.axis);
      return;
    }

    const window_ = visibleWindow(state);
    if (!(window_.end > 0)) {
      drawEmptyMessage(context, plot, 'Waiting for the first samples…', theme.text);
      drawFrame(context, plot, theme.axis);
      return;
    }

    const toX = makeXMapper(plot, window_.start, window_.end);
    const columns = Math.max(2, Math.floor(plot.width));

    // --- vertical scale ---------------------------------------------------
    const lanes = stacked ? visible.length : 1;
    const laneHeight = plot.height / lanes;

    const scaleFor = (trace: TraceConfig): ValueScale => {
      if (state.yMode === 'manual') return { min: state.yMin, max: state.yMax };
      if (state.yMode === 'descriptor') {
        const range = traces.meta(trace.signalId)?.valueRange;
        if (range && range.low !== null && range.high !== null) {
          return { min: range.low, max: range.high };
        }
      }
      const buffer = traces.buffer(trace.signalId);
      const extent = buffer?.extent(window_.start, window_.end);
      return extent ? padScale(extent.min, extent.max) : { min: -1, max: 1 };
    };

    // Overlaid traces share one scale so their amplitudes are comparable.
    let sharedScale: ValueScale = { min: Infinity, max: -Infinity };
    if (!stacked) {
      if (state.yMode === 'manual') {
        sharedScale = { min: state.yMin, max: state.yMax };
      } else {
        for (const trace of visible) {
          const scale = scaleFor(trace);
          sharedScale.min = Math.min(sharedScale.min, scale.min);
          sharedScale.max = Math.max(sharedScale.max, scale.max);
        }
        if (!Number.isFinite(sharedScale.min)) sharedScale = { min: -1, max: 1 };
      }
    }

    // --- grid + axes -----------------------------------------------------
    const timeTicks = niceTicks(0, windowSeconds, Math.max(3, Math.floor(plot.width / 110)));
    const xs = timeTicks.map((offset) => toX(window_.end - windowSeconds + offset));

    const yLabelSets: { label: string; y: number }[] = [];
    const ys: number[] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      const laneBox: PlotBox = {
        left: plot.left,
        top: plot.top + lane * laneHeight,
        width: plot.width,
        height: laneHeight,
      };
      const scale = stacked ? scaleFor(visible[lane] as TraceConfig) : sharedScale;
      const toY = makeYMapper(laneBox, scale);
      const valueTicks = niceTicks(scale.min, scale.max, Math.max(2, Math.floor(laneHeight / 34)));
      const unit = stacked
        ? (traces.meta((visible[lane] as TraceConfig).signalId)?.unit ?? '')
        : (traces.meta(visible[0]?.signalId ?? '')?.unit ?? '');
      for (const value of valueTicks) {
        const y = toY(value);
        ys.push(y);
        yLabelSets.push({ label: formatEngineering(value, unit, 3), y });
      }
    }

    if (showGrid) drawGrid(context, plot, xs, ys, theme.grid);

    // --- traces ----------------------------------------------------------
    for (let index = 0; index < visible.length; index += 1) {
      const trace = visible[index] as TraceConfig;
      const buffer = traces.buffer(trace.signalId);
      if (!buffer || buffer.isEmpty) continue;

      const lane = stacked ? index : 0;
      const laneBox: PlotBox = {
        left: plot.left,
        top: plot.top + lane * laneHeight + (stacked ? 2 : 0),
        width: plot.width,
        height: laneHeight - (stacked ? 4 : 0),
      };
      const scale = stacked ? scaleFor(trace) : sharedScale;
      const baseToY = makeYMapper(laneBox, scale);
      // Per-trace gain and offset let overlaid traces be separated by hand.
      const toY = (value: number) => baseToY(value * trace.scale + trace.offset);

      const cached = seriesCache.current.get(trace.signalId);
      const series = buffer.toColumns(window_.start, window_.end, columns, cached);
      seriesCache.current.set(trace.signalId, series);

      // Zoomed in far enough and there are more pixels than samples; the line
      // has to bridge the empty columns rather than break at every one.
      const secondsPerColumn = (window_.end - window_.start) / columns;
      const sampleInterval = traces.get(trace.signalId)?.sampleInterval ?? 0;
      drawColumnSeries(
        context,
        series,
        laneBox,
        toY,
        trace.color,
        1.3,
        gapToleranceColumns(sampleInterval, secondsPerColumn),
      );

      if (stacked) {
        context.save();
        context.fillStyle = trace.color;
        context.font = '600 10px system-ui, sans-serif';
        context.textAlign = 'left';
        context.textBaseline = 'top';
        context.fillText(trace.name, laneBox.left + 4, laneBox.top + 2);
        context.restore();
      }
    }

    // --- trigger ---------------------------------------------------------
    const trigger = state.trigger;
    const sourceIndex = trigger.mode === 'off' ? -1 : visible.findIndex((trace) => trace.signalId === trigger.sourceId);
    if (sourceIndex >= 0) {
      const source = visible[sourceIndex] as TraceConfig;
      const lane = stacked ? sourceIndex : 0;
      const laneBox: PlotBox = {
        left: plot.left,
        top: plot.top + lane * laneHeight + (stacked ? 2 : 0),
        width: plot.width,
        height: laneHeight - (stacked ? 4 : 0),
      };
      const baseToY = makeYMapper(laneBox, stacked ? scaleFor(source) : sharedScale);
      // The level is in signal units, so it goes through the same gain and
      // offset as the trace it is drawn against.
      const levelY = baseToY(trigger.level * source.scale + source.offset);
      drawTriggerMarks(context, plot, laneBox, levelY, triggerState.view.triggerTime, toX, theme.cursor);
    }

    // --- axis labels -----------------------------------------------------
    context.save();
    context.fillStyle = theme.text;
    context.font = '10px ui-monospace, monospace';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (const entry of yLabelSets) {
      if (entry.y < plot.top - 2 || entry.y > plot.top + plot.height + 2) continue;
      context.fillText(entry.label, plot.left - 6, entry.y);
    }

    // The wall-clock time of the right edge is drawn first so its measured width
    // can reserve space: a relative tick overlapping it turns both into noise.
    const clockLabel = formatTimeOfDay(window_.end, 3);
    const clockWidth = context.measureText(clockLabel).width;
    const clockLeft = plot.left + plot.width - clockWidth - 6;

    context.textAlign = 'right';
    context.fillText(clockLabel, plot.left + plot.width, plot.top + plot.height + 5);

    context.textAlign = 'center';
    context.textBaseline = 'top';
    let previousRight = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < timeTicks.length; index += 1) {
      const offset = timeTicks[index] as number;
      const x = xs[index] as number;
      if (x < plot.left - 4 || x > plot.left + plot.width + 4) continue;

      // Label the position relative to the right edge; the absolute time is
      // shown once, beside it.
      const label = `−${formatDuration(windowSeconds - offset)}`;
      const half = context.measureText(label).width / 2;
      const centre = clamp(x, plot.left + half, plot.left + plot.width - half);

      // Drop a label that would collide with its neighbour or with the clock.
      if (centre - half < previousRight + 6) continue;
      if (centre + half > clockLeft) continue;

      context.fillText(label, centre, plot.top + plot.height + 5);
      previousRight = centre + half;
    }
    context.restore();

    // --- cursors ---------------------------------------------------------
    if (cursorA.enabled) {
      drawCursor(context, plot, toX(cursorA.time), theme.cursor, 'A');
    }
    if (cursorB.enabled) {
      drawCursor(context, plot, toX(cursorB.time), theme.cursor, 'B');
    }
    if (cursorA.enabled && cursorB.enabled) {
      // Shade the measured interval so the delta is visible without reading numbers.
      const x1 = toX(Math.min(cursorA.time, cursorB.time));
      const x2 = toX(Math.max(cursorA.time, cursorB.time));
      context.save();
      context.fillStyle = theme.cursor;
      context.globalAlpha = 0.07;
      context.fillRect(
        clamp(x1, plot.left, plot.left + plot.width),
        plot.top,
        clamp(x2, plot.left, plot.left + plot.width) - clamp(x1, plot.left, plot.left + plot.width),
        plot.height,
      );
      context.restore();
    }

    // --- pointer crosshair ----------------------------------------------
    const pointer = pointerRef.current;
    if (pointer && pointer.x >= plot.left && pointer.x <= plot.left + plot.width) {
      context.save();
      context.strokeStyle = theme.axis;
      context.lineWidth = 1;
      context.setLineDash([2, 3]);
      context.beginPath();
      const x = Math.round(pointer.x) + 0.5;
      context.moveTo(x, plot.top);
      context.lineTo(x, plot.top + plot.height);
      context.stroke();
      context.restore();
    }

    drawFrame(context, plot, theme.axis);

    const banner = plotBanner(state.paused, xMode, state.trigger.mode, state.triggerStatus);
    if (banner) {
      context.save();
      context.fillStyle = theme.cursor;
      context.font = '600 10px system-ui, sans-serif';
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.fillText(banner, plot.left + 5, plot.top + 4);
      context.restore();
    }
  }, [
    boxRef,
    cursorA.enabled,
    cursorA.time,
    cursorB.enabled,
    cursorB.time,
    showGrid,
    stacked,
    traceConfigs,
    windowSeconds,
    xMode,
  ]);

  // Render loop: only repaint when data or configuration changed.
  useEffect(() => {
    let frame = 0;
    let lastData = -1;
    let lastStructure = -1;
    let lastConfig = '';
    let lastReadout = 0;

    const loop = () => {
      frame = requestAnimationFrame(loop);
      // Before anything is drawn, so the window drawn is the one this frame's
      // data implies.
      const triggerMoved = evaluateTrigger();
      const state = useScope.getState();
      const trigger = state.trigger;
      const configKey = `${state.xMode}${state.frozenEnd}${state.windowSeconds}${state.yMode}${state.yMin}${state.yMax}${state.stacked}${state.showGrid}${state.cursorA.time}${state.cursorA.enabled}${state.cursorB.time}${state.cursorB.enabled}${state.traces.length}${pointerRef.current?.x ?? ''}${trigger.mode}${trigger.sourceId}${trigger.level}${state.triggerStatus}`;

      if (
        !triggerMoved &&
        traces.dataVersion === lastData &&
        traces.structureVersion === lastStructure &&
        configKey === lastConfig
      ) {
        return;
      }
      lastData = traces.dataVersion;
      lastStructure = traces.structureVersion;
      lastConfig = configKey;

      render();

      if (onReadout && Date.now() - lastReadout > 150) {
        lastReadout = Date.now();
        onReadout(buildReadout(state));
      }
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [render, onReadout, width, height]);

  // --- interaction -------------------------------------------------------

  const plotBoxOf = useCallback(
    (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        rect,
        plot: {
          left: AXIS_LEFT,
          top: AXIS_TOP,
          width: Math.max(10, rect.width - AXIS_LEFT - AXIS_RIGHT),
          height: Math.max(10, rect.height - AXIS_TOP - AXIS_BOTTOM),
        } satisfies PlotBox,
      };
    },
    [],
  );

  const timeAt = useCallback(
    (clientX: number, element: HTMLElement) => {
      const { rect, plot } = plotBoxOf(element);
      const state = useScope.getState();
      const window_ = visibleWindow(state);
      const fraction = (clientX - rect.left - plot.left) / plot.width;
      return window_.start + clamp(fraction, 0, 1) * (window_.end - window_.start);
    },
    [plotBoxOf],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      // Shift-drag places the measurement cursors instead of panning.
      if (event.shiftKey) {
        const start = timeAt(event.clientX, element);
        setCursor('A', { time: start, enabled: true });
        setCursor('B', { time: start, enabled: true });
        const move = (pointer: PointerEvent) => {
          setCursor('B', { time: timeAt(pointer.clientX, element), enabled: true });
        };
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        return;
      }

      const state = useScope.getState();
      const window_ = visibleWindow(state);
      const { plot } = plotBoxOf(element);
      const secondsPerPixel = (window_.end - window_.start) / plot.width;
      const originX = event.clientX;
      const originEnd = window_.end;
      element.setPointerCapture(event.pointerId);

      const move = (pointer: PointerEvent) => {
        const delta = (pointer.clientX - originX) * secondsPerPixel;
        freezeAt(originEnd - delta);
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
    },
    [freezeAt, plotBoxOf, setCursor, timeAt],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const anchor = timeAt(event.clientX, event.currentTarget);
      // Freeze first, so zooming does not fight the rolling edge.
      const state = useScope.getState();
      if (state.xMode === 'rolling') freezeAt(liveEdge(state) ?? anchor);
      zoomBy(event.deltaY > 0 ? 1.25 : 0.8, anchor);
    },
    [freezeAt, timeAt, zoomBy],
  );

  return (
    <div
      ref={boxRef}
      className="relative min-h-0 flex-1 cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setHoverLabel(formatTimeOfDay(timeAt(event.clientX, event.currentTarget), 4));
      }}
      onPointerLeave={() => {
        pointerRef.current = null;
        setHoverLabel(null);
      }}
      onWheel={onWheel}
      onDoubleClick={() => freezeAt(null)}
      role="img"
      aria-label="Signal plot. Drag to pan, scroll to zoom, shift-drag to measure."
    >
      <canvas ref={canvasRef} className="block size-full" />
      {hoverLabel ? (
        <span className="num pointer-events-none absolute bottom-1 left-16 rounded bg-panel/85 px-1 text-[10px] text-text-muted">
          {hoverLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The trigger level and the trigger instant.
 *
 * Dashed, and labelled `T`, so they never read as the solid A/B measurement
 * cursors drawn in the same accent colour.
 */
function drawTriggerMarks(
  context: CanvasRenderingContext2D,
  plot: PlotBox,
  lane: PlotBox,
  levelY: number,
  triggerTime: number | null,
  toX: (time: number) => number,
  color: string,
): void {
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1;
  context.setLineDash([4, 4]);

  if (levelY >= lane.top && levelY <= lane.top + lane.height) {
    context.globalAlpha = 0.55;
    context.beginPath();
    context.moveTo(plot.left, Math.round(levelY) + 0.5);
    context.lineTo(plot.left + plot.width, Math.round(levelY) + 0.5);
    context.stroke();
    // A pointer on the axis, the way a bench scope marks its trigger level.
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(plot.left, levelY);
    context.lineTo(plot.left - 6, levelY - 4);
    context.lineTo(plot.left - 6, levelY + 4);
    context.closePath();
    context.fill();
  }

  if (triggerTime !== null) {
    const x = toX(triggerTime);
    if (x >= plot.left && x <= plot.left + plot.width) {
      context.globalAlpha = 0.8;
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, plot.top);
      context.lineTo(Math.round(x) + 0.5, plot.top + plot.height);
      context.stroke();
      context.globalAlpha = 1;
      context.setLineDash([]);
      context.font = '600 10px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      context.fillText('T', x, plot.top + 2);
    }
  }
  context.restore();
}

/** The one-word state written in the plot's corner, if any. */
function plotBanner(
  paused: boolean,
  xMode: string,
  mode: string,
  status: string,
): string | null {
  if (mode !== 'off') {
    if (status === 'stopped') return 'STOPPED · SINGLE';
    if (paused) return 'PAUSED';
    if (xMode === 'frozen') return 'FROZEN';
    if (status === 'armed') return 'WAITING FOR TRIGGER';
    if (status === 'holding') return 'HOLDING LAST TRIGGER';
    if (status === 'auto') return 'AUTO · NO TRIGGER';
    return null;
  }
  if (paused) return 'PAUSED';
  if (xMode === 'frozen') return 'FROZEN';
  return null;
}

/** Values at the cursors, for the readout strip. */
function buildReadout(state: ReturnType<typeof useScope.getState>): Readout {
  const at = (time: number) =>
    state.traces
      .filter((trace) => trace.visible)
      .map((trace) => {
        const trace_ = traces.get(trace.signalId);
        const tolerance = Math.max(trace_?.sampleInterval ?? 0, state.windowSeconds / 200);
        const sample = trace_?.buffer.valueAt(time, tolerance) ?? null;
        return { signalId: trace.signalId, name: trace.name, color: trace.color, value: sample?.value ?? null };
      });

  if (!state.cursorA.enabled) {
    // With no cursors, report the newest value of each trace.
    return {
      time: liveEdge(state),
      values: state.traces
        .filter((trace) => trace.visible)
        .map((trace) => ({
          signalId: trace.signalId,
          name: trace.name,
          color: trace.color,
          value: traces.buffer(trace.signalId)?.latestValue() ?? null,
        })),
      deltaTime: null,
      deltaValues: null,
    };
  }

  const aValues = at(state.cursorA.time);
  if (!state.cursorB.enabled) {
    return { time: state.cursorA.time, values: aValues, deltaTime: null, deltaValues: null };
  }

  const bValues = at(state.cursorB.time);
  return {
    time: state.cursorA.time,
    values: aValues,
    deltaTime: state.cursorB.time - state.cursorA.time,
    deltaValues: aValues.map((entry, index) => {
      const other = bValues[index];
      return {
        signalId: entry.signalId,
        name: entry.name,
        color: entry.color,
        delta:
          entry.value !== null && other?.value !== null && other?.value !== undefined
            ? other.value - entry.value
            : null,
      };
    }),
  };
}

export type { Readout };
