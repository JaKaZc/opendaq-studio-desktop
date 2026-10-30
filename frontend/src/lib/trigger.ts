/**
 * The scope trigger: find where a signal crosses a level, and decide which
 * window that puts on screen.
 *
 * A free-running scope shows whatever arrived last, so a periodic signal slides
 * across the plot and a one-off event is gone before anyone sees it. A trigger
 * pins the display to the moment the source crosses a level in the chosen
 * direction, which makes a repeating waveform stand still and lets a single
 * event be captured and held.
 *
 * The two halves are deliberately separate and pure:
 *
 * - {@link CrossingDetector} consumes a trace buffer *incrementally*. It keeps
 *   its place, so each sample is examined once, whatever the window length. A
 *   version that rescanned the last window every frame would either cost a full
 *   window per frame or - with a short window and 50 ms frames - step over events
 *   between two scans, which is exactly the failure a trigger exists to prevent.
 * - {@link decideView} turns "where the crossings are" into "what to show",
 *   per mode. It has no state, so every mode's behaviour is a table test.
 */

import type { TraceBuffer } from './trace';

export type TriggerMode = 'off' | 'auto' | 'normal' | 'single';
export type TriggerSlope = 'rising' | 'falling';

/**
 * `armed`     waiting for a crossing
 * `triggered` showing a recent crossing
 * `holding`   normal mode, showing the last crossing while waiting for the next
 * `auto`      auto mode, free-running because nothing crossed in time
 * `stopped`   single mode, captured and halted
 */
export type TriggerStatus = 'off' | 'armed' | 'triggered' | 'holding' | 'auto' | 'stopped';

export interface TriggerSettings {
  mode: TriggerMode;
  /** The trace whose crossings trigger the display. */
  sourceId: string | null;
  /** In the source signal's own units. */
  level: number;
  slope: TriggerSlope;
  /** Fraction of the window shown before the trigger point, 0…1. */
  position: number;
  /**
   * Noise rejection, in signal units.
   *
   * After firing, the detector re-arms only once the signal has gone this far
   * back past the level. Without it, noise riding on a slow edge crosses the
   * level several times per edge and the display jitters between them.
   */
  hysteresis: number;
}

export const DEFAULT_TRIGGER: TriggerSettings = {
  mode: 'off',
  sourceId: null,
  level: 0,
  slope: 'rising',
  position: 0.5,
  hysteresis: 0,
};

/** Keep this many recent crossings; far more than any window can use. */
const MAX_CROSSINGS = 512;

/**
 * How far back to look the first time a buffer is seen, in seconds.
 *
 * Scanning the whole 240 000-point ring on the first frame would stall it for
 * no benefit: only crossings near the live edge can be displayed.
 */
const INITIAL_LOOKBACK_SECONDS = 60;

export class CrossingDetector {
  private scannedUntil = Number.NEGATIVE_INFINITY;
  private hasPrevious = false;
  private previousTime = 0;
  private previousValue = 0;
  private armed = false;
  /** Oldest first. */
  private crossings: number[] = [];
  private key = '';

  reset(): void {
    this.scannedUntil = Number.NEGATIVE_INFINITY;
    this.hasPrevious = false;
    this.armed = false;
    this.crossings = [];
  }

  /** Every crossing found so far, oldest first. For tests and diagnostics. */
  all(): readonly number[] {
    return this.crossings;
  }

  /**
   * Feed whatever has arrived since the last call.
   *
   * Changing the level, slope or hysteresis invalidates every crossing already
   * found, so it starts over; so does the buffer moving *backwards*, which is
   * what a reset on a new stream epoch looks like from here.
   */
  update(buffer: TraceBuffer, level: number, slope: TriggerSlope, hysteresis: number): void {
    const key = `${level}|${slope}|${hysteresis}`;
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }

    const latest = buffer.latestTime();
    if (latest === null) {
      this.reset();
      return;
    }
    if (latest < this.scannedUntil) this.reset();
    if (this.scannedUntil === Number.NEGATIVE_INFINITY) {
      this.scannedUntil = latest - INITIAL_LOOKBACK_SECONDS;
    }

