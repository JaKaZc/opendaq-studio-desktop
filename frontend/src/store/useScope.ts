/**
 * Scope configuration: which traces are shown and how.
 *
 * Only settings live here.  Sample data is in {@link traces}, which is not React
 * state - see the note at the top of `traceStore.ts`.
 */

import { create } from 'zustand';
import { realtime } from '../lib/realtime';
import { traceColor, loadPreference, savePreference } from '../lib/utils';
import type { WindowFunction } from '../lib/dsp';
import { DEFAULT_TRIGGER, type TriggerSettings, type TriggerStatus } from '../lib/trigger';
import { traces } from './traceStore';
import { resetTrigger, triggerState } from './triggerState';

export type YAxisMode = 'auto' | 'manual' | 'descriptor';
export type XAxisMode = 'rolling' | 'frozen';

export interface TraceConfig {
  signalId: string;
  name: string;
  color: string;
  visible: boolean;
  /** Vertical offset in signal units, for separating overlaid traces. */
  offset: number;
  /** Vertical gain applied before drawing. */
  scale: number;
}

export interface Cursor {
  /** Absolute epoch seconds. */
  time: number;
  enabled: boolean;
}

export interface ScopeState {
  traces: TraceConfig[];
  /**
   * Signals shown as inline sparklines in the signal list.
   *
   * Kept apart from `traces` so opening a preview does not clutter the scope, but
   * fed by the same subscription and the same trace buffers - the backend sees one
   * subscription set, which is the union of both.
   */
  previews: string[];
  /**
   * Signals the Studio shows as tracks. Part of the same subscription, so a
   * channel on a track and in the Scope costs one reader on the device.
   */
  pinned: string[];
  /** History the Studio wants primed for a newly added track, in seconds. */
  pinnedWindow: number;
  /** Visible window length in seconds. */
  windowSeconds: number;
  /** Rolling follows the live edge; frozen holds `frozenEnd`. */
  xMode: XAxisMode;
  /** Right edge of the window when frozen, in epoch seconds. */
  frozenEnd: number | null;
  paused: boolean;

  yMode: YAxisMode;
  yMin: number;
  yMax: number;
  /** Draw each trace in its own horizontal lane instead of overlaid. */
  stacked: boolean;

  /** Requested resolution in points per second; drives server decimation. */
  pointsPerSecond: number;
  /** Follow the canvas width instead of a fixed rate. */
  autoResolution: boolean;

  showGrid: boolean;
  showLegend: boolean;
  showStatistics: boolean;
  showSpectrum: boolean;

  cursorA: Cursor;
  cursorB: Cursor;

  spectrum: {
    windowFunction: WindowFunction;
    decibels: boolean;
    smoothing: number;
    /** Requested transform length; rounded down to a power of two. */
    size: number;
    logFrequency: boolean;
    /** The latest spectrum as a curve, or its history as a waterfall. */
    view: 'spectrum' | 'waterfall';
  };

  trigger: TriggerSettings;
  /** Coarse state for the toolbar. Written by the render loop, only on change. */
  triggerStatus: TriggerStatus;
}

interface ScopeActions {
  addTrace(signalId: string, name: string): void;
  removeTrace(signalId: string): void;
  setTraces(entries: { signalId: string; name: string }[]): void;
  updateTrace(signalId: string, patch: Partial<TraceConfig>): void;
  clearTraces(): void;
  togglePreview(signalId: string): void;
  clearPreviews(): void;
  setPinned(signalIds: string[], windowSeconds: number): void;

  setWindowSeconds(seconds: number): void;
  setPaused(paused: boolean): void;
  freezeAt(end: number | null): void;
  panBy(seconds: number): void;
  zoomBy(factor: number, anchor?: number): void;
  resetView(): void;
  /**
   * Back to the newest samples: resume, follow the live edge, fit the vertical
   * scale, and leave a held trigger capture for free-running.
   */
  goLive(): void;
  /**
   * Ask the backend for the Scope's signals again from scratch, for a stream
   * that stopped delivering (a device that was reconfigured or restarted).
   */
  restartStream(): void;

  setYMode(mode: YAxisMode): void;
  setYRange(min: number, max: number): void;
  toggle(key: 'showGrid' | 'showLegend' | 'showStatistics' | 'showSpectrum' | 'stacked'): void;

  setPointsPerSecond(value: number): void;
  setAutoResolution(value: boolean): void;
  /** Tell the backend the resolution implied by the current canvas width. */
  syncResolution(canvasWidth: number): void;

