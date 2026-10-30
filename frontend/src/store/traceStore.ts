/**
 * Live sample storage, deliberately outside React.
 *
 * Sample frames arrive around 20 times a second.  Putting them through a store
 * that re-renders components would repaint the whole app at that rate for data
 * only the canvas actually reads.  Instead the buffers live here as plain
 * objects, the canvas pulls from them inside `requestAnimationFrame`, and React
 * is notified only when something *structural* changes - a new signal, new
 * descriptor metadata, or a buffer reset.
 */

import type { DecodedBlock } from '../lib/frames';
import { TraceBuffer } from '../lib/trace';
import type { StreamMetaWire } from '../lib/types';

export interface TraceState {
  signalId: string;
  buffer: TraceBuffer;
  meta: StreamMetaWire | null;
  /** How the newest samples arrived. `minmax` means no uniform sample grid. */
  mode: 'raw' | 'minmax' | 'none';
  /** Server-side continuity epoch; a change means the buffer was cleared. */
  epoch: number;
  /** Seconds between samples as last reported, for FFT and cursor tolerance. */
  sampleInterval: number;
  /** Total samples ever ingested for this trace. */
  received: number;
  lastFrameAt: number;
  ended: boolean;
}

type Listener = () => void;

class TraceStore {
  private readonly traces = new Map<string, TraceState>();
  private readonly listeners = new Set<Listener>();
  /** Incremented whenever samples land; the canvas uses it to skip idle repaints. */
  dataVersion = 0;
  /** Incremented when the set of traces or their metadata changes. */
  structureVersion = 0;

  readonly stats = { blocks: 0, samples: 0, resets: 0 };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.structureVersion += 1;
    for (const listener of this.listeners) listener();
  }

  get(signalId: string): TraceState | undefined {
    return this.traces.get(signalId);
  }

  buffer(signalId: string): TraceBuffer | undefined {
    return this.traces.get(signalId)?.buffer;
  }

  meta(signalId: string): StreamMetaWire | null {
    return this.traces.get(signalId)?.meta ?? null;
  }

  has(signalId: string): boolean {
    return this.traces.has(signalId);
  }

  list(): TraceState[] {
    return [...this.traces.values()];
  }

  ensure(signalId: string): TraceState {
    let trace = this.traces.get(signalId);
    if (!trace) {
      trace = {
        signalId,
        buffer: new TraceBuffer(),
        meta: null,
        mode: 'none',
        epoch: -1,
        sampleInterval: 0,
        received: 0,
        lastFrameAt: 0,
        ended: false,
      };
      this.traces.set(signalId, trace);
      this.emit();
    }
    return trace;
  }

  /** Keep only these signals; anything else is dropped along with its memory. */
  retain(signalIds: readonly string[]): void {
    const keep = new Set(signalIds);
    let changed = false;
    for (const signalId of [...this.traces.keys()]) {
      if (!keep.has(signalId)) {
        this.traces.delete(signalId);
        changed = true;
      }
    }
    for (const signalId of keep) {
      if (!this.traces.has(signalId)) {
        this.ensure(signalId);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  remove(signalId: string): void {
    if (this.traces.delete(signalId)) this.emit();
  }

  clear(): void {
    if (this.traces.size === 0) return;
    this.traces.clear();
    this.emit();
  }

  /** Drop buffered samples but keep the trace and its metadata. */
  reset(signalId?: string): void {
    if (signalId) {
      const trace = this.traces.get(signalId);
      if (trace) {
        trace.buffer.clear();
        trace.received = 0;
      }
    } else {
      for (const trace of this.traces.values()) {
        trace.buffer.clear();
        trace.received = 0;
      }
    }
    this.dataVersion += 1;
  }

  /** Attach descriptor metadata from a `subscribed` reply. */
  applyMeta(metas: readonly StreamMetaWire[]): void {
    for (const meta of metas) {
      const trace = this.ensure(meta.signalId);
      trace.meta = meta;
      if (meta.sampleRate && meta.sampleRate > 0) {
        trace.sampleInterval = 1 / meta.sampleRate;
      }
    }
    if (metas.length > 0) this.emit();
  }

  /** Route decoded sample blocks into their buffers. */
  ingest(blocks: readonly DecodedBlock[]): void {
    let structuralChange = false;

    for (const { block, values } of blocks) {
      const trace = this.ensure(block.signalId);
      this.stats.blocks += 1;

      if (block.reset || block.epoch !== trace.epoch) {
        // The server says these samples do not continue what we already hold.
        trace.buffer.clear();
        trace.epoch = block.epoch;
        trace.received = 0;
        this.stats.resets += 1;
        structuralChange = true;
      }

      if (block.ended && !trace.ended) {
        trace.ended = true;
        structuralChange = true;
      }

      trace.lastFrameAt = Date.now();

      if (block.mode === 'reset' || values.length === 0) continue;

      if (block.mode === 'raw') {
        const interval = block.sampleInterval ?? trace.sampleInterval;
        if (!(interval > 0) || block.startTime === undefined) continue;
        trace.buffer.appendRaw(block.startTime, interval, values);
        if (trace.mode !== 'raw') {
          trace.mode = 'raw';
          structuralChange = true;
        }
        trace.sampleInterval = interval;
        trace.received += values.length;
        this.stats.samples += values.length;
      } else {
        const bucket = block.bucketSeconds ?? 0;
        if (!(bucket > 0) || block.startTime === undefined) continue;
        trace.buffer.appendMinMax(block.startTime, bucket, values);
        if (trace.mode !== 'minmax') {
          trace.mode = 'minmax';
          structuralChange = true;
        }
        // In decimated mode the "interval" is a bucket, which is what the cursor
        // tolerance should use.
        trace.sampleInterval = bucket;
        trace.received += values.length >> 1;
        this.stats.samples += values.length;
      }
    }

    this.dataVersion += 1;
    if (structuralChange) this.emit();
  }

  /** Newest timestamp across all traces, i.e. the live edge of the display. */
  latestTime(): number | null {
    let latest: number | null = null;
    for (const trace of this.traces.values()) {
      const time = trace.buffer.latestTime();
      if (time !== null && (latest === null || time > latest)) latest = time;
    }
    return latest;
  }

  /**
   * Newest timestamp among some traces only. A view that shows a few signals
   * takes its live edge from them, not from every signal streaming: a 1 MHz
   * signal arrives tens of milliseconds behind a 1 kHz one, which is the whole
   * window when the Scope is zoomed to a millisecond.
   */
  latestTimeOf(signalIds: readonly string[]): number | null {
    let latest: number | null = null;
    for (const id of signalIds) {
      const time = this.traces.get(id)?.buffer.latestTime() ?? null;
      if (time !== null && (latest === null || time > latest)) latest = time;
    }
    return latest;
  }

  /** Oldest timestamp still buffered, i.e. how far back the user can scroll. */
  earliestTime(): number | null {
    let earliest: number | null = null;
    for (const trace of this.traces.values()) {
      const span = trace.buffer.timeSpan();
      if (span && (earliest === null || span.start < earliest)) earliest = span.start;
    }
    return earliest;
  }
}

/** One store per tab. */
export const traces = new TraceStore();
