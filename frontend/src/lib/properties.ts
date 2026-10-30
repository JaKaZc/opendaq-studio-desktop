/**
 * Decisions the property inspector makes about a property, kept pure so each is
 * a test rather than something to check by clicking through a device.
 */

import type { DaqValue, PropertyNode } from './types';

// --------------------------------------------------------------------------- changed

/** Structural equality for the values the API returns, with float tolerance. */
export function sameValue(a: DaqValue | undefined, b: DaqValue | undefined): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true;
    // Values round-trip through float64 on both sides; a relative epsilon stops
    // 0.1 + 0.2 style noise from lighting up "changed" on an untouched property.
    return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index] as DaqValue));
  }
  const left = a as Record<string, DaqValue>;
  const right = b as Record<string, DaqValue>;
  // An enumeration is its enumerator name; its type metadata is not the value.
  if (left.kind === 'enumeration' && right.kind === 'enumeration') return left.name === right.name;
  if (left.kind === 'struct' && right.kind === 'struct') return sameValue(left.fields, right.fields);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

/**
 * Whether someone has changed this property from its declared default.
 *
 * Only for properties a person can change: a read-only value that differs from
 * its default was set by the device, and marking it would invite a reset that
 * cannot happen. Selection properties are compared by *key* - their `value` is
 * the option's label, while the default is the key.
 */
export function isChangedFromDefault(node: PropertyNode): boolean {
  if (node.readOnly) return false;
  if (['func', 'proc', 'object', 'undefined'].includes(node.valueType)) return false;
  if (node.defaultValue === null || node.defaultValue === undefined) return false;
  const current = node.selectionValues && node.selectionValues.length > 0 ? node.selectionKey : node.value;
  return !sameValue(current, node.defaultValue);
}

/** The default written the way the property shows its value, for a tooltip. */
export function describeDefault(node: PropertyNode): string {
  if (node.selectionValues && node.selectionValues.length > 0) {
    const option = node.selectionValues.find((entry) => sameValue(entry.key, node.defaultValue));
    if (option) return option.label;
  }
  const value = node.defaultValue;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const record = value as Record<string, DaqValue>;
    if (record.kind === 'enumeration') return String(record.name);
    return JSON.stringify(record.fields ?? record);
  }
  return String(value);
}

// --------------------------------------------------------------------------- controls

/**
 * Whether a selection is short enough to show as buttons.
 *
 * Every option visible at once, one click to change - but only while the set
 * fits on a line; past that a dropdown is the kinder control.
 */
export function segmentable(node: PropertyNode): boolean {
  const options = node.selectionValues;
  if (!options || options.length < 2 || options.length > 5) return false;
  const total = options.reduce((sum, option) => sum + option.label.length, 0);
  return options.every((option) => option.label.length <= 12) && total <= 40;
}

export interface SliderScale {
  kind: 'linear' | 'log';
  min: number;
  max: number;
  /** Slider position 0…1000 for a value, and back. */
  toPosition(value: number): number;
  toValue(position: number): number;
}

export const SLIDER_STEPS = 1000;

/**
 * A slider for a bounded number, or `null` when one would not help.
 *
 * Needs both limits - a slider with an open end has nowhere to put the thumb.
 * A range spanning two decades or more is logarithmic, so 1 Hz and 10 Hz are as
 * far apart as 1 kHz and 10 kHz rather than squashed into the first pixel.
 * Integers snap to whole numbers.
 */
export function sliderScale(node: PropertyNode): SliderScale | null {
  if (node.readOnly || (node.valueType !== 'int' && node.valueType !== 'float')) return null;
  const { minValue: min, maxValue: max } = node;
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
  const integer = node.valueType === 'int';
  const snap = (value: number) => {
    const clamped = Math.min(max, Math.max(min, value));
    return integer ? Math.round(clamped) : Number(clamped.toPrecision(4));
  };

  if (min > 0 && max / min >= 100) {
    const low = Math.log10(min);
    const span = Math.log10(max) - low;
    return {
      kind: 'log',
      min,
      max,
      toPosition: (value) => (Math.round(((Math.log10(Math.max(min, Math.min(max, value))) - low) / span) * SLIDER_STEPS)),
      toValue: (position) => snap(10 ** (low + (position / SLIDER_STEPS) * span)),
    };
  }
  return {
    kind: 'linear',
    min,
    max,
    toPosition: (value) => Math.round(((Math.min(max, Math.max(min, value)) - min) / (max - min)) * SLIDER_STEPS),
    toValue: (position) => snap(min + (position / SLIDER_STEPS) * (max - min)),
  };
}

// --------------------------------------------------------------------------- grouping

export interface PropertyGroups {
  /** Top-level properties that are not objects: the "General" card. */
  general: PropertyNode[];
  /** Top-level object properties, each its own card. */
  sections: PropertyNode[];
}

export function groupProperties(nodes: readonly PropertyNode[]): PropertyGroups {
  const general: PropertyNode[] = [];
  const sections: PropertyNode[] = [];
  for (const node of nodes) {
    if (node.valueType === 'object' && (node.children?.length ?? 0) > 0) sections.push(node);
    else general.push(node);
  }
  return { general, sections };
}

/**
 * Keep what matches the search and, optionally, only what has been changed.
 *
 * An object property survives when any descendant does, carrying only the
 * surviving descendants - so a search for "owner" shows the Owner row inside its
 * section rather than the whole section, or nothing. A search that names the
 * section itself keeps all of it.
 */
export function filterProperties(
  nodes: readonly PropertyNode[],
  query: string,
  changedOnly: boolean,
): PropertyNode[] {
  const needle = query.trim().toLowerCase();
  const matchesText = (node: PropertyNode) =>
    !needle ||
    node.name.toLowerCase().includes(needle) ||
    node.description.toLowerCase().includes(needle) ||
    (node.displayValue ?? '').toLowerCase().includes(needle);

  const keep = (node: PropertyNode, ancestorMatched: boolean): PropertyNode | null => {
    const textMatch = ancestorMatched || matchesText(node);
    if (node.valueType === 'object') {
      const children = (node.children ?? [])
        .map((child) => keep(child, textMatch && Boolean(needle)))
        .filter((child): child is PropertyNode => child !== null);
      return children.length > 0 ? { ...node, children } : null;
    }
    return textMatch && (!changedOnly || isChangedFromDefault(node)) ? node : null;
  };
  return nodes.map((node) => keep(node, false)).filter((node): node is PropertyNode => node !== null);
}

/** How many properties below these have been changed, for the toolbar count. */
export function countChanged(nodes: readonly PropertyNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (isChangedFromDefault(node)) count += 1;
    count += countChanged(node.children ?? []);
  }
  return count;
}

// --------------------------------------------------------------------------- labels

/**
 * `NumberOfChannels` -> `Number of channels`, for the label a person reads.
 *
 * Acronyms keep their capitals (`EnableCANChannel` -> `Enable CAN channel`) and
 * digits stay attached to what they qualify (`Custom2dMinRange` -> `Custom 2d
 * min range`). The SDK's own name is never lost: it is the tooltip, it is what
 * search matches, and the table view shows it as-is.
 */
export function humanizeName(name: string): string {
  const words = name
    .replace(/_/g, ' ')
    // lower or digit followed by upper: "numberOf" -> "number Of"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // an acronym followed by a capitalised word: "CANChannel" -> "CAN Channel"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // a letter followed by a number: "Custom2d" -> "Custom 2d"
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => {
      const acronym = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      if (acronym) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}
