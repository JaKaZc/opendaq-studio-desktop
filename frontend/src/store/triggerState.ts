/**
 * The trigger's per-frame state, kept outside React.
 *
 * The triggered window can move on every animation frame, so it lives here as a
 * plain object - the same reasoning as the trace buffers in `traceStore.ts`. The
 * canvas writes it once per frame; `visibleWindow()` reads it. Only the coarse
 * status ("armed", "triggered", …) crosses into React, and only when it changes.
 *
 * This module imports nothing from the scope store on purpose: the store reads
 * it, so the reverse import would be a cycle.
 */

import { CrossingDetector, FREE_RUNNING, type TriggerView } from '../lib/trigger';

export const triggerState: {
  detector: CrossingDetector;
  view: TriggerView;
  /** Crossings before this data time are ignored; single mode's arming point. */
  armedAt: number;
  /** The source the detector's crossings belong to. */
  sourceId: string | null;
} = {
  detector: new CrossingDetector(),
  view: FREE_RUNNING,
  armedAt: Number.NEGATIVE_INFINITY,
  sourceId: null,
};

/** Forget every crossing, e.g. when the source trace changes. */
export function resetTrigger(): void {
  triggerState.detector.reset();
  triggerState.view = FREE_RUNNING;
  triggerState.armedAt = Number.NEGATIVE_INFINITY;
}
