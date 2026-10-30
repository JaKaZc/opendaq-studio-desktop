import { describe, expect, it } from 'vitest';
import type { ComponentNode } from './types';
import { collect, findNode, fuzzyScore, groupInOrder, nodeBadges, pathTo, searchComponents, signalOwnerId, signalOwnerName } from './views';

/**
 * Lookups, badges and search over the component tree. The navigator's layout is
 * tested in navigator.test.ts.
 */

let counter = 0;

function node(partial: Partial<ComponentNode> & { id: string; kind: ComponentNode['kind'] }): ComponentNode {
  counter += 1;
  return {
    localId: partial.id.split('/').pop() ?? partial.id,
    name: partial.name ?? partial.id.split('/').pop() ?? `node${counter}`,
    displayName: partial.displayName ?? partial.name ?? partial.id.split('/').pop() ?? '',
    description: '',
    parentId: null,
    active: true,
    parentActive: true,
    visible: true,
    updating: false,
    tags: [],
    lockedAttributes: [],
    isDefaultFolder: false,
    status: { level: 'none', message: null, statuses: {} },
    children: [],
    ...partial,
  } as ComponentNode;
}

/**
 * A miniature instance shaped like the reference device:
 *   instance
 *     Sig (structural, empty)
 *     Dev
 *       RefDev0
 *         IO > AI > RefCh0 > Sig > AI0
 *         Sig (hidden-by-role folder)
 *     FB > Statistics > Sig > avg
 */
function buildTree(): ComponentNode {
  const signal = node({
    id: '/d/Dev/RefDev0/IO/AI/RefCh0/Sig/AI0',
    kind: 'signal',
    name: 'AI0',
  });
  const channelSignals = node({
    id: '/d/Dev/RefDev0/IO/AI/RefCh0/Sig',
    kind: 'folder',
    localId: 'Sig',
    children: [signal],
  });
  const channel = node({
    id: '/d/Dev/RefDev0/IO/AI/RefCh0',
    kind: 'channel',
    name: 'RefCh0',
    children: [channelSignals],
  });
  const ai = node({
    id: '/d/Dev/RefDev0/IO/AI',
    kind: 'folder',
    localId: 'AI',
    children: [channel],
  });
  const io = node({
    id: '/d/Dev/RefDev0/IO',
    kind: 'folder',
    localId: 'IO',
    children: [ai],
  });
  const device = node({
    id: '/d/Dev/RefDev0',
    kind: 'device',
    name: 'RefDev0',
    children: [io],
  });
  const devices = node({
    id: '/d/Dev',
    kind: 'folder',
    localId: 'Dev',
    children: [device],
  });

  const fbSignal = node({
    id: '/d/FB/Stats/Sig/avg',
    kind: 'signal',
    name: 'avg',
  });
  const fbSignals = node({
    id: '/d/FB/Stats/Sig',
    kind: 'folder',
    localId: 'Sig',
    children: [fbSignal],
  });
  const port = node({
    id: '/d/FB/Stats/IP/Input',
    kind: 'inputPort',
    name: 'Input',
  });
  const ports = node({
    id: '/d/FB/Stats/IP',
    kind: 'folder',
    localId: 'IP',
    children: [port],
  });
  const block = node({
    id: '/d/FB/Stats',
    kind: 'functionBlock',
    name: 'Statistics',
    children: [fbSignals, ports],
  });
  const blocks = node({
    id: '/d/FB',
    kind: 'folder',
    localId: 'FB',
    children: [block],
  });

  const emptySignals = node({ id: '/d/Sig', kind: 'folder', localId: 'Sig' });

  return node({
    id: '/d',
    kind: 'instance',
    name: 'Instance',
    children: [emptySignals, devices, blocks],
  });
}

const tree = buildTree();

