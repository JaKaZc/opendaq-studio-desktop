import { describe, expect, it } from 'vitest';
import { TraceBuffer } from './trace';

/**
 * The client-side ring buffer.
 *
 * These are the parts where a subtle error is invisible on screen: a trace that
 * slowly drifts, repeats a sample, or reports statistics over the wrong window
 * still *looks* like a plausible signal.
 */

function fillRaw(buffer: TraceBuffer, count: number, start = 0, interval = 0.001): void {
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) values[index] = index;
  buffer.appendRaw(start, interval, values);
}

describe('TraceBuffer', () => {
  it('stores raw samples on a uniform time base', () => {
    const buffer = new TraceBuffer();
    fillRaw(buffer, 100, 10, 0.5);

    expect(buffer.length).toBe(100);
    expect(buffer.timeSpan()).toEqual({ start: 10, end: 10 + 99 * 0.5 });
    expect(buffer.latestValue()).toBe(99);
  });

  it('timestamps a min/max bucket at its centre', () => {
    const buffer = new TraceBuffer();
    // Two buckets of 1 s: [-1, 1] then [-2, 2].
    buffer.appendMinMax(100, 1, new Float32Array([-1, 1, -2, 2]));

    expect(buffer.length).toBe(2);
    // Centre of the first bucket is 100.5, of the second 101.5.
    expect(buffer.timeSpan()).toEqual({ start: 100.5, end: 101.5 });
    expect(buffer.extent(100, 102)).toEqual({ min: -2, max: 2 });
  });

  it('normalises a bucket whose min and max arrive swapped', () => {
    const buffer = new TraceBuffer();
    buffer.appendMinMax(0, 1, new Float32Array([5, -5]));
    expect(buffer.extent(0, 2)).toEqual({ min: -5, max: 5 });
  });

  it('keeps the newest samples once the ring wraps', () => {
    const buffer = new TraceBuffer(1024);
    fillRaw(buffer, 1500);

    expect(buffer.length).toBe(1024);
    // The oldest 476 samples are gone; the newest is still 1499.
    expect(buffer.latestValue()).toBe(1499);
    const span = buffer.timeSpan();
    expect(span?.start).toBeCloseTo(476 * 0.001, 9);
  });

  it('clears on demand', () => {
    const buffer = new TraceBuffer();
    fillRaw(buffer, 50);
    buffer.clear();
    expect(buffer.isEmpty).toBe(true);
    expect(buffer.timeSpan()).toBeNull();
    expect(buffer.latestValue()).toBeNull();
  });

  describe('toColumns', () => {
    it('reduces many samples to one min/max per column', () => {
      const buffer = new TraceBuffer();
      // 1000 samples over 1 s, values 0..999.
      fillRaw(buffer, 1000, 0, 0.001);

      const series = buffer.toColumns(0, 1, 10);
      expect(series.count).toBe(10);
      // Every column holds 100 samples, so column 0 spans 0..99.
      expect(series.filled[0]).toBe(1);
      expect(series.mins[0]).toBe(0);
      expect(series.maxs[0]).toBe(99);
      expect(series.mins[9]).toBe(900);
      expect(series.maxs[9]).toBe(999);
    });

    it('never hides a spike, which is the whole point of min/max', () => {
      const buffer = new TraceBuffer();
      const values = new Float32Array(1000);
      values[437] = 9.5;
      values[438] = -9.5;
      buffer.appendRaw(0, 0.001, values);

      const series = buffer.toColumns(0, 1, 10);
      let low = Infinity;
      let high = -Infinity;
      for (let column = 0; column < series.count; column += 1) {
        if (!series.filled[column]) continue;
        low = Math.min(low, series.mins[column] as number);
        high = Math.max(high, series.maxs[column] as number);
      }
      expect(high).toBe(9.5);
      expect(low).toBe(-9.5);
    });

    it('leaves columns empty when there are more pixels than samples', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 10, 0, 0.1);

      const series = buffer.toColumns(0, 1, 100);
      const filled = [...series.filled].filter(Boolean).length;
      // Ten samples cannot fill a hundred columns; the renderer interpolates.
      expect(filled).toBeLessThanOrEqual(10);
      expect(filled).toBeGreaterThan(0);
    });

    it('reuses the supplied series to avoid per-frame allocation', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 100);
      const first = buffer.toColumns(0, 0.1, 50);
      const second = buffer.toColumns(0, 0.1, 50, first);
      expect(second).toBe(first);
    });

    it('resets stale columns when reused', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 100, 0, 0.001);
      const series = buffer.toColumns(0, 0.1, 50);
      expect([...series.filled].some(Boolean)).toBe(true);

      // A window with no data must not leave the previous frame's columns behind.
      const cleared = buffer.toColumns(500, 501, 50, series);
      expect([...cleared.filled].every((value) => value === 0)).toBe(true);
    });

    it('is empty for an inverted window', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 100);
      const series = buffer.toColumns(1, 0, 10);
      expect([...series.filled].every((value) => value === 0)).toBe(true);
    });
  });

  describe('stats', () => {
    it('computes the statistics of a full sine period', () => {
      const buffer = new TraceBuffer();
      const count = 4096;
      const values = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        values[index] = 5 * Math.sin((2 * Math.PI * index) / count);
      }
      buffer.appendRaw(0, 1 / count, values);

      const stats = buffer.stats(0, 1);
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(count);
      expect(stats!.min).toBeCloseTo(-5, 3);
      expect(stats!.max).toBeCloseTo(5, 3);
      expect(stats!.peakToPeak).toBeCloseTo(10, 3);
      // The mean of a whole period is zero and the RMS is amplitude / sqrt(2).
      expect(stats!.mean).toBeCloseTo(0, 3);
      expect(stats!.rms).toBeCloseTo(5 / Math.SQRT2, 3);
      expect(stats!.stdDev).toBeCloseTo(5 / Math.SQRT2, 3);
    });

    it('only covers the requested window', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 1000, 0, 0.001);
      // Samples 0..99 fall in [0, 0.1).
      const stats = buffer.stats(0, 0.1);
      expect(stats!.count).toBe(100);
      expect(stats!.min).toBe(0);
      expect(stats!.max).toBe(99);
    });

    it('returns null for a window with no samples', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 10, 0, 0.001);
      expect(buffer.stats(100, 200)).toBeNull();
    });
  });

  describe('valueAt', () => {
    it('finds the nearest sample within tolerance', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 100, 0, 0.1);

      const hit = buffer.valueAt(5.04, 0.1);
      expect(hit).not.toBeNull();
      expect(hit!.value).toBe(50);
      expect(hit!.time).toBeCloseTo(5, 9);
    });

    it('reports nothing when the cursor is past the data', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 100, 0, 0.1);
      expect(buffer.valueAt(500, 0.05)).toBeNull();
    });
  });

  describe('tail and window', () => {
    it('returns the newest samples with their spacing', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 1000, 0, 0.002);

      const tail = buffer.tail(256);
      expect(tail).not.toBeNull();
      expect(tail!.values.length).toBe(256);
      expect(tail!.values[255]).toBe(999);
      expect(tail!.interval).toBeCloseTo(0.002, 9);
    });

    it('caps the tail at what is buffered', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 10);
      expect(buffer.tail(4096)!.values.length).toBe(10);
    });

    it('extracts a window in time order for export', () => {
      const buffer = new TraceBuffer();
      fillRaw(buffer, 1000, 0, 0.001);

      const { times, values } = buffer.window(0.1, 0.2);
      expect(values.length).toBe(100);
      expect(values[0]).toBe(100);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]!).toBeGreaterThan(times[index - 1]!);
      }
    });
  });
});
