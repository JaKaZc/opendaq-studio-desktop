/**
 * What the Signals page shows, read from the instance: the signals a track can
 * draw (a number per sample, or an array per sample such as a spectrum), and for
 * each function block output the signal its input port reads.
 */

import { create } from 'zustand';
import { api } from '../../lib/api';
import { findNode, walk } from '../../lib/views';
import type { ComponentNode, SignalInfo } from '../../lib/types';

interface SignalData {
  signals: SignalInfo[];
  byId: Map<string, SignalInfo>;
  loaded: boolean;
  refresh(signal?: AbortSignal): Promise<void>;
}

/** A signal a track can draw: streamed samples, the latest array per sample, or the latest picture. */
export function isDrawable(signal: SignalInfo): boolean {
  return signal.chartable || signal.shape === 'array' || Boolean(signal.image);
}

export function isImageSignal(signal: SignalInfo | undefined): boolean {
  return Boolean(signal?.image);
}

export function isArraySignal(signal: SignalInfo | undefined): boolean {
  return signal?.shape === 'array';
}

export const useSignalData = create<SignalData>((set) => ({
  signals: [],
  byId: new Map(),
  loaded: false,

  async refresh(signal) {
    const list = await api.signals.list({}, signal);
    const drawable = list.signals.filter(isDrawable);
    set({ signals: drawable, byId: new Map(drawable.map((entry) => [entry.id, entry])), loaded: true });
  },
}));

const isBlock = (node: ComponentNode) => node.kind === 'functionBlock' || node.kind === 'recorder';

/**
 * Output signal id -> the signal the function block's first connected input
 * port reads. A Statistics block on AI0 makes its outputs come "from AI0".
 */
export function inputSources(tree: ComponentNode | null): Map<string, string> {
  const sources = new Map<string, string>();
  if (!tree) return sources;
  walk(tree, (node) => {
    if (!isBlock(node)) return;
    const port = node.children
      .flatMap((child) => (child.kind === 'inputPort' ? [child] : child.children.filter((inner) => inner.kind === 'inputPort')))
      .find((entry) => entry.inputPort?.signalId);
    const source = port?.inputPort?.signalId;
    if (!source) return;
    const visit = (child: ComponentNode) => {
      if (isBlock(child)) return;
      if (child.kind === 'signal') sources.set(child.id, source);
      child.children.forEach(visit);
    };
    node.children.forEach(visit);
  });
  return sources;
}

/** The function block that produces a signal, when one does. */
export function producerOf(tree: ComponentNode | null, signalId: string): ComponentNode | null {
  if (!tree) return null;
  let found: ComponentNode | null = null;
  walk(tree, (node) => {
    if (found || !isBlock(node)) return;
    const visit = (child: ComponentNode): boolean => {
      if (isBlock(child)) return false;
      if (child.id === signalId) return true;
      return child.children.some(visit);
    };
    if (node.children.some(visit)) found = node;
  });
  return found;
}

/** Every recorder function block in the instance, such as the CSV and Parquet recorders. */
export function recorders(tree: ComponentNode | null): ComponentNode[] {
  const list: ComponentNode[] = [];
  if (tree) walk(tree, (node) => node.functionBlock?.isRecorder && list.push(node));
  return list;
}

/** The device a signal belongs to, or `null` for the instance itself. */
export function deviceIdOf(signal: SignalInfo | undefined, tree: ComponentNode | null): string | null {
  if (!signal?.deviceId || !tree || signal.deviceId === tree.id) return null;
  return signal.deviceId;
}

export function deviceName(deviceId: string | null, tree: ComponentNode | null): string {
  if (deviceId === null) return 'This instance';
  const node = tree ? findNode(tree, deviceId) : null;
  return node ? node.displayName || node.name : deviceId.split('/').pop() || deviceId;
}
