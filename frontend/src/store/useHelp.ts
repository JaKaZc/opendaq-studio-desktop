import { create } from 'zustand';

/** Whether the help panel is open. */
export const useHelp = create<{ open: boolean; toggle(): void; close(): void }>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));
