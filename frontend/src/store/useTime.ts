/**
 * The devices' synchronization and clocks, polled while the Devices or Flow
 * page shows them. Measuring a clock asks each device over the network, so it
 * is read every three seconds, not continuously.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';
import type { DeviceTime, TimeMaster } from '../lib/timeSync';

interface TimeState {
  devices: DeviceTime[];
  /** Studio's own time server, or null before the first answer. */
  master: TimeMaster | null;
  /** Whether the devices' samples are shifted onto this computer's time. */
  align: boolean;
  refresh(): Promise<void>;
  setMaster(enabled: boolean): Promise<void>;
  setAlign(enabled: boolean): Promise<void>;
}

let loading = false;

export const useTime = create<TimeState>((set, get) => ({
  devices: [],
  master: null,
  align: false,
  async setAlign(enabled) {
    const result = await api.topology.setTimeAlign(enabled);
    set({ align: result.enabled });
  },
  async setMaster(enabled) {
    const master = await api.topology.setTimeMaster(enabled);
    set({ master });
    await get().refresh();
  },
  async refresh() {
    if (loading) return;
    loading = true;
    try {
      const result = await api.topology.time();
      set({ devices: result.devices, master: result.master ?? null, align: result.align?.enabled ?? false });
    } catch {
      // The next poll tries again.
    } finally {
      loading = false;
    }
  },
}));

/** Keeps the devices' time current while the calling page is shown. */
export function useTimePolling(): void {
  useEffect(() => {
    const refresh = useTime.getState().refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, []);
}
