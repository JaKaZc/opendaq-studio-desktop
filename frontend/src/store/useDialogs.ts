/**
 * Dialog orchestration.
 *
 * One store instead of prop-drilling: the tree's context menu, the property grid
 * and the top bar all need to open the same dialogs, and threading a dozen
 * callbacks through four levels of component would be worse than a small piece of
 * shared state.  Exactly one dialog is open at a time, which matches how the
 * viewer is actually used and removes any question of stacking order.
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';

export type DialogState =
  | { kind: 'none' }
  | { kind: 'addDevice'; parentId: string | null; connectionString?: string }
  | { kind: 'addFunctionBlock'; parentId: string | null }
  | { kind: 'addServer' }
  | { kind: 'loadConfiguration' }
  | { kind: 'saveConfiguration' }
  | { kind: 'loadModule' }
  | { kind: 'attributes'; componentId: string }
  | { kind: 'statuses'; componentId: string }
  | { kind: 'descriptor'; signalId: string }
  | { kind: 'propertyMetadata'; componentId: string; path: string[] }
  | { kind: 'executeProperty'; componentId: string; path: string[] }
  | { kind: 'editContainer'; componentId: string; path: string[] }
  | { kind: 'viewValue'; title: string; text: string }
  | { kind: 'deviceInfo'; connectionString: string; parentId: string | null }
  | { kind: 'metadataColumns' }
  | { kind: 'shortcuts' }
  | { kind: 'about' };

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface DialogStore {
  dialog: DialogState;
  confirm: ConfirmRequest | null;
  confirmBusy: boolean;
  paletteOpen: boolean;

  open(dialog: DialogState): void;
  close(): void;
  requestConfirm(request: ConfirmRequest): void;
  resolveConfirm(): Promise<void>;
  cancelConfirm(): void;
  setPaletteOpen(open: boolean): void;
  togglePalette(): void;
}

export const useDialogs = create<DialogStore>((set, get) => ({
  dialog: { kind: 'none' },
  confirm: null,
  confirmBusy: false,
  paletteOpen: false,

  open(dialog) {
    set({ dialog });
  },

  close() {
    set({ dialog: { kind: 'none' } });
  },

  requestConfirm(request) {
    set({ confirm: request, confirmBusy: false });
  },

  async resolveConfirm() {
    const request = get().confirm;
    if (!request) return;
    set({ confirmBusy: true });
    try {
      await request.onConfirm();
    } finally {
      set({ confirm: null, confirmBusy: false });
    }
  },

  cancelConfirm() {
    set({ confirm: null, confirmBusy: false });
  },

  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },

  togglePalette() {
    set({ paletteOpen: !get().paletteOpen });
  },
}));
