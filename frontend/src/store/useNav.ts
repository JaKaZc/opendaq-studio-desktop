/**
 * Where the user is: the mode in view.
 *
 * A store rather than state in App, so anything can send the user somewhere,
 * a button in the inspector or the command palette, without a callback threaded
 * through every page.
 */

import { create } from 'zustand';
import { DEFAULT_WORKSPACE, type Workspace } from '../lib/workspaces';

interface NavState {
  workspace: Workspace;
  go(workspace: Workspace): void;
}

export const useNav = create<NavState>((set) => ({
  workspace: DEFAULT_WORKSPACE,
  go(workspace) {
    set({ workspace });
  },
}));

/** Send the user somewhere: the same as `useNav.getState().go`. */
export function go(workspace: Workspace): void {
  useNav.getState().go(workspace);
}
