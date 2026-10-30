/**
 * Canvas plotting helpers shared by the scope, the spectrum and the sparklines.
 *
 * Two details matter for a plot that has to look right in a measurement tool:
 *
 * - **Device pixel ratio.**  The backing store is sized in device pixels and the
 *   context scaled, so a 1 px grid line is one *physical* pixel on a HiDPI screen
 *   rather than a blurry two.
 * - **Theme via CSS variables.**  Colours are read from the stylesheet rather than
 *   hardcoded, so the light and dark palettes stay in one place and a theme switch
 *   needs no code change here.
 */

import type { ColumnSeries } from '../../lib/trace';

export interface PlotTheme {
  background: string;
  grid: string;
  axis: string;
  text: string;
  cursor: string;
  /** The hue magnitude ramps are built from, e.g. the spectrum waterfall. */
  brand: string;
}

/** Read the plot palette from the document's computed styles. */
export function readPlotTheme(element: HTMLElement): PlotTheme {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--color-plot-bg', '#ffffff'),
    grid: read('--color-plot-grid', '#e7ebef'),
    axis: read('--color-plot-axis', '#a9b6c2'),
    text: read('--color-plot-text', '#56687a'),
    cursor: read('--color-plot-cursor', '#00335a'),
    brand: read('--color-brand', '#f15d31'),
  };
}

export interface CanvasSetup {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  ratio: number;
}

/**
 * Size the canvas backing store to its CSS box and return a scaled context.
 *
 * Returns `null` when the element has no layout yet, which happens on the first
 * frame after mount and inside a collapsed panel.
 */
export function setupCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasSetup | null {
  if (cssWidth < 2 || cssHeight < 2) return null;
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(cssHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: cssWidth, height: cssHeight, ratio };
}

export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ValueScale {
  min: number;
  max: number;
}

/** Map a value to a y pixel inside the plot box. */
export function makeYMapper(box: PlotBox, scale: ValueScale): (value: number) => number {
  const span = scale.max - scale.min || 1;
  const factor = box.height / span;
  return (value) => box.top + box.height - (value - scale.min) * factor;
}

/** Map a time to an x pixel inside the plot box. */
export function makeXMapper(box: PlotBox, start: number, end: number): (time: number) => number {
  const span = end - start || 1;
  const factor = box.width / span;
  return (time) => box.left + (time - start) * factor;
}

/**
 * Draw a min/max column series.
 *
 * Two cases have to look right with one code path:
 *
 * - **More samples than pixels** (decimated): a column covers a range, so it is
 *   drawn as a vertical span. The result is the signal's true envelope rather
 *   than an arbitrary sample per bucket.
 * - **Fewer samples than pixels** (zoomed in): most columns are empty, and the
 *   line must be *interpolated* across them. Treating an empty column as a data
 *   gap is what turns a zoomed-in trace into a field of dots.
 *
 * `maxGapColumns` separates the two: a run of empty columns longer than that is
 * a genuine hole in the data and does break the line.
 */
