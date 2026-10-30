/**
 * One animation loop for every track and the ruler.
 *
 * Each track registers a painter; on every frame in which samples arrived or
 * the window moved, the loop works out the shared time window once and calls
 * every painter with it. Nothing on this path goes through React.
 */

import { traces } from '../../store/traceStore';
import { useTracks } from '../../store/useTracks';

export interface Palette {
  wave: string;
  selected: string;
  grid: string;
  text: string;
  panel: string;
}

export interface Frame {
  start: number;
  end: number;
  colors: Palette;
}

type Painter = (frame: Frame) => void;

const painters = new Set<Painter>();
let raf = 0;
let lastVersion = -1;
let lastEnd = Number.NaN;
let dirty = true;
let paletteKey = '';
let palette: Palette | null = null;

function readPalette(): Palette {
  const root = document.documentElement;
  const key = `${root.getAttribute('data-theme') ?? ''}:${window.matchMedia('(prefers-color-scheme: dark)').matches}`;
  if (palette && key === paletteKey) return palette;
  const css = getComputedStyle(root);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  paletteKey = key;
  palette = {
    wave: get('--color-text-faint', '#949494'),
    selected: get('--color-accent', '#00335a'),
    grid: get('--color-plot-grid', '#e1e7ee'),
    text: get('--color-text-muted', '#6b6b6b'),
    panel: get('--color-panel', '#ffffff'),
  };
  return palette;
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  const { windowSeconds, frozenEnd } = useTracks.getState();
  const end = frozenEnd ?? traces.latestTime() ?? Date.now() / 1000;
  if (!dirty && traces.dataVersion === lastVersion && end === lastEnd) return;
  lastVersion = traces.dataVersion;
  lastEnd = end;
  dirty = false;
  const frame: Frame = { start: end - windowSeconds, end, colors: readPalette() };
  for (const painter of painters) painter(frame);
}

export function addPainter(painter: Painter): () => void {
  painters.add(painter);
  dirty = true;
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    painters.delete(painter);
    if (painters.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** Redraw on the next frame even without new samples: a selection, a resize, a theme. */
export function invalidate(): void {
  dirty = true;
}

/** The current window, for pointer maths outside a frame. */
export function currentWindow(): { start: number; end: number } {
  const { windowSeconds, frozenEnd } = useTracks.getState();
  const end = Number.isFinite(lastEnd) ? lastEnd : (frozenEnd ?? Date.now() / 1000);
  return { start: end - windowSeconds, end };
}

// Selection, size, cursor and window changes are redraws without new data.
useTracks.subscribe(() => invalidate());
