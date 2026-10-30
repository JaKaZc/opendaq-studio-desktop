/** Every connected device at a glance (`GET /api/fleet`). */

import type { DeviceTime } from './timeSync';
import type { OperationMode } from './types';

export interface FleetDevice {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  connectionString: string;
  connected: boolean;
  operationMode: OperationMode | null;
  operationModes: OperationMode[];
  status: { level: 'Ok' | 'Warning' | 'Error' | string; message: string | null };
  channels: { total: number; active: number };
  /** A phone's System channel, newest values; null for other devices. */
  system: Partial<
    Record<'BatteryLevel' | 'Charging' | 'BatteryTemperature' | 'BatteryPower' | 'Cpu' | 'WifiSignal' | 'ThermalHeadroom' | 'MemoryUsed', number | null>
  > | null;
  time: DeviceTime | null;
  dashboard: { addresses: string[]; pin: string } | null;
}
