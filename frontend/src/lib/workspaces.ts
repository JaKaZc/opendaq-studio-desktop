/**
 * The modes of openDAQ Studio, in one place.
 *
 * Most modes show one part of an openDAQ instance as the SDK describes it: its
 * signals, its devices and their properties, the flow of data between
 * components, the loaded modules and the SDK itself. The Scope analyses signals
 * closely. The header's mode switch, the command palette and the number keys all
 * derive from this list.
 */

import { Activity, Cpu, LayoutGrid, LineChart, Network, Puzzle, type LucideIcon } from 'lucide-react';

export type Workspace = 'signals' | 'scope' | 'devices' | 'flow' | 'fleet' | 'modules';

export interface WorkspaceEntry {
  id: Workspace;
  label: string;
  icon: LucideIcon;
  /** One sentence: what this mode is for. */
  hint: string;
}

export const WORKSPACES: readonly WorkspaceEntry[] = [
  { id: 'signals', label: 'Signals', icon: Activity, hint: 'Watch the signals of the instance live and run its recorders.' },
  { id: 'scope', label: 'Scope', icon: LineChart, hint: 'Analyse signals closely with a trigger, cursors, measurements and a spectrum.' },
  { id: 'devices', label: 'Devices', icon: Cpu, hint: 'Browse devices, channels and function blocks and change their properties.' },
  { id: 'flow', label: 'Flow', icon: Network, hint: 'See how signals flow from devices through function blocks to servers.' },
  { id: 'fleet', label: 'Fleet', icon: LayoutGrid, hint: 'See every connected device at a glance, and run or idle them together.' },
  { id: 'modules', label: 'Modules', icon: Puzzle, hint: 'See the loaded modules and the component types they provide.' },
];

export const DEFAULT_WORKSPACE: Workspace = 'signals';

/** `1` … `6`, by position. */
export function shortcutFor(workspace: Workspace): string {
  return String(WORKSPACES.findIndex((entry) => entry.id === workspace) + 1);
}

export function workspaceForKey(key: string): Workspace | null {
  const index = Number(key) - 1;
  return Number.isInteger(index) && index >= 0 && index < WORKSPACES.length ? (WORKSPACES[index] as WorkspaceEntry).id : null;
}

export function workspaceEntry(workspace: Workspace): WorkspaceEntry {
  return WORKSPACES.find((entry) => entry.id === workspace) ?? (WORKSPACES[0] as WorkspaceEntry);
}
