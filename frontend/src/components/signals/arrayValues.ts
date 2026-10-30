/**
 * The latest value of each array track, such as an FFT block's spectrum.
 *
 * An array signal has one array per sample, so it is not streamed like a
 * number per sample: the track shows the newest array as openDAQ reports it in
 * `last_value`, polled a few times a second. Kept outside React, like the
 * stream buffers, so the shared render loop can read it on every frame.
 */

import { api } from '../../lib/api';
import { invalidate } from './trackLoop';

export interface ArrayReading {
  values: number[];
  /** When the backend read it, in epoch milliseconds on this machine. */
  receivedAt: number;
}

const latest = new Map<string, ArrayReading>();

export function arrayReading(signalId: string): ArrayReading | undefined {
  return latest.get(signalId);
}

/** Read the newest array of every given signal once. */
export async function pollArrays(signalIds: string[], signal?: AbortSignal): Promise<void> {
  if (!signalIds.length) return;
  const response = await api.signals.lastValues(signalIds, undefined, true, signal);
  const now = Date.now();
  for (const entry of response.values) {
    const values = Array.isArray(entry.value) ? entry.value.filter((item): item is number => typeof item === 'number') : null;
    if (values && values.length) latest.set(entry.id, { values, receivedAt: now });
  }
  invalidate();
}

/** The largest value and where it is, for the label beside the track. */
export function peakOf(values: readonly number[]): { index: number; value: number } | null {
  let index = -1;
  let value = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const item = values[i] as number;
    if (Number.isFinite(item) && item > value) {
      value = item;
      index = i;
    }
  }
  return index < 0 ? null : { index, value };
}
