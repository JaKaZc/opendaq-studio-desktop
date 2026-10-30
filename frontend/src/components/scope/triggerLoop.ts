import { decideView, FREE_RUNNING, type TriggerView } from '../../lib/trigger';
import { traces } from '../../store/traceStore';
import { triggerState } from '../../store/triggerState';
import { useScope } from '../../store/useScope';

function sameView(a: TriggerView, b: TriggerView): boolean {
  return a.end === b.end && a.status === b.status && a.triggerTime === b.triggerTime;
}

/**
 * Advance the trigger by whatever arrived since the last frame.
 *
 * Called from the scope canvas's render loop before it draws, so the window it
 * draws is always the one this frame's data implies. Returns `true` when the
 * triggered window moved, which the loop treats as a reason to repaint even if
 * no configuration changed.
 */
export function evaluateTrigger(): boolean {
  const state = useScope.getState();
  const settings = state.trigger;

  if (settings.mode === 'off') {
    if (sameView(triggerState.view, FREE_RUNNING)) return false;
    triggerState.view = FREE_RUNNING;
    return true;
  }

  // A single capture holds its window until re-armed; a pause holds whatever is
  // on screen. Neither should be moved by the detector.
  if (state.triggerStatus === 'stopped' || state.paused) return false;

  const source = settings.sourceId ? traces.get(settings.sourceId) : undefined;
  if (!source) {
    const waiting: TriggerView = { end: null, status: 'armed', triggerTime: null };
    const moved = !sameView(triggerState.view, waiting);
    triggerState.view = waiting;
    state.setTriggerStatus('armed');
    return moved;
  }

  triggerState.detector.update(source.buffer, settings.level, settings.slope, settings.hysteresis);

  const latest = source.buffer.latestTime();
  const span = source.buffer.timeSpan();
  const position = Math.min(1, Math.max(0, settings.position));
  const pre = position * state.windowSeconds;
  const post = (1 - position) * state.windowSeconds;
  // The whole window around a crossing must still be in the ring to be drawn:
  // a crossing whose lead-in has been overwritten would show half a trace.
  const notBefore = Math.max(triggerState.armedAt, (span?.start ?? Number.NEGATIVE_INFINITY) + pre);
  const crossing = latest === null ? null : triggerState.detector.latestComplete(latest, post, notBefore);

  const view = decideView({
    mode: settings.mode,
    windowSeconds: state.windowSeconds,
    position,
    latestTime: latest,
    crossing,
  });

  const moved = !sameView(triggerState.view, view);
  triggerState.view = view;
  state.setTriggerStatus(view.status);
  if (view.status === 'stopped' && view.end !== null) state.captureSingle(view.end);
  return moved;
}
