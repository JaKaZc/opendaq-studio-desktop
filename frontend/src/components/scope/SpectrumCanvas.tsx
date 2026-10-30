import { useCallback, useEffect, useRef, useState } from 'react';
import { sequentialRamp } from '../../lib/colorRamp';
import { computeSpectrum, floorPowerOfTwo, type SpectrumResult } from '../../lib/dsp';
import { formatDuration, formatEngineering, niceTicks } from '../../lib/format';
import { traces } from '../../store/traceStore';
import { useScope } from '../../store/useScope';
import { ButtonGroup, Segment } from '../ui/Button';
import { useElementSize } from '../ui/Layout';
import {
  drawEmptyMessage,
  drawFrame,
  drawGrid,
  readPlotTheme,
  setupCanvas,
  type PlotBox,
} from './plotting';

const AXIS_LEFT = 56;
const AXIS_BOTTOM = 20;
const AXIS_TOP = 8;
const AXIS_RIGHT = 10;
/** Room for the waterfall's colour bar and its two labels. */
const LEGEND_WIDTH = 64;
/** The waterfall shows this many dB below its loudest bin; quieter is background. */
const DYNAMIC_RANGE_DB = 100;
const MAX_ROWS = 600;

interface SpectrumEntry {
  color: string;
  name: string;
  result: SpectrumResult;
  /** Data time of the newest sample transformed. */
  time: number;
}

/** History for the waterfall: one row of per-column levels per transform. */
interface Waterfall {
  /** Rows are only comparable under one set of transform settings. */
  key: string;
  /** Oldest first. */
  rows: Float32Array[];
  times: number[];
  floor: number;
  top: number;
}

/** What the pointer needs to turn a position back into a reading. */
interface HoverModel {
  plot: PlotBox;
  view: 'spectrum' | 'waterfall';
  frequencyAt: (x: number) => number;
  /** Spectrum view: the first trace's per-column level. */
  curve: Float32Array | null;
  waterfall: Waterfall | null;
  decibels: boolean;
  unit: string;
  name: string;
}

/**
 * Frequency content of the visible traces: the latest spectrum as a curve, or
 * its recent history as a waterfall.
 *
 * Requires a trace in raw (undecimated) mode: min/max buckets have no uniform
 * sample grid, so transforming them would produce a spectrum of the decimation,
 * not of the signal. When the scope is decimating, this says so instead of
 * drawing something misleading.
 */
