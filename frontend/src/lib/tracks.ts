/**
 * The rules behind how a track is drawn, kept pure so each is a test.
 */

export interface Range {
  min: number;
  max: number;
}

/**
 * The vertical range to draw, given the last one and what is in the window now.
 *
 * It grows at once - a peak must never be clipped - and shrinks slowly, so a
 * quiet stretch does not make the trace jump to fill the lane. A flat signal
 * gets a band around its value instead of a zero-height range.
 */
export function nextRange(previous: Range | null, extent: Range | null): Range | null {
  let low = extent?.min ?? null;
  let high = extent?.max ?? null;
  if (low === null || high === null) return previous;
  if (high - low < 1e-12) {
    const pad = Math.max(Math.abs(high) * 0.1, 1e-3);
    low -= pad;
    high += pad;
  }
  const pad = (high - low) * 0.12;
  const target = { min: low - pad, max: high + pad };
  if (!previous) return target;
  const shrink = 0.06;
  return {
    min: target.min < previous.min ? target.min : previous.min + (target.min - previous.min) * shrink,
    max: target.max > previous.max ? target.max : previous.max + (target.max - previous.max) * shrink,
  };
}

/** Round seconds between ruler ticks for a window, aiming at about `target` ticks. */
export function tickStep(seconds: number, target = 6): number {
  const raw = seconds / target;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => step >= raw) ?? 600;
}

/** A ruler label: seconds before the live edge, or a clock time when paused. */
export function tickLabel(secondsBeforeEnd: number, step: number): string {
  if (Math.abs(secondsBeforeEnd) < step / 2) return 'now';
  const value = -secondsBeforeEnd;
  if (step >= 60) return `${Math.round(value / 60)} min`;
  return `${step < 1 ? value.toFixed(1) : Math.round(value)} s`;
}

export interface TrackGroup {
  /** The device id, or `null` for the instance itself. */
  deviceId: string | null;
  tracks: string[];
}

/**
 * Tracks in the order they were added, grouped by device in the order each
 * device first appears. A function block's output sits with the device of the
 * signal its input port reads, so a Statistics block's average of AI0 is under
 * AI0's device.
 * Tracks of the instance itself come last.
 */
export function groupTracks(
  tracks: readonly string[],
  deviceOf: (signalId: string) => string | null,
  sourceOf: (signalId: string) => string | null = () => null,
): TrackGroup[] {
  const resolve = (signalId: string, depth = 0): string | null => {
    const device = deviceOf(signalId);
    if (device !== null || depth > 4) return device;
    const source = sourceOf(signalId);
    return source ? resolve(source, depth + 1) : null;
  };
  const groups = new Map<string | null, string[]>();
  for (const id of tracks) {
    const device = resolve(id);
    groups.set(device, [...(groups.get(device) ?? []), id]);
  }
  return [...groups.entries()]
    .map(([deviceId, list]) => ({ deviceId, tracks: list }))
    .sort((a, b) => Number(a.deviceId === null) - Number(b.deviceId === null));
}

/** A value that is rounding noise next to the channel's range reads as 0, not -4.4e-13. */
export function cleanValue(value: number, span: number): number {
  return span > 0 && Math.abs(value) < span * 1e-9 ? 0 : value;
}