  setCursor(which: 'A' | 'B', patch: Partial<Cursor>): void;
  setSpectrum(patch: Partial<ScopeState['spectrum']>): void;

  setTrigger(patch: Partial<TriggerSettings>): void;
  /** Start waiting for a fresh crossing; resumes acquisition after a single capture. */
  armTrigger(): void;
  /** Single mode fired: hold the captured window and stop acquiring. */
  captureSingle(end: number): void;
  setTriggerStatus(status: TriggerStatus): void;
}

/** Window presets, from a single cycle of a fast signal to a minute of trend. */
export const WINDOW_PRESETS = [0.001, 0.005, 0.02, 0.1, 0.5, 1, 2, 5, 10, 30, 60] as const;

const STORAGE_KEY = 'scope';

const DEFAULTS: ScopeState = {
  traces: [],
  previews: [],
  pinned: [],
  pinnedWindow: 10,
  windowSeconds: 0.5,
  xMode: 'rolling',
  frozenEnd: null,
  paused: false,
  yMode: 'auto',
  yMin: -1,
  yMax: 1,
  stacked: false,
  pointsPerSecond: 4000,
  autoResolution: true,
  showGrid: true,
  showLegend: true,
  showStatistics: true,
  showSpectrum: false,
  cursorA: { time: 0, enabled: false },
  cursorB: { time: 0, enabled: false },
  spectrum: {
    windowFunction: 'hann',
    decibels: true,
    smoothing: 0.3,
    size: 4096,
    logFrequency: false,
    view: 'spectrum',
  },
  trigger: DEFAULT_TRIGGER,
  triggerStatus: 'off',
};

/** Only the parts worth remembering across reloads; trace lists are session data. */
function restore(): ScopeState {
  const stored = loadPreference<Partial<ScopeState>>(STORAGE_KEY, {});
  return {
    ...DEFAULTS,
    ...stored,
    // Never restore traces or transport state: the instance may have changed.
    traces: [],
    previews: [],
    paused: false,
    xMode: 'rolling',
    frozenEnd: null,
    cursorA: { ...DEFAULTS.cursorA },
    cursorB: { ...DEFAULTS.cursorB },
    spectrum: { ...DEFAULTS.spectrum, ...(stored.spectrum ?? {}) },
    // The shape of a trigger is remembered; whether it is on, and on which
    // signal, is not. A scope that reopens already in single mode sits paused
    // and looks broken, and the source may not exist in this instance.
    trigger: {
      ...DEFAULT_TRIGGER,
      slope: stored.trigger?.slope ?? DEFAULT_TRIGGER.slope,
      position: stored.trigger?.position ?? DEFAULT_TRIGGER.position,
      hysteresis: stored.trigger?.hysteresis ?? DEFAULT_TRIGGER.hysteresis,
    },
    triggerStatus: 'off',
  };
}