export function SpectrumCanvas({ height = 200 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const previousRef = useRef(new Map<string, Float64Array>());
  const waterfallRef = useRef<Waterfall | null>(null);
  const hoverModelRef = useRef<HoverModel | null>(null);
  const { ref: boxRef, width } = useElementSize<HTMLDivElement>();

  const traceConfigs = useScope((state) => state.traces);
  const spectrum = useScope((state) => state.spectrum);
  const setSpectrum = useScope((state) => state.setSpectrum);
  const [peakLabel, setPeakLabel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waterfallSource, setWaterfallSource] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = boxRef.current;
    if (!canvas || !container) return;

    const setup = setupCanvas(canvas, container.clientWidth, height);
    if (!setup) return;
    const { context } = setup;
    const theme = readPlotTheme(container);
    const isWaterfall = spectrum.view === 'waterfall';

    context.fillStyle = theme.background;
    context.fillRect(0, 0, setup.width, setup.height);

    const plot: PlotBox = {
      left: AXIS_LEFT,
      top: AXIS_TOP,
      width: Math.max(10, setup.width - AXIS_LEFT - (isWaterfall ? LEGEND_WIDTH : AXIS_RIGHT)),
      height: Math.max(10, setup.height - AXIS_TOP - AXIS_BOTTOM),
    };

    const visible = traceConfigs.filter((trace) => trace.visible);
    if (visible.length === 0) {
      drawEmptyMessage(context, plot, 'Add a signal to see its spectrum', theme.text);
      drawFrame(context, plot, theme.axis);
      hoverModelRef.current = null;
      return;
    }

    // --- transforms -------------------------------------------------------
    const results: SpectrumEntry[] = [];
    let decimatedCount = 0;

    for (const trace of visible) {
      const state = traces.get(trace.signalId);
      if (!state || state.buffer.isEmpty) continue;
      if (state.mode !== 'raw') {
        decimatedCount += 1;
        continue;
      }
      const rate = state.sampleInterval > 0 ? 1 / state.sampleInterval : (state.meta?.sampleRate ?? 0);
      if (!(rate > 0)) continue;

      const size = floorPowerOfTwo(Math.min(spectrum.size, state.buffer.length));
      if (size < 64) continue;
      const tail = state.buffer.tail(size);
      if (!tail) continue;

      const result = computeSpectrum(tail.values, rate, {
        windowFunction: spectrum.windowFunction,
        decibels: spectrum.decibels,
        smoothing: spectrum.smoothing,
        previous: previousRef.current.get(trace.signalId) ?? null,
      });
      if (!result) continue;
      previousRef.current.set(trace.signalId, result.magnitudes.slice());
      results.push({
        color: trace.color,
        name: trace.name,
        result,
        time: tail.startTime + tail.interval * (tail.values.length - 1),
      });
    }

    if (results.length === 0) {
      const message =
        decimatedCount > 0
          ? 'Spectrum needs undecimated samples — shorten the time window'
          : 'Collecting samples…';
      drawEmptyMessage(context, plot, message, theme.text);
      drawFrame(context, plot, theme.axis);
      setNotice(decimatedCount > 0 ? message : null);
      setPeakLabel(null);
      hoverModelRef.current = null;
      return;
    }
    setNotice(null);

    // --- frequency axis, shared by both views -----------------------------
    const maxFrequency = Math.max(...results.map((entry) => entry.result.sampleRate / 2));
    const minFrequency = spectrum.logFrequency ? Math.max(1, results[0]?.result.binWidth ?? 1) : 0;
    const logSpan = Math.log10(maxFrequency) - Math.log10(minFrequency) || 1;

    const toX = (frequency: number) => {
      if (spectrum.logFrequency) {
        const clamped = Math.max(minFrequency, frequency);
        return plot.left + ((Math.log10(clamped) - Math.log10(minFrequency)) / logSpan) * plot.width;
      }
      return plot.left + (frequency / (maxFrequency || 1)) * plot.width;
    };
    const frequencyAt = (x: number) => {
      const ratio = Math.min(1, Math.max(0, (x - plot.left) / plot.width));
      return spectrum.logFrequency
        ? 10 ** (Math.log10(minFrequency) + ratio * logSpan)
        : ratio * maxFrequency;
    };
    const frequencyTicks = spectrum.logFrequency
      ? logTicks(minFrequency, maxFrequency)
      : niceTicks(0, maxFrequency, Math.max(3, Math.floor(plot.width / 90)));
    const columns = Math.max(2, Math.floor(plot.width));
    const unit = spectrum.decibels ? 'dB' : (traces.meta(visible[0]?.signalId ?? '')?.unit ?? '');

    if (isWaterfall) {
      const first = results[0] as SpectrumEntry;
      setWaterfallSource(results.length > 1 ? `${first.name} (first trace)` : first.name);
      const waterfall = pushWaterfallRow(
        waterfallRef.current,
        `${columns}|${spectrum.decibels}|${spectrum.logFrequency}|${spectrum.size}|${spectrum.windowFunction}|${first.name}|${maxFrequency}`,
        columnPeaks(first.result, columns, toX, plot.left),
        first.time,
        Math.min(MAX_ROWS, Math.floor(plot.height)),
        spectrum.decibels,
      );
      waterfallRef.current = waterfall;

      const offscreen = (offscreenRef.current ??= document.createElement('canvas'));
      const ramp = sequentialRamp(theme.background, theme.brand);
      drawWaterfall(context, offscreen, plot, waterfall, ramp);
      drawColourBar(context, plot, ramp, waterfall, spectrum.decibels, unit, theme.text);

      // "now" at the top, how far back the oldest row is at the bottom.
      context.save();
      context.fillStyle = theme.text;
      context.font = '10px ui-monospace, monospace';
      context.textAlign = 'right';
      context.textBaseline = 'top';
      context.fillText('now', plot.left - 6, plot.top);
      const span = (waterfall.times.at(-1) ?? 0) - (waterfall.times[0] ?? 0);
      if (waterfall.rows.length > 24 && span > 0) {
        context.textBaseline = 'bottom';
        context.fillText(`−${formatDuration(span)}`, plot.left - 6, plot.top + waterfall.rows.length);
      }
      context.restore();

      drawFrequencyLabels(context, plot, frequencyTicks, toX, theme.text);
      drawFrame(context, plot, theme.axis);
      setPeakLabel(null);
      hoverModelRef.current = {
        plot,
        view: 'waterfall',
        frequencyAt,
        curve: null,
        waterfall,
        decibels: spectrum.decibels,
        unit,
        name: first.name,
      };
      return;
    }

    // A curve view means the waterfall's history is stale the moment it returns.
    waterfallRef.current = null;
    setWaterfallSource(null);

    // --- amplitude scale ----------------------------------------------------
    let low = Infinity;
    let high = -Infinity;
    for (const entry of results) {
      for (let bin = 1; bin < entry.result.magnitudes.length; bin += 1) {
        const value = entry.result.magnitudes[bin] as number;
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    if (!Number.isFinite(low)) {
      low = spectrum.decibels ? -120 : 0;
      high = spectrum.decibels ? 0 : 1;
    }
    if (spectrum.decibels) {
      // Clamp the floor: a silent channel's true floor is -300 dB, which would
      // squash everything interesting into the top pixel row.
      high = Math.ceil(high / 10) * 10;
      low = Math.max(high - 140, Math.floor(low / 10) * 10);
    } else {
      low = 0;
      high = high * 1.1 || 1;
    }
    const toY = (value: number) => plot.top + plot.height - ((value - low) / (high - low || 1)) * plot.height;

    const amplitudeTicks = niceTicks(low, high, Math.max(2, Math.floor(plot.height / 30)));
    drawGrid(context, plot, frequencyTicks.map(toX), amplitudeTicks.map(toY), theme.grid);

    // --- curves -----------------------------------------------------------
    let firstCurve: Float32Array | null = null;
    for (const entry of results) {
      // One point per pixel column, keeping the maximum so peaks survive.
      const peaks = columnPeaks(entry.result, columns, toX, plot.left);
      firstCurve ??= peaks;
      context.save();
      context.beginPath();
      context.rect(plot.left, plot.top, plot.width, plot.height);
      context.clip();
      context.strokeStyle = entry.color;
      context.lineWidth = 1.2;
      context.beginPath();
      let started = false;
      for (let column = 0; column < columns; column += 1) {
        const value = peaks[column] as number;
        if (!Number.isFinite(value)) continue;
        const x = plot.left + column + 0.5;
        const y = toY(value);
        if (started) context.lineTo(x, y);
        else {
          context.moveTo(x, y);
          started = true;
        }
      }
      context.stroke();
      context.restore();
    }

    // --- labels -----------------------------------------------------------
    context.save();
    context.fillStyle = theme.text;
    context.font = '10px ui-monospace, monospace';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (const value of amplitudeTicks) {
      const y = toY(value);
      if (y < plot.top - 2 || y > plot.top + plot.height + 2) continue;
      context.fillText(spectrum.decibels ? `${value}` : formatEngineering(value, unit, 3), plot.left - 6, y);
    }
    context.restore();
    drawFrequencyLabels(context, plot, frequencyTicks, toX, theme.text);
    drawFrame(context, plot, theme.axis);

    hoverModelRef.current = {
      plot,
      view: 'spectrum',
      frequencyAt,
      curve: firstCurve,
      waterfall: null,
      decibels: spectrum.decibels,
      unit,
      name: results[0]?.name ?? '',
    };

    const peak = results[0]?.result.peak;
    setPeakLabel(
      peak
        ? `peak ${formatEngineering(peak.frequency, 'Hz', 4)} @ ${
            spectrum.decibels
              ? `${(20 * Math.log10(Math.max(1e-15, peak.amplitude))).toFixed(1)} dB`
              : formatEngineering(peak.amplitude, traces.meta(visible[0]?.signalId ?? '')?.unit ?? '', 4)
          }`
        : null,
    );
  }, [boxRef, height, spectrum, traceConfigs]);

  useEffect(() => {
    let frame = 0;
    let lastData = -1;
    // The transform is the expensive part of the frame, so it runs at ~12 Hz
    // rather than on every animation frame. That is also the waterfall's row
    // rate: a row per transform, never a duplicate row from a repaint.
    let lastRun = 0;

    const loop = () => {
      frame = requestAnimationFrame(loop);
      const now = Date.now();
      if (traces.dataVersion === lastData || now - lastRun < 80) return;
      lastData = traces.dataVersion;
      lastRun = now;
      render();
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [render, width]);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const model = hoverModelRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!model || x < model.plot.left || x > model.plot.left + model.plot.width || y < model.plot.top || y > model.plot.top + model.plot.height) {
      setHover(null);
      return;
    }
    const column = Math.floor(x - model.plot.left);
    const frequency = formatEngineering(model.frequencyAt(x), 'Hz', 4);
    const level = (value: number | undefined) =>
      value === undefined || !Number.isFinite(value)
        ? '—'
        : model.decibels
          ? `${value.toFixed(1)} dB`
          : formatEngineering(value, model.unit, 4);

    if (model.view === 'spectrum') {
      setHover({ x, y, label: `${frequency} · ${level(model.curve?.[column])} · ${model.name}` });
      return;
    }
    const waterfall = model.waterfall;
    const rowFromTop = Math.floor(y - model.plot.top);
    if (!waterfall || rowFromTop >= waterfall.rows.length) {
      setHover({ x, y, label: frequency });
      return;
    }
    const index = waterfall.rows.length - 1 - rowFromTop;
    const ago = (waterfall.times.at(-1) ?? 0) - (waterfall.times[index] ?? 0);
    setHover({
      x,
      y,
      label: `${frequency} · ${ago > 0 ? `−${formatDuration(ago)}` : 'now'} · ${level(waterfall.rows[index]?.[column])}`,
    });
  };

  return (
    <div
      ref={boxRef}
      className="relative w-full border-t border-border"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height }}
        className="block"
        role="img"
        aria-label={spectrum.view === 'waterfall' ? 'Spectrum waterfall' : 'Amplitude spectrum'}
      />

      <div className="absolute top-1.5 flex items-center gap-2" style={{ left: AXIS_LEFT + 6 }}>
        <ButtonGroup>
          {/* The readout is in the other view's units, so it goes with the switch. */}
          <Segment
            active={spectrum.view === 'spectrum'}
            onClick={() => {
              setHover(null);
              setSpectrum({ view: 'spectrum' });
            }}
          >
            Spectrum
          </Segment>
          <Segment
            active={spectrum.view === 'waterfall'}
            onClick={() => {
              setHover(null);
              setSpectrum({ view: 'waterfall' });
            }}
          >
            Waterfall
          </Segment>
        </ButtonGroup>
        {spectrum.view === 'waterfall' && waterfallSource ? (
          <span className="rounded bg-panel/85 px-1.5 text-[10.5px] text-text-muted">{waterfallSource}</span>
        ) : null}
      </div>

      {hover ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute w-px bg-[var(--color-plot-cursor)] opacity-50"
            style={{ left: hover.x, top: AXIS_TOP, height: height - AXIS_TOP - AXIS_BOTTOM }}
          />
          {spectrum.view === 'waterfall' ? (
            <span
              aria-hidden
              className="pointer-events-none absolute h-px bg-[var(--color-plot-cursor)] opacity-50"
              style={{ top: hover.y, left: AXIS_LEFT, right: LEGEND_WIDTH }}
            />
          ) : null}
          <span
            className="num pointer-events-none absolute rounded bg-panel/90 px-1.5 text-[10.5px] text-text"
            style={{
              top: Math.max(4, hover.y - 20),
              // Flip to the left of the pointer near the right edge, so the
              // readout never runs off the panel.
              ...(hover.x > width - 220 ? { right: width - hover.x + 8 } : { left: hover.x + 8 }),
            }}
          >
            {hover.label}
          </span>
        </>
      ) : null}

      {peakLabel && !hover ? (
        <span className="num pointer-events-none absolute top-1.5 right-2 rounded bg-panel/85 px-1.5 text-[10.5px] text-text-muted">
          {peakLabel}
        </span>
      ) : null}
      {notice ? (
        <span className="pointer-events-none absolute bottom-1.5 left-16 text-[10.5px] text-warn">{notice}</span>
      ) : null}
    </div>
  );
}

