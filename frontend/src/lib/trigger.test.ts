import { describe, expect, it } from 'vitest';
import { TraceBuffer } from './trace';
import { autoTimeout, CrossingDetector, decideView } from './trigger';

/**
 * The trigger decides which slice of time is on screen, so a mistake here shows
 * the wrong data rather than crashing. Every case below is one a bench scope is
 * expected to get right.
 */

const START = 1_000;
const RATE = 1_000;

/** `seconds` of a sine at `frequency`, sampled at RATE, starting at START. */
function sine(frequency: number, seconds: number, amplitude = 1): Float32Array {
  const values = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < values.length; index += 1) {
    values[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE);
  }
  return values;
}

function bufferOf(values: Float32Array, start = START): TraceBuffer {
  const buffer = new TraceBuffer();
  buffer.appendRaw(start, 1 / RATE, values);
  return buffer;
}

describe('CrossingDetector', () => {
  it('finds each rising zero crossing of a sine, interpolated between samples', () => {
    const detector = new CrossingDetector();
    detector.update(bufferOf(sine(10, 1)), 0, 'rising', 0);

    // A 10 Hz sine starting at zero crosses upward every 100 ms; the one at t=0
    // is not a crossing, because nothing preceded it.
    const found = detector.all().map((time) => time - START);
    expect(found).toHaveLength(9);
    found.forEach((time, index) => expect(time).toBeCloseTo((index + 1) * 0.1, 4));
  });

  it('finds falling crossings on the other half-cycle', () => {
    const detector = new CrossingDetector();
    detector.update(bufferOf(sine(10, 1)), 0, 'falling', 0);
    const found = detector.all().map((time) => time - START);
    expect(found).toHaveLength(10);
    found.forEach((time, index) => expect(time).toBeCloseTo(0.05 + index * 0.1, 4));
  });

  it('crosses at a non-zero level where the waveform actually reaches it', () => {
    const detector = new CrossingDetector();
    detector.update(bufferOf(sine(10, 1)), 0.5, 'rising', 0);
    // sin(2πft) = 0.5 at 1/12 of a period, 8.33 ms into each cycle. Unlike the
    // zero-level case the first cycle counts: the sine starts *below* 0.5.
    const found = detector.all().map((time) => time - START);
    expect(found).toHaveLength(10);
    found.forEach((time, index) => expect(time).toBeCloseTo(index * 0.1 + 0.1 / 12, 4));
  });

  it('sees every crossing when fed a frame at a time, however short the frames', () => {
    // The failure this guards against: a detector that rescans only the last
    // window each frame steps over crossings that land between two frames.
    const whole = new CrossingDetector();
    whole.update(bufferOf(sine(10, 1)), 0, 'rising', 0);

    const buffer = new TraceBuffer();
    const chunked = new CrossingDetector();
    const values = sine(10, 1);
    for (let offset = 0; offset < values.length; offset += 37) {
      const chunk = values.subarray(offset, Math.min(values.length, offset + 37));
      buffer.appendRaw(START + offset / RATE, 1 / RATE, chunk);
      chunked.update(buffer, 0, 'rising', 0);
    }
    expect(chunked.all()).toHaveLength(whole.all().length);
    chunked.all().forEach((time, index) => expect(time).toBeCloseTo(whole.all()[index] as number, 9));
  });

  it('rejects noise on a slow edge once a noise band is set', () => {
    // A slow ramp through zero with ±0.05 of chatter riding on it: it crosses
    // zero several times on the way up, but it is one edge.
    const values = new Float32Array(400);
    for (let index = 0; index < 400; index += 1) {
      const ramp = index < 200 ? -1 + index / 100 : 3 - index / 100;
      values[index] = ramp + (index % 2 === 0 ? 0.05 : -0.05);
    }

    const noisy = new CrossingDetector();
    noisy.update(bufferOf(values), 0, 'rising', 0);
    expect(noisy.all().length).toBeGreaterThan(1);

    const clean = new CrossingDetector();
    clean.update(bufferOf(values), 0, 'rising', 0.2);
    expect(clean.all()).toHaveLength(1);
  });

  it('starts over when the level changes', () => {
    const detector = new CrossingDetector();
    const buffer = bufferOf(sine(10, 1));
    detector.update(buffer, 0, 'rising', 0);
    expect(detector.all().length).toBeGreaterThan(0);
    // A level the sine never reaches: whatever was found at 0 no longer applies.
    detector.update(buffer, 5, 'rising', 0);
    expect(detector.all()).toHaveLength(0);
  });

  it('starts over when the buffer is reset to an earlier time', () => {
    const detector = new CrossingDetector();
    detector.update(bufferOf(sine(10, 1), START + 100), 0, 'rising', 0);
    expect(detector.all().length).toBeGreaterThan(0);
    // A new stream epoch: the ring now holds data older than what was scanned.
    detector.update(bufferOf(sine(10, 0.05)), 0, 'rising', 0);
    expect(detector.all()).toHaveLength(0);
  });

  describe('latestComplete', () => {
    const detector = new CrossingDetector();
    detector.update(bufferOf(sine(10, 1)), 0, 'rising', 0);
    const latest = START + 0.999;

    it('returns the newest crossing whose right-hand side has fully arrived', () => {
      // 0.9 + 0.05 fits inside the data, so it is usable.
      expect((detector.latestComplete(latest, 0.05, -Infinity) as number) - START).toBeCloseTo(0.9, 4);
      // 0.9 + 0.2 does not; the one before it does.
      expect((detector.latestComplete(latest, 0.2, -Infinity) as number) - START).toBeCloseTo(0.7, 4);
    });

    it('ignores crossings from before arming', () => {
      expect(detector.latestComplete(latest, 0.05, START + 0.95)).toBeNull();
      expect((detector.latestComplete(latest, 0.05, START + 0.85) as number) - START).toBeCloseTo(0.9, 4);
    });
  });
});

