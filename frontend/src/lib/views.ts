/**
 * Lookups over the component tree, the status badges a row shows, and search.
 *
 * The backend sends the whole tree once; everything here is a pure function of
 * it. How the navigator lays the tree out is `lib/navigator.ts`.
 */

import type { ComponentNode, StatusLevel } from './types';

export function walk(node: ComponentNode, visit: (node: ComponentNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

export function collect(root: ComponentNode, predicate: (node: ComponentNode) => boolean): ComponentNode[] {
  const found: ComponentNode[] = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

export function findNode(root: ComponentNode, id: string): ComponentNode | null {
  let match: ComponentNode | null = null;
  walk(root, (node) => {
    if (!match && node.id === id) match = node;
  });
  return match;
}

/**
 * The name of the channel or function block that owns a signal, or null when
 * its device owns it directly. Signals of the same name on one device, such as
 * the X of an accelerometer and of a gyroscope, differ by it.
 */
/** The id of the channel or function block that owns a signal, or null when its device does. */
export function signalOwnerId(signal: { id: string; deviceId: string | null }): string | null {
  const marker = signal.id.lastIndexOf('/Sig/');
  if (marker < 0) return null;
  const ownerId = signal.id.slice(0, marker);
  return ownerId === signal.deviceId ? null : ownerId;
}

/**
 * Items in the order given, grouped by a key in the order each key first
 * appears: the channels of a device, with the signals of each.
 */
export function groupInOrder<T>(items: readonly T[], keyOf: (item: T) => string | null): { key: string | null; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, items: grouped }));
}

export function signalOwnerName(signal: { id: string; deviceId: string | null }, tree: ComponentNode | null): string | null {
  const marker = signal.id.lastIndexOf('/Sig/');
  if (marker < 0) return null;
  const ownerId = signal.id.slice(0, marker);
  if (ownerId === signal.deviceId) return null;
  const node = tree ? findNode(tree, ownerId) : null;
  return (node ? node.displayName || node.name : ownerId.split('/').pop()) || null;
}

/** Ids from the root down to `id`, so the tree can reveal a selection. */
export function pathTo(root: ComponentNode, id: string): string[] {
  const trail: string[] = [];
  const search = (node: ComponentNode, ancestors: string[]): boolean => {
    if (node.id === id) {
      trail.push(...ancestors);
      return true;
    }
    for (const child of node.children) {
      if (search(child, [...ancestors, node.id])) return true;
    }
    return false;
  };
  search(root, []);
  return trail;
}

// --------------------------------------------------------------------------- badges

export interface NodeBadges {
  level: StatusLevel;
  labels: string[];
}

/**
 * The short state labels shown after a node's name.
 *
 * Matching the SDK demo's vocabulary (`err`, `warn`, `inactive`, `disconnected`,
 * `locked`, `updating`) means an operator sees the same words in both tools.
 */
export function nodeBadges(node: ComponentNode): NodeBadges {
  const labels: string[] = [];
  const level = node.status.level;

  if (level === 'error') labels.push('err');
  else if (level === 'warning') labels.push('warn');

  if (!node.active) labels.push('inactive');
  if (node.device && !node.device.connected) labels.push('disconnected');
  if (node.device?.locked) labels.push('locked');
  if (node.updating) labels.push('updating');
  if (node.functionBlock?.isRecording) labels.push('recording');
  if (!node.visible) labels.push('hidden');

  return { level, labels };
}

// --------------------------------------------------------------------------- search

export interface SearchHit {
  node: ComponentNode;
  score: number;
  /** Which field matched, for the result subtitle. */
  field: 'name' | 'id' | 'description' | 'tag';
}

/**
 * Subsequence match with a bias toward prefixes and word starts.
 *
 * Deliberately simple: component names are short, and an operator typing `ai0`
 * wants `AI0` first, not a fuzzy match buried three devices deep.
 */
export function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 0;
  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();

  const exact = target.indexOf(query);
  if (exact === 0) return 1000 - target.length;
  if (exact > 0) {
    const isWordStart = exact === 0 || /[^a-z0-9]/.test(target[exact - 1] ?? '');
    return (isWordStart ? 700 : 500) - exact - target.length * 0.1;
  }

  // Fall back to an in-order subsequence, rewarding adjacency.
  let score = 0;
  let cursor = 0;
  let previous = -1;
  for (const character of query) {
    const found = target.indexOf(character, cursor);
    if (found === -1) return -1;
    score += previous >= 0 && found === previous + 1 ? 8 : 2;
    previous = found;
    cursor = found + 1;
  }
  return score - target.length * 0.05;
}

export function searchComponents(root: ComponentNode, query: string, limit = 40): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const hits: SearchHit[] = [];

  walk(root, (node) => {
    const candidates: [string, SearchHit['field']][] = [
      [node.name, 'name'],
      [node.id, 'id'],
      [node.description, 'description'],
      ...node.tags.map((tag) => [tag, 'tag'] as [string, SearchHit['field']]),
    ];
    let best: SearchHit | null = null;
    for (const [text, field] of candidates) {
      if (!text) continue;
      const score = fuzzyScore(trimmed, text);
      // Names are what people search for; other fields are a fallback.
      const weighted = field === 'name' ? score * 1.5 : field === 'id' ? score * 0.9 : score * 0.6;
      if (weighted > 0 && (!best || weighted > best.score)) {
        best = { node, score: weighted, field };
      }
    }
    if (best) hits.push(best);
  });

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
