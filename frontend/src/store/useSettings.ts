/**
 * User preferences, persisted to localStorage.
 *
 * Kept separate from session state so that reconnecting, reloading or pointing
 * the viewer at a different instance never loses the way someone set up their
 * workspace.
 */

import { create } from 'zustand';
import { loadPreference, savePreference } from '../lib/utils';
import type { NavFilter } from '../lib/navigator';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface Settings {
  theme: ThemeChoice;
  /** Show components and properties the SDK marks as hidden. */
  includeHidden: boolean;
  /** Poll interval for last-value columns, in ms. 0 disables polling. */
  lastValueInterval: number;
  /** Extra metadata columns in the property grid, by field key. */
  metadataColumns: string[];
  /** Which kinds of component the navigator lists. */
  navFilter: NavFilter;
  /** Show the SDK's complete component tree, storage folders and all. */
  navCompleteTree: boolean;
  /** Navigator width in pixels. */
  sidebarWidth: number;
  /** Detail-panel split: fraction of width given to properties. */
  propertySplit: number;
  /** Confirm before destructive actions (remove device, clear properties). */
  confirmDestructive: boolean;
  /** Show the event log drawer. */
  eventLogOpen: boolean;
  /**
   * Properties as grouped cards - the default - or as the classic table, which
   * is the only view with metadata columns.
   */
  propertyView: 'cards' | 'table';
}

const DEFAULTS: Settings = {
  theme: 'light',
  includeHidden: false,
  lastValueInterval: 500,
  metadataColumns: [],
  navFilter: 'all',
  navCompleteTree: false,
  sidebarWidth: 340,
  propertySplit: 0.55,
  confirmDestructive: true,
  eventLogOpen: false,
  propertyView: 'cards',
};

const STORAGE_KEY = 'settings';

/**
 * The navigator width shipped before the Topology view moved into the tab strip.
 *
 * A stored width equal to it was never chosen by anyone - it is the old default
 * written back on the first preference save - so it is dropped rather than
 * carried forward, which would leave the tabs wrapping onto a second row for
 * every existing install.  A width the user actually dragged to is kept.
 */
const LEGACY_SIDEBAR_WIDTH = 320;
const TABBED_SIDEBAR_WIDTH = 430;

/**
 * Bumped when a stored setting must be reinterpreted.
 *
 * Version 2 made the light theme the default. Every earlier install has
 * `theme: 'system'` stored because the old default was written back on the
 * first save, so that value is not a choice anyone made and becomes light.
 */
const SETTINGS_VERSION = 2;

function restore(): Settings {
  const stored = loadPreference<Partial<Settings> & { version?: number }>(STORAGE_KEY, {});
  if ((stored.version ?? 1) < 2 && stored.theme === 'system') stored.theme = 'light';
  delete stored.version;
  if (stored.sidebarWidth === LEGACY_SIDEBAR_WIDTH) delete stored.sidebarWidth;
  // The tabbed navigator's default: wide enough for five tabs, which the chips
  // do not need. A width someone dragged to is kept.
  if (stored.sidebarWidth === TABBED_SIDEBAR_WIDTH) delete stored.sidebarWidth;
  delete (stored as Record<string, unknown>).treeView;
  // Merge field by field so a preference file written by an older build keeps
  // working when new settings are added.
  return { ...DEFAULTS, ...stored };
}

interface SettingsStore extends Settings {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  toggle(
    key: 'includeHidden' | 'confirmDestructive' | 'eventLogOpen' | 'navCompleteTree',
  ): void;
  setMetadataColumns(columns: string[]): void;
  reset(): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...restore(),

  set(key, value) {
    set({ [key]: value } as Partial<Settings>);
    persist(get());
  },

  toggle(key) {
    set({ [key]: !get()[key] } as Partial<Settings>);
    persist(get());
  },

  setMetadataColumns(columns) {
    set({ metadataColumns: columns });
    persist(get());
  },

  reset() {
    set({ ...DEFAULTS });
    persist(get());
  },
}));

function persist(state: Settings): void {
  const snapshot: Settings & { version: number } = {
    version: SETTINGS_VERSION,
    theme: state.theme,
    includeHidden: state.includeHidden,
    lastValueInterval: state.lastValueInterval,
    metadataColumns: state.metadataColumns,
    navFilter: state.navFilter,
    navCompleteTree: state.navCompleteTree,
    sidebarWidth: state.sidebarWidth,
    propertySplit: state.propertySplit,
    confirmDestructive: state.confirmDestructive,
    eventLogOpen: state.eventLogOpen,
    propertyView: state.propertyView,
  };
  savePreference(STORAGE_KEY, snapshot);
}

/**
 * Apply the theme to `<html data-theme>`.
 *
 * "system" removes the attribute so the CSS `prefers-color-scheme` block takes
 * over, which is why the stylesheet declares the dark palette twice.
 */
export function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}

/** Resolve "system" to what is actually being displayed right now. */
export function effectiveTheme(theme: ThemeChoice): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
