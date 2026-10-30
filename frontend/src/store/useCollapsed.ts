/**
 * Which groups of signals are collapsed, on the Signals page, in its Tracks
 * list and in the Scope's list. Kept in this browser, so a layout stays as it
 * was left; it is a convenience, and starts expanded where it cannot be kept.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'opendaq-studio.collapsed';

function load(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

interface CollapsedState {
  collapsed: Set<string>;
  toggle(key: string): void;
  /** Collapses or expands every one of the groups. */
  setAll(keys: readonly string[], collapsed: boolean): void;
}

function save(collapsed: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Kept for this session only.
  }
}

export const useCollapsed = create<CollapsedState>((set, get) => ({
  collapsed: load(),
  toggle(key) {
    const next = new Set(get().collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ collapsed: next });
    save(next);
  },
  setAll(keys, collapsed) {
    const next = new Set(get().collapsed);
    for (const key of keys) {
      if (collapsed) next.add(key);
      else next.delete(key);
    }
    set({ collapsed: next });
    save(next);
  },
}));
