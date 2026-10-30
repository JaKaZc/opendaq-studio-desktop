/** Small shared helpers: class names, persistence, clipboard, file download. */

/** Join class names, dropping falsy entries. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// --------------------------------------------------------------------------- persistence

const STORAGE_PREFIX = 'opendaq-studio:';

/**
 * Read a persisted UI preference.
 *
 * Every access is guarded: private windows, cleared site data and browsers set to
 * block storage all make these throw or return null, and none of that should stop
 * the viewer from rendering.
 */
export function loadPreference<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePreference(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Nothing here is important enough to interrupt the user over.
  }
}

export function clearPreference(key: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignored */
  }
}

// --------------------------------------------------------------------------- clipboard

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall back to the legacy path, which works without a secure context.
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }
}

// --------------------------------------------------------------------------- downloads

/** Hand the browser a generated file. */
export function downloadText(filename: string, content: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Revoke on the next tick: revoking synchronously can cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function triggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Read a file the user picked, as text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

// --------------------------------------------------------------------------- csv

/** Quote a CSV field only when it needs it. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// --------------------------------------------------------------------------- misc

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Stable colour for a trace, from the brand-derived scope palette. */
export const TRACE_COLORS = [
  '#f15d31', // openDAQ orange
  '#2f6fa3', // openDAQ navy, lightened for contrast
  '#1a9e6f',
  '#b4699f',
  '#c9a227',
  '#4a5fbf',
  '#d2603a',
  '#3f9ab0',
] as const;

export function traceColor(index: number): string {
  return TRACE_COLORS[index % TRACE_COLORS.length] as string;
}

/** Debounce that keeps the latest arguments; used for search-as-you-type. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number): ((...args: A) => void) & {
  cancel: () => void;
} {
  let timer: number | null = null;
  const wrapped = (...args: A) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  wrapped.cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** True when a keyboard event should be ignored because the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** The platform-appropriate modifier label for shortcut hints. */
export const MOD_KEY = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
