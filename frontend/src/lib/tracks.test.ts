import { describe, expect, it } from 'vitest';
import { cleanValue, groupTracks, nextRange, tickLabel, tickStep } from './tracks';

describe('nextRange', () => {
  it('grows at once to fit a peak', () => {
    const range = nextRange({ min: -1, max: 1 }, { min: -1, max: 5 })!;
    expect(range.max).toBeGreaterThan(5);
  });

  it('shrinks slowly after the peak has gone', () => {
    const wide = { min: -10, max: 10 };
    const next = nextRange(wide, { min: -1, max: 1 })!;
    expect(next.max).toBeLessThan(10);
    expect(next.max).toBeGreaterThan(5);
  });

  it('gives a flat signal a band', () => {
    const flat = nextRange(null, { min: 3, max: 3 })!;
    expect(flat.max - flat.min).toBeGreaterThan(0);
  });
});

describe('ruler', () => {
  it('picks round steps and labels them from the live edge', () => {
    expect(tickStep(10)).toBe(2);
    expect(tickStep(60)).toBe(10);
    expect(tickLabel(0, 2)).toBe('now');
    expect(tickLabel(4, 2)).toBe('-4 s');
    expect(tickLabel(0.4, 0.2)).toBe('-0.4 s');
    expect(tickLabel(120, 60)).toBe('-2 min');
  });
});

describe('groupTracks', () => {
  const devices: Record<string, string | null> = { a0: 'dev0', a1: 'dev0', b0: 'dev1', rms: null, free: null };
  const deviceOf = (id: string) => devices[id] ?? null;

  it('keeps function block outputs with the device of the signal they read, and the instance last', () => {
    const groups = groupTracks(['free', 'a0', 'b0', 'rms', 'a1'], deviceOf, (id) => (id === 'rms' ? 'a0' : null));
    expect(groups).toEqual([
      { deviceId: 'dev0', tracks: ['a0', 'rms', 'a1'] },
      { deviceId: 'dev1', tracks: ['b0'] },
      { deviceId: null, tracks: ['free'] },
    ]);
  });
});

describe('cleanValue', () => {
  it('reads rounding noise as zero and keeps small real values', () => {
    expect(cleanValue(-4.4e-13, 10)).toBe(0);
    expect(cleanValue(2e-6, 1e-5)).toBe(2e-6);
  });
});
