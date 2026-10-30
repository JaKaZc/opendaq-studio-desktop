/**
 * Formatting for measurement values, times and durations.
 *
 * Measurement UIs live or die on this: a value column that jitters between
 * `4.9999999` and `5` is unreadable, and a time axis labelled in raw epoch
 * seconds is useless.  Everything here is deliberately deterministic in width so
 * columns do not dance as values change.
 */

import type { DaqValue, EnumerationValue, RatioValue, StructValue, UnitInfo } from './types';

const SI_PREFIXES = [
  { exponent: -15, symbol: 'f' },
  { exponent: -12, symbol: 'p' },
  { exponent: -9, symbol: 'n' },
  { exponent: -6, symbol: 'µ' },
  { exponent: -3, symbol: 'm' },
  { exponent: 0, symbol: '' },
  { exponent: 3, symbol: 'k' },
  { exponent: 6, symbol: 'M' },
  { exponent: 9, symbol: 'G' },
  { exponent: 12, symbol: 'T' },
] as const;

/**
 * Engineering notation: `0.0000021 V` becomes `2.100 µV`.
 *
 * Used on axes and readouts, where a scaled prefix is far easier to compare at a
 * glance than an exponent.
 */
export function formatEngineering(value: number, unit = '', significant = 4): string {
  if (!Number.isFinite(value)) return unit ? `— ${unit}` : '—';
  if (value === 0) return unit ? `0 ${unit}` : '0';

  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log10(magnitude) / 3) * 3;
  const clamped = Math.min(12, Math.max(-15, exponent));
  const prefix = SI_PREFIXES.find((entry) => entry.exponent === clamped) ?? SI_PREFIXES[5];
  const scaled = value / 10 ** prefix.exponent;
  const digits = Math.max(0, significant - 1 - Math.floor(Math.log10(Math.abs(scaled))));
  const text = scaled.toFixed(Math.min(6, digits));
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  const symbol = `${prefix.symbol}${unit}`.trim();
  return symbol ? `${trimmed} ${symbol}` : trimmed;
}

/**
 * Format a measurement against the scale of its own signal.
 *
 * The mean of a symmetric sine is mathematically zero, but floating point makes
 * it something like 2e-14. Rendered on its own that becomes "19.87 fV", which
 * reads as a real femtovolt-scale measurement rather than as zero. Anything
 * below one part in `1e-9` of the reference span is shown as zero.
 */
export function formatRelative(value: number, reference: number, unit = '', significant = 4): string {
  if (!Number.isFinite(value)) return unit ? `— ${unit}` : '—';
  const floor = Math.abs(reference) * 1e-9;
  if (floor > 0 && Math.abs(value) < floor) return unit ? `0 ${unit}` : '0';
  return formatEngineering(value, unit, significant);
}

/** Fixed significant digits, no unit scaling. For grids and tables. */
export function formatNumber(value: number, significant = 6): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e9)) {
    return value.toExponential(Math.max(1, significant - 1));
  }
  return Number(value.toPrecision(significant)).toString();
}

export function formatUnit(unit: UnitInfo | null | undefined): string {
  return unit?.symbol ?? '';
}

export function withUnit(text: string, unit: UnitInfo | null | undefined): string {
  const symbol = formatUnit(unit);
  return symbol ? `${text} ${symbol}` : text;
}

/** A duration in seconds as the shortest readable form: `2.5 ms`, `1.20 s`, `2 m 05 s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const magnitude = Math.abs(seconds);
  if (magnitude < 1e-6) return `${(seconds * 1e9).toFixed(0)} ns`;
  if (magnitude < 1e-3) return `${(seconds * 1e6).toFixed(magnitude < 1e-5 ? 1 : 0)} µs`;
  if (magnitude < 1) return `${(seconds * 1e3).toFixed(magnitude < 0.01 ? 2 : 1)} ms`;
  if (magnitude < 60) return `${seconds.toFixed(magnitude < 10 ? 2 : 1)} s`;
  if (magnitude < 3600) {
    const minutes = Math.floor(magnitude / 60);
    return `${minutes} m ${String(Math.floor(magnitude % 60)).padStart(2, '0')} s`;
  }
  const hours = Math.floor(magnitude / 3600);
  return `${hours} h ${String(Math.floor((magnitude % 3600) / 60)).padStart(2, '0')} m`;
}

/** A sample rate as `20 kSa/s`. */
export function formatSampleRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return '—';
  return formatEngineering(rate, 'Sa/s', 4);
}

/** Absolute epoch seconds as a wall clock time, with sub-second precision. */
/**
 * `15:04:37.978` — the time of day at the requested precision.
 *
 * The value is truncated to the digits being shown *before* it is split, so the
 * seconds and the fraction can never disagree. Formatting them independently
 * rounds the fraction up to `.000` while the seconds still read the old value,
 * which renders 15:04:37 as `15:04:37.000` for the last half-millisecond of that
 * second — visible as a stutter on anything that updates continuously.
 */