export const useScope = create<ScopeState & ScopeActions>((set, get) => ({
  ...restore(),

  addTrace(signalId, name) {
    const existing = get().traces;
    if (existing.some((trace) => trace.signalId === signalId)) return;
    const next = [
      ...existing,
      { signalId, name, color: traceColor(existing.length), visible: true, offset: 0, scale: 1 },
    ];
    set({ traces: next });
    applySubscription(get());
  },

  removeTrace(signalId) {
    if (get().trigger.sourceId === signalId) get().setTrigger({ sourceId: null });
    const next = get().traces.filter((trace) => trace.signalId !== signalId);
    // Recolour so the palette stays in order after a removal.
    const recoloured = next.map((trace, index) => ({ ...trace, color: traceColor(index) }));
    set({ traces: recoloured });
    // The buffer is dropped by applySubscription's retain() unless the signal is
    // still needed as an inline preview, so it is not removed explicitly here.
    applySubscription(get());
  },

  setTraces(entries) {
    const next = entries.map((entry, index) => {
      const previous = get().traces.find((trace) => trace.signalId === entry.signalId);
      return (
        previous ?? {
          signalId: entry.signalId,
          name: entry.name,
          color: traceColor(index),
          visible: true,
          offset: 0,
          scale: 1,
        }
      );
    });
    set({ traces: next });
    applySubscription(get());
  },

  updateTrace(signalId, patch) {
    set({
      traces: get().traces.map((trace) => (trace.signalId === signalId ? { ...trace, ...patch } : trace)),
    });
  },

  clearTraces() {
    if (get().trigger.sourceId !== null) get().setTrigger({ sourceId: null });
    set({ traces: [] });
    applySubscription(get());
  },

  togglePreview(signalId) {
    const current = get().previews;
    const next = current.includes(signalId)
      ? current.filter((id) => id !== signalId)
      : [...current, signalId];
    set({ previews: next });
    applySubscription(get());
  },

  clearPreviews() {
    set({ previews: [] });
    applySubscription(get());
  },

  setPinned(signalIds, windowSeconds) {
    const current = get();
    if (current.pinned.length === signalIds.length && current.pinned.every((id, index) => id === signalIds[index]) && current.pinnedWindow === windowSeconds) {
      return;
    }
    set({ pinned: [...signalIds], pinnedWindow: windowSeconds });
    applySubscription(get());
  },

  setWindowSeconds(seconds) {
    const clamped = Math.min(600, Math.max(0.0002, seconds));
    set({ windowSeconds: clamped });
    persist(get());
    // A longer window needs fewer points per second for the same pixel density.
    if (get().autoResolution) get().syncResolution(lastCanvasWidth);
  },

  setPaused(paused) {
    set({ paused });
    // Pausing stops the server sending, which also stops the buffer advancing -
    // so the frozen view stays exactly where it was.
    realtime.setPaused(paused);
    if (paused) {
      const latest = liveEdge(get());
      set({ xMode: 'frozen', frozenEnd: latest ?? get().frozenEnd });
    } else {
      set({ xMode: 'rolling', frozenEnd: null });
    }
  },

  freezeAt(end) {
    if (end === null) set({ xMode: 'rolling', frozenEnd: null });
    else set({ xMode: 'frozen', frozenEnd: end });
  },

  panBy(seconds) {
    const state = get();
    const anchor = state.frozenEnd ?? liveEdge(state) ?? 0;
    set({ xMode: 'frozen', frozenEnd: anchor + seconds });
  },

  zoomBy(factor, anchor) {
    const state = get();
    const end = state.frozenEnd ?? liveEdge(state) ?? 0;
    const nextWindow = Math.min(600, Math.max(0.0002, state.windowSeconds * factor));
    if (anchor !== undefined && state.xMode === 'frozen') {
      // Keep the anchor time under the pointer as the window scales.
      const fraction = (end - anchor) / state.windowSeconds;
      set({ windowSeconds: nextWindow, frozenEnd: anchor + fraction * nextWindow });
    } else {
      set({ windowSeconds: nextWindow });
    }
    persist(get());
    if (get().autoResolution) get().syncResolution(lastCanvasWidth);
  },

  resetView() {
    set({ xMode: 'rolling', frozenEnd: null, yMode: 'auto' });
  },

  goLive() {
    const state = get();
    if (state.paused) state.setPaused(false);
    if (state.trigger.mode !== 'off' && (state.triggerStatus === 'stopped' || state.triggerStatus === 'holding')) {
      state.setTrigger({ mode: 'off' });
    }
    set({ xMode: 'rolling', frozenEnd: null, yMode: 'auto' });
  },

  restartStream() {
    const state = get();
    for (const trace of state.traces) traces.reset(trace.signalId);
    // A fresh subscribe makes the backend start each stream over, with history.
    applySubscription(state);
    if (state.paused) state.setPaused(false);
    set({ xMode: 'rolling', frozenEnd: null });
  },

  setYMode(mode) {
    set({ yMode: mode });
    persist(get());
  },

  setYRange(min, max) {
    if (!(max > min)) return;
    set({ yMode: 'manual', yMin: min, yMax: max });
    persist(get());
  },

  toggle(key) {
    set({ [key]: !get()[key] } as Partial<ScopeState>);
    persist(get());
  },

  setPointsPerSecond(value) {
    const clamped = Math.min(1_000_000, Math.max(10, Math.round(value)));
    set({ pointsPerSecond: clamped, autoResolution: false });
    realtime.setResolution(clamped);
    persist(get());
  },

  setAutoResolution(value) {
    set({ autoResolution: value });
    persist(get());
    if (value) get().syncResolution(lastCanvasWidth);
  },

  syncResolution(canvasWidth) {
    lastCanvasWidth = Math.max(200, canvasWidth || lastCanvasWidth);
    const state = get();
    if (!state.autoResolution) return;
    // Two points per pixel: enough for min/max banding to look continuous
    // without asking for samples no one can see.
    const wanted = Math.round((lastCanvasWidth * 2) / Math.max(0.0002, state.windowSeconds));
    const clamped = Math.min(1_000_000, Math.max(50, wanted));
    if (Math.abs(clamped - state.pointsPerSecond) / Math.max(1, state.pointsPerSecond) < 0.15) return;
    set({ pointsPerSecond: clamped });
    realtime.setResolution(clamped);
  },

  setCursor(which, patch) {
    const key = which === 'A' ? 'cursorA' : 'cursorB';
    set({ [key]: { ...get()[key], ...patch } } as Partial<ScopeState>);
  },

  setSpectrum(patch) {
    set({ spectrum: { ...get().spectrum, ...patch } });
    persist(get());
  },

  setTrigger(patch) {
    const previous = get().trigger;
    const next = { ...previous, ...patch };
    const sourceChanged = next.sourceId !== previous.sourceId;
    const modeChanged = next.mode !== previous.mode;

    // Crossings belong to one source, and a mode change is a fresh start.
    if (sourceChanged || modeChanged) resetTrigger();

    // Leaving a single capture: it paused acquisition, so give it back.
    const wasCaptured = previous.mode === 'single' && get().triggerStatus === 'stopped';

    set({ trigger: next, ...(modeChanged ? { triggerStatus: next.mode === 'off' ? 'off' : 'armed' } : {}) });
    persist(get());

    if (modeChanged && wasCaptured) get().setPaused(false);
    if (next.mode === 'single' && (modeChanged || sourceChanged)) get().armTrigger();
  },

  armTrigger() {
    resetTrigger();
    // Only a crossing that happens *after* this counts; otherwise single mode
    // would capture something already on screen the instant it is armed.
    triggerState.armedAt = liveEdge(get()) ?? Number.NEGATIVE_INFINITY;
    set({ triggerStatus: 'armed' });
    if (get().paused) get().setPaused(false);
  },

  captureSingle(end) {
    set({ paused: true, xMode: 'frozen', frozenEnd: end, triggerStatus: 'stopped' });
    realtime.setPaused(true);
  },

  setTriggerStatus(status) {
    if (get().triggerStatus !== status) set({ triggerStatus: status });
  },
}));

