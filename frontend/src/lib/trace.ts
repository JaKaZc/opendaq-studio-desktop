/**
 * Client-side sample storage for one signal.
 *
 * Points are stored as `(time, min, max)` triples in a ring buffer.  For raw
 * samples `min === max`; for a server-decimated bucket they are the bucket's
 * extremes.  One representation for both means the renderer, the autoscaler and
 * the cursor readout each have a single code path, and a trace can mix modes
 * when the user changes resolution mid-capture.
 *
 * Memory is 16 bytes per point (Float64 time + two Float32), so the default
 * 240 000-point ring costs ~3.8 MB per trace.
 */

export interface WindowStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  rms: number;
  stdDev: number;
  peakToPeak: number;
  first: number;
  last: number;
  tMin: number;
  tMax: number;
}

/** Per-pixel-column aggregate, ready for the canvas renderer. */
export interface ColumnSeries {
  /** Number of populated columns. */
  count: number;
  /** Column index -> whether it holds data. */
  filled: Uint8Array;
  mins: Float32Array;
  maxs: Float32Array;
  /** Last value in each column, for the connecting line. */
  lasts: Float32Array;
}

export const DEFAULT_TRACE_CAPACITY = 240_000;

export class TraceBuffer {
  readonly capacity: number;
  private readonly times: Float64Array;
  private readonly mins: Float32Array;
  private readonly maxs: Float32Array;
  /** Total points ever written; the ring holds the newest `capacity` of them. */
  private written = 0;

  constructor(capacity: number = DEFAULT_TRACE_CAPACITY) {
    this.capacity = Math.max(1024, capacity);
    this.times = new Float64Array(this.capacity);
    this.mins = new Float32Array(this.capacity);
    this.maxs = new Float32Array(this.capacity);
  }

  get length(): number {
    return Math.min(this.written, this.capacity);
  }

  get isEmpty(): boolean {
    return this.written === 0;
  }

  clear(): void {
    this.written = 0;
  }

  /** Absolute index of the oldest point still in the ring. */
  private get oldest(): number {
    return Math.max(0, this.written - this.capacity);
  }

  private push(time: number, min: number, max: number): void {
    const slot = this.written % this.capacity;
    this.times[slot] = time;
    this.mins[slot] = min;
    this.maxs[slot] = max;
    this.written += 1;
  }