describe('decideView', () => {
  const base = { windowSeconds: 0.2, position: 0.5, latestTime: 100 };

  it('free-runs when the trigger is off', () => {
    expect(decideView({ ...base, mode: 'off', crossing: 99.8 })).toEqual({
      end: null,
      status: 'off',
      triggerTime: null,
    });
  });

  it('puts the crossing at the chosen position in the window', () => {
    const view = decideView({ ...base, mode: 'normal', position: 0.25, crossing: 99.5 });
    // A quarter of the window before the crossing, three quarters after.
    expect(view.end).toBeCloseTo(99.5 + 0.75 * 0.2, 9);
    expect(view.triggerTime).toBe(99.5);
  });

  it('waits in normal mode until something crosses', () => {
    expect(decideView({ ...base, mode: 'normal', crossing: null }).status).toBe('armed');
  });

  it('says it is holding, not triggered, when the last crossing is old', () => {
    const recent = decideView({ ...base, mode: 'normal', crossing: 99.8 });
    expect(recent.status).toBe('triggered');
    const old = decideView({ ...base, mode: 'normal', crossing: 90 });
    expect(old.status).toBe('holding');
    expect(old.end).toBeCloseTo(90.1, 9);
  });

  it('free-runs in auto mode once nothing has crossed for longer than the timeout', () => {
    const timeout = autoTimeout(base.windowSeconds);
    const justInside = decideView({ ...base, mode: 'auto', crossing: 100 - 0.1 - timeout + 0.01 });
    expect(justInside.status).toBe('triggered');
    const tooOld = decideView({ ...base, mode: 'auto', crossing: 100 - 0.1 - timeout - 0.01 });
    expect(tooOld).toEqual({ end: null, status: 'auto', triggerTime: null });
    expect(decideView({ ...base, mode: 'auto', crossing: null }).status).toBe('auto');
  });

  it('stops on the first crossing in single mode', () => {
    expect(decideView({ ...base, mode: 'single', crossing: null }).status).toBe('armed');
    const captured = decideView({ ...base, mode: 'single', crossing: 99.7 });
    expect(captured.status).toBe('stopped');
    expect(captured.end).toBeCloseTo(99.8, 9);
  });

  it('waits rather than guessing before any data has arrived', () => {
    expect(decideView({ ...base, mode: 'auto', latestTime: null, crossing: null }).status).toBe('armed');
  });
});
