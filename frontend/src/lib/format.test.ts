import { describe, expect, it } from 'vitest';
import { formatEngineering, formatTimeOfDay, niceTicks } from './format';

/**
 * Formatters shown on continuously updating readouts.
 *
 * The clock and the scope axis redraw many times a second, so a formatter that
 * is wrong for one value in a thousand is wrong on screen every second.
 */
describe('formatTimeOfDay', () => {
  /** A fixed instant, built from local parts so the test does not depend on TZ. */
  const at = (h: number, m: number, s: number, ms: number) =>
    new Date(2026, 8, 22, h, m, s, ms).getTime() / 1000;

  it('shows the fraction it was asked for', () => {
    expect(formatTimeOfDay(at(15, 4, 37, 978), 3)).toBe('15:04:37.978');
    expect(formatTimeOfDay(at(15, 4, 37, 978), 0)).toBe('15:04:37');
  });

  it('does not roll the fraction past the second it belongs to', () => {
    // 37.9999 s truncates to 37.999 — never to 37.000, which is what rounding
    // the fraction on its own produces while the seconds still read 37.
    expect(formatTimeOfDay(at(15, 4, 37, 0) + 0.9999, 3)).toBe('15:04:37.999');
    expect(formatTimeOfDay(at(15, 4, 37, 0) + 0.99999, 4)).toBe('15:04:37.9999');
  });

  it('carries into the next second exactly at the boundary', () => {
    expect(formatTimeOfDay(at(15, 4, 38, 0), 3)).toBe('15:04:38.000');
  });

  it('pads a short fraction rather than truncating the digits', () => {
    expect(formatTimeOfDay(at(15, 4, 37, 5), 3)).toBe('15:04:37.005');
  });

  it('reports a non-finite input rather than rendering NaN', () => {
    expect(formatTimeOfDay(Number.NaN)).toBe('—');
  });
});

describe('formatEngineering for clock offsets', () => {
  it('scales a sub-millisecond offset into microseconds', () => {
    expect(formatEngineering(0.000_048_9, 's', 3)).toBe('48.9 µs');
  });

  it('keeps a whole-second offset in seconds', () => {
    expect(formatEngineering(1.25, 's', 3)).toBe('1.25 s');
  });
});

describe('niceTicks', () => {
  it('lands exactly on zero when the range spans it', () => {
    // Summing 0.1 steps from -1 used to give -1.4e-16 here, and the zero
    // gridline was labelled "-0.139 fV".
    const ticks = niceTicks(-1, 1, 20);
    expect(ticks).toContain(0);
    expect(ticks.every((tick) => tick === 0 || Math.abs(tick) >= 0.05)).toBe(true);
    expect(Object.is(ticks[ticks.indexOf(0)], -0)).toBe(false);
  });

  it('keeps every tick on the step grid', () => {
    for (const tick of niceTicks(-0.003, 0.003, 12)) {
      expect(Math.abs(tick / 0.0005 - Math.round(tick / 0.0005))).toBeLessThan(1e-9);
    }
  });

  it('covers the range with round steps', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