    const band = Math.max(0, hysteresis);
    this.scannedUntil = buffer.scanAfter(this.scannedUntil, (time, value) => {
      this.feed(time, value, level, slope, band);
    });
  }

  private feed(time: number, value: number, level: number, slope: TriggerSlope, band: number): void {
    if (Number.isFinite(value)) {
      if (slope === 'rising') {
        if (value < level - band) this.armed = true;
        else if (this.armed && value >= level && this.hasPrevious && this.previousValue < level) {
          this.record(this.interpolate(time, value, level));
          this.armed = false;
        }
      } else {
        if (value > level + band) this.armed = true;
        else if (this.armed && value <= level && this.hasPrevious && this.previousValue > level) {
          this.record(this.interpolate(time, value, level));
          this.armed = false;
        }
      }
    }
    this.hasPrevious = Number.isFinite(value);
    this.previousTime = time;
    this.previousValue = value;
  }

  /** Where between the last two samples the level was actually crossed. */
  private interpolate(time: number, value: number, level: number): number {
    const span = value - this.previousValue;
    if (span === 0) return time;
    const fraction = (level - this.previousValue) / span;
    return this.previousTime + Math.min(1, Math.max(0, fraction)) * (time - this.previousTime);
  }

  private record(time: number): void {
    this.crossings.push(time);
    if (this.crossings.length > MAX_CROSSINGS) this.crossings.splice(0, this.crossings.length - MAX_CROSSINGS);
  }

  /**
   * The newest crossing that can be shown *whole*.
   *
   * A crossing is only displayable once the samples after it fill the part of
   * the window to its right, and while the samples before it are still in the
   * ring. Showing a newer, incomplete one would draw a trace that stops short of
   * the right edge and then jumps as the rest arrives.
   */
  latestComplete(latestTime: number, postSeconds: number, notBefore: number): number | null {
    for (let index = this.crossings.length - 1; index >= 0; index -= 1) {
      const time = this.crossings[index] as number;
      if (time < notBefore) return null;
      if (time + postSeconds <= latestTime) return time;
    }
    return null;
  }
}

export interface TriggerView {
  /** Right edge of the window to show, or `null` to free-run. */
  end: number | null;
  status: TriggerStatus;
  /** The crossing on screen, for the marker. */
  triggerTime: number | null;
}

export const FREE_RUNNING: TriggerView = { end: null, status: 'off', triggerTime: null };

/**
 * How long auto mode waits for a crossing before free-running, in data seconds.
 *
 * A fraction longer than one sweep, with a floor: long enough that a slow
 * periodic signal is still caught every cycle, short enough that a signal with
 * nothing to trigger on is still shown rather than an empty plot.
 */
export function autoTimeout(windowSeconds: number): number {
  return Math.max(0.2, windowSeconds * 1.5);
}

/**
 * A crossing older than this is "holding", not "triggered".
 *
 * Normal mode keeps the last capture on screen while it waits; saying
 * "triggered" about a capture from a minute ago would misreport a signal that
 * has stopped.
 */
function staleAfter(windowSeconds: number): number {
  return Math.max(0.5, windowSeconds * 2);
}

export function decideView(input: {
  mode: TriggerMode;
  windowSeconds: number;
  position: number;
  latestTime: number | null;
  /** From {@link CrossingDetector.latestComplete}. */
  crossing: number | null;
}): TriggerView {
  const { mode, windowSeconds, latestTime, crossing } = input;
  if (mode === 'off') return FREE_RUNNING;
  if (latestTime === null) return { end: null, status: 'armed', triggerTime: null };

  const position = Math.min(1, Math.max(0, input.position));
  const post = (1 - position) * windowSeconds;
  const age = crossing === null ? Number.POSITIVE_INFINITY : latestTime - crossing;

  switch (mode) {
    case 'single':
      // The caller arms with `notBefore`, so any crossing here is the capture.
      return crossing === null
        ? { end: null, status: 'armed', triggerTime: null }
        : { end: crossing + post, status: 'stopped', triggerTime: crossing };

    case 'normal':
      if (crossing === null) return { end: null, status: 'armed', triggerTime: null };
      return {
        end: crossing + post,
        status: age - post > staleAfter(windowSeconds) ? 'holding' : 'triggered',
        triggerTime: crossing,
      };

    case 'auto':
      if (crossing === null || age - post > autoTimeout(windowSeconds)) {
        return { end: null, status: 'auto', triggerTime: null };
      }
      return { end: crossing + post, status: 'triggered', triggerTime: crossing };
  }
}