export function formatTimeOfDay(epochSeconds: number, fractionDigits = 3): string {
  if (!Number.isFinite(epochSeconds)) return '—';
  if (fractionDigits <= 0) {
    return new Date(Math.round(epochSeconds * 1000)).toLocaleTimeString(undefined, { hour12: false });
  }
  const scale = 10 ** fractionDigits;
  const units = Math.floor(epochSeconds * scale);
  const base = new Date(Math.floor(units / scale) * 1000).toLocaleTimeString(undefined, {
    hour12: false,
  });
  // The modulo is guarded so a pre-1970 timestamp does not produce a negative
  // fraction; `Math.floor` has already taken the whole second below it.
  const fraction = ((units % scale) + scale) % scale;
  return `${base}.${String(fraction).padStart(fractionDigits, '0')}`;
}

export function formatDateTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—';
  return new Date(epochSeconds * 1000).toLocaleString(undefined, { hour12: false });
}

/** ISO timestamps from the API rendered for display. */
export function formatIsoTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : formatDateTime(parsed / 1000);
}

/** `1.4 MB` / `812 kB`, for configuration sizes and frame counters. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRelativeTime(epochSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, now - epochSeconds);
  if (delta < 1) return 'just now';
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

// --------------------------------------------------------------------------- DAQ values

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStructValue(value: DaqValue): value is StructValue {
  return isRecord(value) && value.kind === 'struct';
}

export function isEnumerationValue(value: DaqValue): value is EnumerationValue {
  return isRecord(value) && value.kind === 'enumeration';
}

export function isRatioValue(value: DaqValue): value is RatioValue {
  return isRecord(value) && value.kind === 'ratio';
}

export function isObjectValue(value: DaqValue): boolean {
  return isRecord(value) && value.kind === 'object';
}

/**
 * Render any openDAQ value as a single line.
 *
 * The backend already supplies `displayValue` for property rows; this covers the
 * places that do not have one (attributes, struct fields, dialog previews).
 */
export function formatDaqValue(value: DaqValue, unit?: UnitInfo | null): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return withUnit(formatNumber(value), unit);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 4) return `[${value.map((item) => formatDaqValue(item)).join(', ')}]`;
    return `[${value.length} items]`;
  }
  if (isStructValue(value)) {
    const entries = Object.entries(value.fields);
    const preview = entries
      .slice(0, 3)
      .map(([key, field]) => `${key}: ${formatDaqValue(field)}`)
      .join(', ');
    return entries.length > 3 ? `{${preview}, …}` : `{${preview}}`;
  }
  if (isEnumerationValue(value)) return value.name;
  if (isRatioValue(value)) return `${value.numerator}/${value.denominator}`;
  if (isRecord(value)) {
    if (value.kind === 'complex') return `${formatNumber(Number(value.real))} + ${formatNumber(Number(value.imaginary))}i`;
    if (value.kind === 'object') return '{object}';
    if (value.kind === 'callable') return '(callable)';
    if (value.kind === 'binary') return `${String(value.byteLength ?? '?')} bytes`;
    const keys = Object.keys(value);
    return keys.length === 0 ? '{}' : `{${keys.length} entries}`;
  }
  return String(value);
}

/** Truncate for a fixed-width cell, keeping the end when it is more telling. */
export function ellipsize(text: string, max = 48, keepEnd = false): string {
  if (text.length <= max) return text;
  return keepEnd ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`;
}

/**
 * Drop the leading device path from a global id.
 *
 * `/openDAQDevice/Dev/RefDev0/IO/AI/RefCh0/Sig/AI0` reads as
 * `RefDev0 / RefCh0 / AI0`: structural folders carry no information for a person
 * scanning a list.
 */
export function shortenGlobalId(globalId: string): string {
  const parts = globalId.split('/').filter(Boolean);
  const meaningful = parts.filter((part) => !['Dev', 'FB', 'Sig', 'IP', 'IO', 'Srv'].includes(part));
  if (meaningful.length <= 1) return meaningful.join(' / ') || globalId;
  return meaningful.slice(1).join(' / ');
}

/** Pick nice round tick values covering `[min, max]`. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const rawStep = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  // Each tick is `index * step`, never a running sum, and is then rounded to the
  // step's own decimal places. Summing ten 0.1 steps up from -1 lands on
  // -1.4e-16 rather than 0, and rounding to significant figures keeps that error
  // because it is relative to the value, not the step - so the zero gridline was
  // labelled "-0.139 fV".
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let index = Math.ceil(min / step); index * step <= max + step * 1e-9; index += 1) {
    // `+ 0` turns the -0 that rounding a tiny negative produces into 0.
    ticks.push(Number((index * step).toFixed(decimals)) + 0);
  }
  return ticks;
}