/** Reduce a spectrum to one level per pixel column, keeping the maximum. */
function columnPeaks(
  result: SpectrumResult,
  columns: number,
  toX: (frequency: number) => number,
  plotLeft: number,
): Float32Array {
  const peaks = new Float32Array(columns).fill(Number.NEGATIVE_INFINITY);
  const { magnitudes, binWidth } = result;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor(toX(bin * binWidth) - plotLeft)));
    const value = magnitudes[bin] as number;
    if (value > (peaks[column] as number)) peaks[column] = value;
  }
  return peaks;
}

/**
 * Add one row and re-derive the colour range from what is still on screen.
 *
 * The range follows the loudest bin *currently visible*, so a transient spike
 * dims the plot only until it scrolls off, rather than for the rest of the
 * session.
 */
function pushWaterfallRow(
  previous: Waterfall | null,
  key: string,
  row: Float32Array,
  time: number,
  maxRows: number,
  decibels: boolean,
): Waterfall {
  const waterfall: Waterfall =
    previous && previous.key === key ? previous : { key, rows: [], times: [], floor: 0, top: 1 };
  waterfall.rows.push(row);
  waterfall.times.push(time);
  if (waterfall.rows.length > maxRows) {
    waterfall.rows.splice(0, waterfall.rows.length - maxRows);
    waterfall.times.splice(0, waterfall.times.length - maxRows);
  }

  let loudest = Number.NEGATIVE_INFINITY;
  for (const entry of waterfall.rows) {
    for (let column = 0; column < entry.length; column += 1) {
      const value = entry[column] as number;
      if (value > loudest) loudest = value;
    }
  }
  if (decibels) {
    waterfall.top = Number.isFinite(loudest) ? Math.ceil(loudest / 10) * 10 : 0;
    waterfall.floor = waterfall.top - DYNAMIC_RANGE_DB;
  } else {
    waterfall.floor = 0;
    waterfall.top = Number.isFinite(loudest) && loudest > 0 ? loudest * 1.05 : 1;
  }
  return waterfall;
}

