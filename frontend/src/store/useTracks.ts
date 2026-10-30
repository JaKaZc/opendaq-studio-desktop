/**
 * The Signals page: which signals are tracks, in what order, what is selected,
 * and the time window every track shares.
 *
 * Tracks are signal ids; their names and units come from the signal list. A
 * fresh install starts with every device channel as a track. A channel the
 * user removes stays removed, even when the list is filled in again later.
 */

import { create } from 'zustand';
import { loadPreference, savePreference } from '../lib/utils';
import { useNav } from './useNav';
import { useScope } from './useScope';

export type TrackSize = 'compact' | 'normal' | 'large';

export type Selection = { kind: 'track'; id: string } | { kind: 'device'; id: string } | null;

interface TracksState {
  tracks: string[];
  /** Channels the user took off, kept so an automatic fill does not bring them back. */
  removed: string[];
  /** The automatic first fill has happened. */
  seeded: boolean;
  selection: Selection;
  windowSeconds: number;
  /** Paused at this right-hand edge, in epoch seconds; `null` follows live. */
  frozenEnd: number | null;
  size: TrackSize;
  /** The time under the pointer, in epoch seconds, for reading every track at once. */
  cursor: number | null;

  seed(signalIds: string[]): void;
  addTracks(signalIds: string[], after?: string): void;
  removeTrack(signalId: string): void;
  moveTrack(signalId: string, toIndex: number): void;
  select(selection: Selection): void;
  setWindow(seconds: number): void;
  pause(end: number | null): void;
  setSize(size: TrackSize): void;
  setCursor(time: number | null): void;
}

const STORAGE_KEY = 'tracks';
const WINDOWS = [2, 5, 10, 30, 60] as const;

interface Persisted {
  tracks: string[];
  removed: string[];
  seeded: boolean;
  windowSeconds: number;
  size: TrackSize;
}

const stored = loadPreference<Partial<Persisted>>(STORAGE_KEY, {});

function persist(state: TracksState): void {
  savePreference(STORAGE_KEY, {
    tracks: state.tracks,
    removed: state.removed,
    seeded: state.seeded,
    windowSeconds: state.windowSeconds,
    size: state.size,
  } satisfies Persisted);
}

/**
 * Which tracks stream samples. An array track (a spectrum, say) shows its
 * latest array instead and is left out, and so is a remembered track whose
 * device is not connected; the Signals page tells this store which is which
 * once it knows the signals. Until then nothing streams, so a track left from
 * an earlier session is not asked for and refused.
 */
let streams: (signalId: string) => boolean = () => false;

export function setStreamedTracks(predicate: (signalId: string) => boolean): void {
  streams = predicate;
  subscribe(useTracks.getState());
}

function subscribe(state: TracksState): void {
  useScope.getState().setPinned(state.tracks.filter((id) => streams(id)), state.windowSeconds);
}

export const useTracks = create<TracksState>((set, get) => ({
  tracks: stored.tracks ?? [],
  removed: stored.removed ?? [],
  seeded: stored.seeded ?? false,
  selection: null,
  windowSeconds: stored.windowSeconds ?? 10,
  frozenEnd: null,
  size: stored.size ?? 'normal',
  cursor: null,

  seed(signalIds) {
    const state = get();
    if (state.seeded) return;
    set({ tracks: signalIds.filter((id) => !state.removed.includes(id)), seeded: true });
    persist(get());
    subscribe(get());
  },

  addTracks(signalIds, after) {
    const state = get();
    const fresh = signalIds.filter((id) => !state.tracks.includes(id));
    if (!fresh.length) return;
    const tracks = [...state.tracks];
    const at = after ? tracks.indexOf(after) : -1;
    tracks.splice(at >= 0 ? at + 1 : tracks.length, 0, ...fresh);
    set({ tracks, removed: state.removed.filter((id) => !fresh.includes(id)), seeded: true });
    persist(get());
    subscribe(get());
  },

  removeTrack(signalId) {
    const state = get();
    set({
      tracks: state.tracks.filter((id) => id !== signalId),
      removed: [...new Set([...state.removed, signalId])],
      selection: state.selection?.kind === 'track' && state.selection.id === signalId ? null : state.selection,
    });
    persist(get());
    subscribe(get());
  },

  moveTrack(signalId, toIndex) {
    const tracks = get().tracks.filter((id) => id !== signalId);
    tracks.splice(Math.max(0, Math.min(tracks.length, toIndex)), 0, signalId);
    set({ tracks });
    persist(get());
  },

  select(selection) {
    set({ selection });
  },

  setWindow(seconds) {
    set({ windowSeconds: Math.min(300, Math.max(0.5, seconds)) });
    persist(get());
    subscribe(get());
  },

  pause(end) {
    set({ frozenEnd: end });
  },

  setSize(size) {
    set({ size });
    persist(get());
  },

  setCursor(time) {
    if (get().cursor !== time) set({ cursor: time });
  },
}));

/** The next shorter or longer of the usual windows. */
export function stepWindow(current: number, direction: 1 | -1): number {
  if (direction > 0) return WINDOWS.find((value) => value > current + 1e-9) ?? 60;
  return [...WINDOWS].reverse().find((value) => value < current - 1e-9) ?? 2;
}

/** Start streaming the saved tracks as soon as the app loads. */
export function resumeTrackSubscription(): void {
  subscribe(useTracks.getState());
}

/** Show a signal as a selected track on the Signals page, from anywhere. */
export function showAsTrack(signalId: string): void {
  showAsTracks([signalId]);
}

/** Show signals as tracks on the Signals page, the first one selected. */
export function showAsTracks(signalIds: readonly string[]): void {
  const first = signalIds[0];
  if (!first) return;
  const tracks = useTracks.getState();
  tracks.addTracks([...signalIds]);
  tracks.select({ kind: 'track', id: first });
  useNav.getState().go('signals');
}

/** Add a signal to the Scope and open it, from anywhere. */
export function openInScope(signalId: string, label?: string): void {
  useScope.getState().addTrace(signalId, label || signalId.split('/').pop() || signalId);
  useNav.getState().go('scope');
}