describe('lookup helpers', () => {
  it('finds a node by id', () => {
    expect(findNode(tree, '/d/Dev/RefDev0')?.name).toBe('RefDev0');
    expect(findNode(tree, '/nope')).toBeNull();
  });

  it('names the channel that owns a signal, and nothing for a device signal', () => {
    const channelSignal = {
      id: '/d/Dev/RefDev0/IO/AI/RefCh0/Sig/AI0',
      deviceId: '/d/Dev/RefDev0',
    };
    expect(signalOwnerName(channelSignal, tree)).toBe(findNode(tree, '/d/Dev/RefDev0/IO/AI/RefCh0')?.name);
    expect(signalOwnerName(channelSignal, null)).toBe('RefCh0');
    expect(signalOwnerName({ id: '/d/Dev/RefDev0/Sig/Time', deviceId: '/d/Dev/RefDev0' }, tree)).toBeNull();
  });

  it('returns the ancestor chain, excluding the node itself', () => {
    expect(pathTo(tree, '/d/Dev/RefDev0/IO/AI/RefCh0')).toEqual([
      '/d',
      '/d/Dev',
      '/d/Dev/RefDev0',
      '/d/Dev/RefDev0/IO',
      '/d/Dev/RefDev0/IO/AI',
    ]);
  });

  it('collects by predicate', () => {
    expect(collect(tree, (entry) => entry.kind === 'signal')).toHaveLength(2);
  });
});

describe('nodeBadges', () => {
  it('is empty for a healthy, active component', () => {
    expect(nodeBadges(node({ id: '/x', kind: 'device' })).labels).toEqual([]);
  });

  it('reports the states an operator needs to see', () => {
    const badges = nodeBadges(
      node({
        id: '/x',
        kind: 'device',
        active: false,
        updating: true,
        status: { level: 'error', message: 'boom', statuses: {} },
        device: {
          locked: true,
          connected: false,
          operationMode: 'Operation',
          availableOperationModes: [],
          hasFunctionBlockTypes: false,
          isRoot: false,
        },
      }),
    );
    expect(badges.level).toBe('error');
    expect(badges.labels).toEqual(['err', 'inactive', 'disconnected', 'locked', 'updating']);
  });
});

describe('search', () => {
  it('ranks an exact prefix above a scattered match', () => {
    expect(fuzzyScore('AI0', 'AI0')).toBeGreaterThan(fuzzyScore('AI0', 'Analogue Input Zero'));
  });

  it('rejects characters that are out of order', () => {
    expect(fuzzyScore('zyx', 'xyz')).toBe(-1);
  });

  it('scores nothing for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('finds components by name', () => {
    const hits = searchComponents(tree, 'RefCh');
    expect(hits[0]!.node.name).toBe('RefCh0');
    expect(hits[0]!.field).toBe('name');
  });

  it('falls back to the global id', () => {
    const hits = searchComponents(tree, '/d/FB/Stats/Sig/avg');
    expect(hits.map((hit) => hit.node.id)).toContain('/d/FB/Stats/Sig/avg');
  });

  it('returns nothing for an empty query', () => {
    expect(searchComponents(tree, '   ')).toEqual([]);
  });
});

describe('signalOwnerId', () => {
  it('names the channel or function block that owns a signal', () => {
    expect(
      signalOwnerId({
        id: '/dev/phone/IO/AI/Accelerometer/Sig/X',
        deviceId: '/dev/phone',
      }),
    ).toBe('/dev/phone/IO/AI/Accelerometer');
  });

  it('is null for a signal of the device itself or without a signal folder', () => {
    expect(signalOwnerId({ id: '/dev/phone/Sig/Time', deviceId: '/dev/phone' })).toBeNull();
    expect(signalOwnerId({ id: '/dev/phone/Other', deviceId: '/dev/phone' })).toBeNull();
  });
});

describe('groupInOrder', () => {
  it('keeps the groups in the order their first item comes', () => {
    const groups = groupInOrder(['b1', 'a1', 'b2', 'c1', 'a2'], (item) => item[0] ?? null);
    expect(groups).toEqual([
      { key: 'b', items: ['b1', 'b2'] },
      { key: 'a', items: ['a1', 'a2'] },
      { key: 'c', items: ['c1'] },
    ]);
  });

  it('collects the items without a key into one group', () => {
    expect(groupInOrder([1, 2, 3], (item) => (item === 2 ? 'two' : null))).toEqual([
      { key: null, items: [1, 3] },
      { key: 'two', items: [2] },
    ]);
  });
});