let lastCanvasWidth = 900;

/**
 * Push the subscription set to the backend.
 *
 * The set is the union of the Scope's traces and the tracks on the Signals page
 * (`pinned`), so a signal shown in both places costs one reader on the device,
 * not two.
 */
function applySubscription(state: ScopeState): void {
  const wanted = [...new Set([...state.traces.map((trace) => trace.signalId), ...state.previews, ...state.pinned])];
  traces.retain(wanted);
  // Priming with one window of history means a newly added trace is not blank.
  const window = Math.max(state.windowSeconds, state.pinned.length ? state.pinnedWindow : 0);
  realtime.subscribe(wanted, state.pointsPerSecond, Math.min(30, Math.max(0.2, window)));
}

function persist(state: ScopeState): void {
  savePreference(STORAGE_KEY, {
    windowSeconds: state.windowSeconds,
    yMode: state.yMode,
    yMin: state.yMin,
    yMax: state.yMax,
    stacked: state.stacked,
    pointsPerSecond: state.pointsPerSecond,
    autoResolution: state.autoResolution,
    showGrid: state.showGrid,
    showLegend: state.showLegend,
    showStatistics: state.showStatistics,
    showSpectrum: state.showSpectrum,
    spectrum: state.spectrum,
    trigger: {
      slope: state.trigger.slope,
      position: state.trigger.position,
      hysteresis: state.trigger.hysteresis,
    },
  });
}

/**
 * The window currently on screen, in absolute epoch seconds.
 *
 * In order of precedence: a window the user froze or panned to; the window a
 * trigger pinned; otherwise the live edge, so the trace appears pinned to the
 * right. Frozen wins over triggered so that panning around a capture works the
 * way it does everywhere else, and a double-click returns to the trigger.
 */
/**
 * The newest sample among the Scope's own visible traces. Other signals stream
 * for the Signals page and may be ahead of them, which at a millisecond window
 * would leave the Scope showing a stretch its traces have not reached.
 */
export function liveEdge(state: Pick<ScopeState, 'traces'>): number | null {
  const shown = state.traces.filter((trace) => trace.visible).map((trace) => trace.signalId);
  return (shown.length ? traces.latestTimeOf(shown) : null) ?? traces.latestTime();
}

export function visibleWindow(state: ScopeState): { start: number; end: number } {
  let end: number;
  if (state.xMode === 'frozen' && state.frozenEnd !== null) end = state.frozenEnd;
  else if (state.trigger.mode !== 'off' && triggerState.view.end !== null) end = triggerState.view.end;
  else end = liveEdge(state) ?? 0;
  return { start: end - state.windowSeconds, end };
}
