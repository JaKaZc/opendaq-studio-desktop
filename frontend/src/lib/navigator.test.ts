import { describe, expect, it } from 'vitest';
import type { ComponentNode } from './types';
import {
  buildNavigator,
  contextFor,
  deviceSummary,
  expandableIds,
  filterNav,
  flattenNav,
  liveSignalOf,
  navCounts,
  openByDefault,
  trackSignalsOf,
  type NavNode,
} from './navigator';

function node(partial: Partial<ComponentNode> & { id: string; kind: ComponentNode['kind'] }): ComponentNode {
  const localId = partial.localId ?? partial.id.split('/').pop() ?? partial.id;
  return {
    localId,
    name: partial.name ?? localId,
    displayName: partial.displayName ?? partial.name ?? localId,
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

const folder = (id: string, children: ComponentNode[], isDefaultFolder = true) =>
  node({ id, kind: 'folder', isDefaultFolder, children });

function channel(base: string, name: string, signal: string, blocks: ComponentNode[] = []): ComponentNode {
  const id = `${base}/${name}`;
  return node({
    id,
    kind: 'channel',
    children: [
      folder(`${id}/Sig`, [
        node({ id: `${id}/Sig/${signal}`, kind: 'signal', signal: { domainSignalId: `${id}/Sig/Time` } as never }),
        node({ id: `${id}/Sig/Time`, kind: 'signal' }),
      ]),
      folder(`${id}/FB`, blocks),
      folder(`${id}/IP`, []),
    ],
  });
}

function device(base: string, name: string): ComponentNode {
  const id = `${base}/${name}`;
  return node({
    id,
    kind: 'device',
    device: { operationMode: 'SafeOperation', connected: true } as never,
    children: [
      folder(`${id}/Sig`, []),
      folder(`${id}/FB`, []),
      folder(`${id}/Dev`, []),
      folder(`${id}/IO`, [
        folder(`${id}/IO/AI`, [channel(`${id}/IO/AI`, 'RefCh0', 'AI0'), channel(`${id}/IO/AI`, 'RefCh1', 'AI1')], false),
        folder(`${id}/IO/CAN`, [], false),
      ]),
      node({ id: `${id}/Synchronization`, kind: 'syncComponent' }),
      folder(`${id}/Srv`, []),
    ],
  });
}

/** The reference demo: a client with two reference devices and a statistics block. */
function demo(): ComponentNode {
  const stats = node({
    id: '/c/FB/Stats',
    kind: 'functionBlock',
    children: [folder('/c/FB/Stats/Sig', [node({ id: '/c/FB/Stats/Sig/avg', kind: 'signal', signal: { domainSignalId: 'x' } as never })])],
  });
  return node({
    id: '/c',
    kind: 'instance',
    name: 'OpenDAQClient',
    children: [
      folder('/c/Sig', []),
      folder('/c/FB', [stats]),
      folder('/c/Dev', [device('/c/Dev', 'RefDev0'), device('/c/Dev', 'RefDev1')]),
      folder('/c/IO', []),
      folder('/c/Srv', []),
    ],
  });
}

const names = (nodes: readonly NavNode[]) => nodes.map((entry) => entry.node.name);

describe('the "All" view', () => {
  const [root] = buildNavigator(demo(), 'all', false);

  it('puts devices first under the instance, then its blocks', () => {
    expect(names(root!.children)).toEqual(['RefDev0', 'RefDev1', 'Stats']);
    expect(root!.children.map((entry) => entry.group)).toEqual(['Devices', 'Devices', 'Function blocks']);
  });

  it('puts channels straight under their device, captioned by the folder that means something', () => {
    const refDev0 = root!.children[0]!;
    expect(names(refDev0.children)).toEqual(['RefCh0', 'RefCh1', 'Synchronization']);
    expect(refDev0.children.map((entry) => entry.group)).toEqual(['AI', 'AI', 'Components']);
  });

  it('draws each caption once, above the first row of its group', () => {
    const rows = flattenNav([root!], openByDefault);
    expect(rows.map((row) => [row.entry.node.name, row.caption])).toEqual([
      ['OpenDAQClient', null],
      ['RefDev0', 'Devices'],
      ['RefCh0', 'AI'],
      ['RefCh1', null],
      ['Synchronization', 'Components'],
      ['RefDev1', null],
      ['RefCh0', 'AI'],
      ['RefCh1', null],
      ['Synchronization', 'Components'],
      ['Stats', 'Function blocks'],
    ]);
    expect(rows[2]).toMatchObject({ depth: 2, parentId: '/c/Dev/RefDev0' });
  });

  it('reads the value signal of a channel or block, not its time signal', () => {
    expect(root!.children[0]!.children[0]!.liveSignalId).toBe('/c/Dev/RefDev0/IO/AI/RefCh0/Sig/AI0');
    expect(root!.children[2]!.liveSignalId).toBe('/c/FB/Stats/Sig/avg');
  });

  it('gives a device no reading of its own: its clock is not a measurement', () => {
    const tree = demo();
    const refDev0 = tree.children[2]!.children[0]!;
    refDev0.children[0]!.children.push(node({ id: `${refDev0.id}/Sig/Time`, kind: 'signal' }));
    expect(buildNavigator(tree, 'all', false)[0]!.children[0]!.liveSignalId).toBeNull();
  });

  it('nests a block attached to a channel under that channel', () => {
    const tree = demo();
    const refCh0 = tree.children[2]!.children[0]!.children[3]!.children[0]!.children[0]!;
    refCh0.children[1]!.children.push(node({ id: `${refCh0.id}/FB/Scale`, kind: 'functionBlock' }));
    const [withBlock] = buildNavigator(tree, 'all', false);
    expect(names(withBlock!.children[0]!.children[0]!.children)).toEqual(['Scale']);
  });

  it('leaves hidden components out unless asked', () => {
    const tree = demo();
    tree.children[2]!.children[1]!.visible = false;
    expect(names(buildNavigator(tree, 'all', false)[0]!.children)).toEqual(['RefDev0', 'Stats']);
    expect(names(buildNavigator(tree, 'all', true)[0]!.children)).toEqual(['RefDev0', 'RefDev1', 'Stats']);
  });

  it('summarises a device on its second line', () => {
    expect(deviceSummary(root!.children[0]!)).toBe('Safe operation · 2 channels');
    expect(deviceSummary(root!)).toBe('2 devices · 1 block');
  });
});

describe('the flat filters', () => {
  it('say where each row lives, since the tree is not there to', () => {
    const signals = buildNavigator(demo(), 'signals', false);
    expect(signals).toHaveLength(9);
    expect(signals[0]).toMatchObject({ context: 'Stats · OpenDAQClient' });
    expect(signals.find((entry) => entry.node.id.endsWith('RefDev1/IO/AI/RefCh1/Sig/AI1'))?.context).toBe('RefCh1 · RefDev1');
  });

  it('list channels and blocks with their device', () => {
    const channels = buildNavigator(demo(), 'channels', false);
    expect(channels.map((entry) => entry.context)).toEqual(['AI · RefDev0', 'AI · RefDev0', 'AI · RefDev1', 'AI · RefDev1']);
    expect(names(buildNavigator(demo(), 'blocks', false))).toEqual(['Stats']);
    expect(names(buildNavigator(demo(), 'devices', false))).toEqual(['RefDev0', 'RefDev1']);
  });

  it('counts what each chip would show', () => {
    expect(navCounts(demo(), false)).toEqual({ all: 7, devices: 2, channels: 4, signals: 9, blocks: 1 });
  });

  it('names the owner and device, skipping storage folders', () => {
    const tree = demo();
    expect(contextFor([tree, tree.children[2]!])).toBe('OpenDAQClient');
  });
});

describe('the complete tree', () => {
  it('is still there, folders and all, for when the SDK structure is the question', () => {
    const [root] = buildNavigator(demo(), 'all', false, true);
    expect(names(root!.children)).toContain('Dev');
  });

  it('honours the hidden-components toggle there too', () => {
    const tree = demo();
    tree.children[2]!.children[0]!.visible = false;
    const count = (nodes: readonly NavNode[]): number => nodes.reduce((total, entry) => total + 1 + count(entry.children), 0);
    expect(count(buildNavigator(tree, 'all', true, true))).toBeGreaterThan(count(buildNavigator(tree, 'all', false, true)));
  });
});

describe('search', () => {
  it('keeps matches and the rows that lead to them', () => {
    const nav = buildNavigator(demo(), 'all', false);
    const kept = filterNav(nav, new Set(['/c/Dev/RefDev1/IO/AI/RefCh1']));
    expect(names(kept[0]!.children)).toEqual(['RefDev1']);
    expect(names(kept[0]!.children[0]!.children)).toEqual(['RefCh1']);
  });

  it('keeps everything under a matched device', () => {
    const kept = filterNav(buildNavigator(demo(), 'all', false), new Set(['/c/Dev/RefDev0']));
    expect(kept[0]!.children[0]!.children).toHaveLength(3);
  });
});

describe('expansion', () => {
  it('lists every row that can open', () => {
    expect(expandableIds(buildNavigator(demo(), 'all', false))).toEqual(['/c', '/c/Dev/RefDev0', '/c/Dev/RefDev1']);
  });

  it('falls back to any output when none has a time base', () => {
    const lone = node({ id: '/x', kind: 'functionBlock', children: [folder('/x/Sig', [node({ id: '/x/Sig/out', kind: 'signal' })])] });
    expect(liveSignalOf(lone)).toBe('/x/Sig/out');
  });
});

describe('trackSignalsOf', () => {
  it('gives every signal of a channel that has a domain, not its clock', () => {
    const accelerometer = node({
      id: '/p/Accelerometer',
      kind: 'channel',
      children: [
        folder('/p/Accelerometer/Sig', [
          ...['X', 'Y', 'Z'].map((axis) =>
            node({ id: `/p/Accelerometer/Sig/${axis}`, kind: 'signal', signal: { domainSignalId: '/p/Accelerometer/Sig/Time' } as never }),
          ),
          node({ id: '/p/Accelerometer/Sig/Time', kind: 'signal' }),
        ]),
      ],
    });
    expect(trackSignalsOf(accelerometer)).toEqual(['/p/Accelerometer/Sig/X', '/p/Accelerometer/Sig/Y', '/p/Accelerometer/Sig/Z']);
  });

  it('gives a signal itself, and nothing for a device', () => {
    expect(trackSignalsOf(node({ id: '/p/s', kind: 'signal' }))).toEqual(['/p/s']);
    expect(trackSignalsOf(device('/c/Dev', 'RefDev0'))).toEqual([]);
  });
});