/** Newest row at the top, one CSS pixel per row. */
function drawWaterfall(
  context: CanvasRenderingContext2D,
  offscreen: HTMLCanvasElement,
  plot: PlotBox,
  waterfall: Waterfall,
  ramp: Uint8ClampedArray,
): void {
  const rows = waterfall.rows.length;
  const columns = waterfall.rows[0]?.length ?? 0;
  if (rows === 0 || columns === 0) return;

  offscreen.width = columns;
  offscreen.height = rows;
  const offscreenContext = offscreen.getContext('2d');
  if (!offscreenContext) return;
  const image = offscreenContext.createImageData(columns, rows);
  const pixels = image.data;
  const span = waterfall.top - waterfall.floor || 1;
  const steps = ramp.length / 3 - 1;

  for (let y = 0; y < rows; y += 1) {
    const row = waterfall.rows[rows - 1 - y] as Float32Array;
    for (let x = 0; x < columns; x += 1) {
      const value = row[x] as number;
      const t = Number.isFinite(value) ? Math.min(1, Math.max(0, (value - waterfall.floor) / span)) : 0;
      const step = Math.round(t * steps) * 3;
      const offset = (y * columns + x) * 4;
      pixels[offset] = ramp[step] as number;
      pixels[offset + 1] = ramp[step + 1] as number;
      pixels[offset + 2] = ramp[step + 2] as number;
      pixels[offset + 3] = 255;
    }
  }
  offscreenContext.putImageData(image, 0, 0);
  context.drawImage(offscreen, plot.left, plot.top, plot.width, rows);
}