export function drawColumnSeries(
  context: CanvasRenderingContext2D,
  series: ColumnSeries,
  box: PlotBox,
  toY: (value: number) => number,
  color: string,
  lineWidth = 1.25,
  maxGapColumns = Number.POSITIVE_INFINITY,
): void {
  context.save();
  context.beginPath();
  context.rect(box.left, box.top, box.width, box.height);
  context.clip();

  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();

  const scale = box.width / Math.max(1, series.count);
  /** A span shorter than this is a single point, not a range worth drawing. */
  const MIN_SPAN_PX = 0.6;

  let previousColumn = -1;
  let penY = 0;

  for (let column = 0; column < series.count; column += 1) {
    if (series.filled[column] === 0) continue;

    const x = box.left + (column + 0.5) * scale;
    // toY inverts, so the maximum value maps to the smaller y.
    const yTop = toY(series.maxs[column] as number);
    const yBottom = toY(series.mins[column] as number);
    const hasSpan = Math.abs(yBottom - yTop) > MIN_SPAN_PX;

    const continues = previousColumn >= 0 && column - previousColumn <= maxGapColumns;
    if (continues) {
      // Enter the span at whichever end is closer to where the pen already is,
      // then traverse it - that keeps the outline continuous instead of
      // zig-zagging through the middle of every bucket.
      const entry = Math.abs(penY - yTop) <= Math.abs(penY - yBottom) ? yTop : yBottom;
      context.lineTo(x, entry);
      if (hasSpan) {
        const exit = entry === yTop ? yBottom : yTop;
        context.lineTo(x, exit);
        penY = exit;
      } else {
        penY = entry;
      }
    } else {
      context.moveTo(x, yTop);
      if (hasSpan) {
        context.lineTo(x, yBottom);
        penY = yBottom;
      } else {
        penY = yTop;
      }
    }
    previousColumn = column;
  }

  context.stroke();
  context.restore();
}

/**
 * How many empty pixel columns may be bridged before the line is broken.
 *
 * Derived from the sample spacing: three sample intervals without data is a real
 * gap, anything shorter is just a zoom level with more pixels than samples.
 */
export function gapToleranceColumns(sampleInterval: number, secondsPerColumn: number): number {
  if (!(sampleInterval > 0) || !(secondsPerColumn > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(2, Math.ceil((3 * sampleInterval) / secondsPerColumn));
}

/** Horizontal and vertical grid lines with the given pixel positions. */
export function drawGrid(
  context: CanvasRenderingContext2D,
  box: PlotBox,
  xs: number[],
  ys: number[],
  color: string,
): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  for (const x of xs) {
    // The half-pixel offset keeps a 1px line crisp instead of straddling two.
    const pixel = Math.round(x) + 0.5;
    context.moveTo(pixel, box.top);
    context.lineTo(pixel, box.top + box.height);
  }
  for (const y of ys) {
    const pixel = Math.round(y) + 0.5;
    context.moveTo(box.left, pixel);
    context.lineTo(box.left + box.width, pixel);
  }
  context.stroke();
  context.restore();
}

export function drawFrame(context: CanvasRenderingContext2D, box: PlotBox, color: string): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.strokeRect(
    Math.round(box.left) + 0.5,
    Math.round(box.top) + 0.5,
    Math.round(box.width) - 1,
    Math.round(box.height) - 1,
  );
  context.restore();
}

/** A dashed vertical cursor with a label at the top. */
export function drawCursor(
  context: CanvasRenderingContext2D,
  box: PlotBox,
  x: number,
  color: string,
  label: string,
): void {
  if (x < box.left || x > box.left + box.width) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  context.beginPath();
  const pixel = Math.round(x) + 0.5;
  context.moveTo(pixel, box.top);
  context.lineTo(pixel, box.top + box.height);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = color;
  context.font = '600 10px ui-monospace, monospace';
  context.textAlign = x > box.left + box.width - 24 ? 'right' : 'left';
  context.textBaseline = 'top';
  context.fillText(label, x > box.left + box.width - 24 ? x - 3 : x + 3, box.top + 2);
  context.restore();
}

/**
 * Pad a value range so a flat trace is not drawn on the axis, and a range with
 * real content gets a little headroom.
 */
export function padScale(min: number, max: number, fraction = 0.08): ValueScale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (max === min) {
    const magnitude = Math.abs(max) || 1;
    return { min: min - magnitude * 0.1, max: max + magnitude * 0.1 };
  }
  const padding = (max - min) * fraction;
  return { min: min - padding, max: max + padding };
}

export function drawEmptyMessage(
  context: CanvasRenderingContext2D,
  box: PlotBox,
  text: string,
  color: string,
): void {
  context.save();
  context.fillStyle = color;
  context.font = '12px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, box.left + box.width / 2, box.top + box.height / 2);
  context.restore();
}