  /** Append uniformly spaced raw samples starting at `startTime`. */
  appendRaw(startTime: number, interval: number, values: Float32Array): void {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] as number;
      this.push(startTime + index * interval, value, value);
    }
  }

  /**
   * Append server-decimated buckets.  `interleaved` is `[min0, max0, min1, ...]`
   * and each pair covers `bucketSeconds`; the point is timestamped at the middle
   * of its bucket so the trace stays centred as resolution changes.
   */
  appendMinMax(startTime: number, bucketSeconds: number, interleaved: Float32Array): void {
    const buckets = interleaved.length >> 1;
    for (let index = 0; index < buckets; index += 1) {
      const low = interleaved[index * 2] as number;
      const high = interleaved[index * 2 + 1] as number;
      this.push(startTime + (index + 0.5) * bucketSeconds, Math.min(low, high), Math.max(low, high));
    }
  }

  timeSpan(): { start: number; end: number } | null {
    if (this.written === 0) return null;
    const first = this.oldest % this.capacity;
    const last = (this.written - 1) % this.capacity;
    return { start: this.times[first] as number, end: this.times[last] as number };
  }

  latestTime(): number | null {
    if (this.written === 0) return null;
    return this.times[(this.written - 1) % this.capacity] as number;
  }

  latestValue(): number | null {
    if (this.written === 0) return null;
    const slot = (this.written - 1) % this.capacity;
    // For a decimated bucket the "current value" is best represented by its mean.
    return (((this.mins[slot] as number) + (this.maxs[slot] as number)) / 2) as number;
  }

  /**
   * First absolute index whose time is >= `time`, by binary search over the
   * ring.  Times are monotonic within the ring because a discontinuity clears it.
   */
  private lowerBound(time: number): number {
    let low = this.oldest;
    let high = this.written;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.times[middle % this.capacity] as number) < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /**
   * Reduce the window `[start, end]` to one min/max per pixel column.
   *
   * Aggregating on the client means the canvas draws at most `columns * 2`
   * vertices regardless of how many samples the window covers, which is what
   * keeps a 60 s view of a 20 kHz signal interactive.
   */
  toColumns(start: number, end: number, columns: number, out?: ColumnSeries): ColumnSeries {
    const width = Math.max(1, columns);
    const series: ColumnSeries =
      out && out.filled.length === width
        ? out
        : {
            count: width,
            filled: new Uint8Array(width),
            mins: new Float32Array(width),
            maxs: new Float32Array(width),
            lasts: new Float32Array(width),
          };
    series.count = width;
    series.filled.fill(0);

    if (this.written === 0 || end <= start) return series;

    const span = end - start;
    const scale = width / span;
    const from = this.lowerBound(start);
    const to = this.lowerBound(end);

    for (let index = from; index < to; index += 1) {
      const slot = index % this.capacity;
      const column = Math.min(width - 1, Math.max(0, ((this.times[slot] as number) - start) * scale | 0));
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      if (series.filled[column] === 0) {
        series.filled[column] = 1;
        series.mins[column] = low;
        series.maxs[column] = high;
      } else {
        if (low < (series.mins[column] as number)) series.mins[column] = low;
        if (high > (series.maxs[column] as number)) series.maxs[column] = high;
      }
      series.lasts[column] = high === low ? low : (low + high) / 2;
    }
    return series;
  }

  /** Value extremes inside a window, for autoscaling. */
  extent(start: number, end: number): { min: number; max: number } | null {
    if (this.written === 0) return null;
    const from = this.lowerBound(start);
    const to = this.lowerBound(end);
    if (to <= from) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let index = from; index < to; index += 1) {
      const slot = index % this.capacity;
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      if (low < min) min = low;
      if (high > max) max = high;
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  /** Statistics over a window. Decimated buckets contribute their midpoints. */
  stats(start: number, end: number): WindowStats | null {
    if (this.written === 0) return null;
    const from = this.lowerBound(start);
    const to = this.lowerBound(end);
    if (to <= from) return null;

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    let first = 0;
    let last = 0;
    let tMin = 0;
    let tMax = 0;

    for (let index = from; index < to; index += 1) {
      const slot = index % this.capacity;
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      const value = low === high ? low : (low + high) / 2;
      if (low < min) min = low;
      if (high > max) max = high;
      sum += value;
      sumSquares += value * value;
      if (count === 0) {
        first = value;
        tMin = this.times[slot] as number;
      }
      last = value;
      tMax = this.times[slot] as number;
      count += 1;
    }

    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    return {
      count,
      min,
      max,
      mean,
      rms: Math.sqrt(sumSquares / count),
      stdDev: Math.sqrt(variance),
      peakToPeak: max - min,
      first,
      last,
      tMin,
      tMax,
    };
  }

  /**
   * Value nearest a point in time, for the cursor readout.  Returns `null` when
   * the cursor is further than `tolerance` seconds from any sample.
   */
  valueAt(time: number, tolerance: number): { time: number; value: number } | null {
    if (this.written === 0) return null;
    const index = this.lowerBound(time);
    const candidates = [index - 1, index].filter((i) => i >= this.oldest && i < this.written);
    let best: { time: number; value: number } | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const slot = candidate % this.capacity;
      const sampleTime = this.times[slot] as number;
      const distance = Math.abs(sampleTime - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        const low = this.mins[slot] as number;
        const high = this.maxs[slot] as number;
        best = { time: sampleTime, value: low === high ? low : (low + high) / 2 };
      }
    }
    return best && bestDistance <= tolerance ? best : null;
  }

  /**
   * Copy the newest `count` values into a plain array, for FFT and export.
   *
   * Only meaningful when the trace is being fed raw samples: a decimated trace
   * has no uniform sample grid, so the caller must check `isUniform` first.
   */
  tail(count: number): { values: Float64Array; interval: number; startTime: number } | null {
    const available = this.length;
    if (available === 0) return null;
    const take = Math.min(count, available);
    const startIndex = this.written - take;
    const values = new Float64Array(take);
    for (let index = 0; index < take; index += 1) {
      const slot = (startIndex + index) % this.capacity;
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      values[index] = low === high ? low : (low + high) / 2;
    }
    const startTime = this.times[startIndex % this.capacity] as number;
    const endTime = this.times[(this.written - 1) % this.capacity] as number;
    const interval = take > 1 ? (endTime - startTime) / (take - 1) : 0;
    return { values, interval, startTime };
  }

  /**
   * Visit every point strictly newer than `after`, oldest first.
   *
   * Returns the time of the last point visited, or `after` when nothing is newer.
   * Feeding that back in as the next `after` makes a consumer incremental: the
   * trigger detector sees each sample exactly once, however long the ring is,
   * instead of rescanning a whole window on every frame.
   */
  scanAfter(after: number, visit: (time: number, value: number) => void): number {
    if (this.written === 0) return after;
    let index = this.lowerBound(after);
    // `lowerBound` is inclusive; a point exactly at `after` was visited last time.
    while (index < this.written && (this.times[index % this.capacity] as number) <= after) index += 1;
    let last = after;
    for (; index < this.written; index += 1) {
      const slot = index % this.capacity;
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      last = this.times[slot] as number;
      visit(last, low === high ? low : (low + high) / 2);
    }
    return last;
  }

  /** Points inside a window as parallel arrays, for CSV export of the view. */
  window(start: number, end: number): { times: Float64Array; values: Float64Array } {
    const from = this.lowerBound(start);
    const to = this.lowerBound(end);
    const count = Math.max(0, to - from);
    const times = new Float64Array(count);
    const values = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const slot = (from + index) % this.capacity;
      const low = this.mins[slot] as number;
      const high = this.maxs[slot] as number;
      times[index] = this.times[slot] as number;
      values[index] = low === high ? low : (low + high) / 2;
    }
    return { times, values };
  }
}