/** The scale legend: a colour bar to the right of the plot, labelled at both ends. */
function drawColourBar(
  context: CanvasRenderingContext2D,
  plot: PlotBox,
  ramp: Uint8ClampedArray,
  waterfall: Waterfall,
  decibels: boolean,
  unit: string,
  textColor: string,
): void {
  const left = plot.left + plot.width + 8;
  const barWidth = 8;
  const steps = ramp.length / 3;
  const slice = plot.height / steps;
  context.save();
  for (let index = 0; index < steps; index += 1) {
    const step = (steps - 1 - index) * 3;
    context.fillStyle = `rgb(${ramp[step]},${ramp[step + 1]},${ramp[step + 2]})`;
    context.fillRect(left, plot.top + index * slice, barWidth, Math.ceil(slice) + 0.5);
  }
  context.fillStyle = textColor;
  context.font = '10px ui-monospace, monospace';
  context.textAlign = 'left';
  const label = (value: number) => (decibels ? `${Math.round(value)} ${unit}` : formatEngineering(value, unit, 3));
  context.textBaseline = 'top';
  context.fillText(label(waterfall.top), left + barWidth + 4, plot.top);
  context.textBaseline = 'bottom';
  context.fillText(label(waterfall.floor), left + barWidth + 4, plot.top + plot.height);
  context.restore();
}

function drawFrequencyLabels(
  context: CanvasRenderingContext2D,
  plot: PlotBox,
  ticks: number[],
  toX: (frequency: number) => number,
  textColor: string,
): void {
  context.save();
  context.fillStyle = textColor;
  context.font = '10px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const frequency of ticks) {
    const x = toX(frequency);
    if (x < plot.left - 4 || x > plot.left + plot.width + 4) continue;
    context.fillText(formatEngineering(frequency, 'Hz', 3), x, plot.top + plot.height + 4);
  }
  context.restore();
}

/** Decade ticks plus 2 and 5 within each decade, the usual log-axis set. */
function logTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  const start = Math.floor(Math.log10(Math.max(1e-6, min)));
  const end = Math.ceil(Math.log10(Math.max(1e-6, max)));
  for (let exponent = start; exponent <= end; exponent += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exponent;
      if (value >= min && value <= max) ticks.push(value);
    }
  }
  return ticks;
}
