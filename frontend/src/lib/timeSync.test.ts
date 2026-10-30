import { describe, expect, it } from 'vitest';
import { followedDevice, roleText, summarize, syncRole, type DeviceTime, type TimeMaster } from './timeSync';

const ntp: DeviceTime = {
  id: '/i/Dev/Phone',
  name: 'Phone sensors',
  isRoot: false,
  sync: {
    locked: true,
    interfaces: [
      { name: 'PhoneClock', selected: false, mode: 'Off' },
      { name: 'NetworkTime', selected: true, mode: 'Input' },
    ],
  },
  clock: { offsetMs: 0.4, uncertaintyMs: 0.5 },
};

const reference: DeviceTime = {
  id: '/i/Dev/RefDev0',
  name: 'RefDev0',
  isRoot: false,
  sync: { locked: true, interfaces: [{ name: 'InterfaceClockSync', selected: true, mode: 'Off' }] },
  clock: { offsetMs: 0, uncertaintyMs: 0 },
};

describe('time synchronization', () => {
  it('names the role and the source', () => {
    expect(roleText(ntp)).toBe('Slave of NetworkTime');
    expect(roleText(reference)).toBe('Source InterfaceClockSync');
  });

  it('counts close, locked clocks as in sync', () => {
    const summary = summarize([ntp, reference]);
    expect(summary.inSync).toBe(true);
    expect(summary.spreadMs).toBeCloseTo(0.4);
  });

  it('reports an unlocked device and clocks far apart', () => {
    const late = { ...ntp, sync: { ...ntp.sync!, locked: false }, clock: { offsetMs: 174, uncertaintyMs: 1 } };
    const summary = summarize([late, reference]);
    expect(summary.inSync).toBe(false);
    expect(summary.text).toContain('Phone sensors is not locked to its source.');
    expect(summary.text).toContain('Phone sensors is 174 ms ahead of RefDev0.');
  });

  it('leaves out devices that say nothing about time', () => {
    const root: DeviceTime = { id: '/i', name: 'Instance', isRoot: true, sync: { locked: false, interfaces: [] } };
    expect(summarize([root]).devices).toHaveLength(0);
  });
});

describe('a phone that serves its time', () => {
  const gnssMaster: DeviceTime = {
    id: '/i/Dev/GnssPhone',
    name: 'GNSS phone',
    isRoot: false,
    sync: {
      locked: true,
      interfaces: [
        { name: 'PhoneClock', selected: false, mode: 'Output' },
        { name: 'NetworkTime', selected: false, mode: 'Off' },
        { name: 'GnssTime', selected: true, mode: 'Input' },
      ],
    },
    serves: ['192.168.1.20:12300'],
  };
  const follower: DeviceTime = { ...ntp, detail: 'Follows the NTP server 192.168.1.20:12300, 0.3 ms round trip.' };
  const master: TimeMaster = {
    enabled: true,
    serving: true,
    port: 12300,
    addresses: ['192.168.1.10'],
    answered: 0,
    error: null,
    device: { id: gnssMaster.id, name: gnssMaster.name, address: '192.168.1.20:12300', addresses: ['192.168.1.20:12300'] },
  };

  it('is a master, and says where its own time comes from', () => {
    expect(syncRole(gnssMaster)).toBe('Master');
    expect(roleText(gnssMaster)).toBe('Master on PhoneClock, its own time from GnssTime');
  });

  it('is named as the master of the phones that follow it', () => {
    expect(followedDevice(follower, master)).toBe('GNSS phone');
    expect(followedDevice(gnssMaster, master)).toBeNull();
    expect(followedDevice(follower, { ...master, device: null })).toBeNull();
  });
});
