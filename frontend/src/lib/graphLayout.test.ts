import { describe, expect, it } from 'vitest';
import { hitTest, layoutGraph, type DiagramLayout, type LayoutBlock } from './graphLayout';
import type { GraphEdge, GraphNode, TopologyGraph } from './types';

function node(id: string, kind: GraphNode['kind'], groupId: string | null, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind,
    name: id,
    groupId,
    active: true,
    status: null,
    detail: {},
    ...extra,
  };
}

function edge(source: string, target: string, kind: GraphEdge['kind'], label = ''): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind, label };
}

/** A device with two channels, one function block reading one of them. */
function sample(): TopologyGraph {
  const nodes: GraphNode[] = [
    node('inst', 'instance', null),
    node('dev', 'device', 'inst'),
    node('ch0', 'channel', 'dev'),
    node('ch1', 'channel', 'dev'),
    node('ai0', 'signal', 'dev'),
    node('ai1', 'signal', 'dev'),
    node('ai0t', 'signal', 'dev', { detail: { isDomain: true } }),
    node('fb', 'functionBlock', 'inst', {
      ports: [{ id: 'fb/in', name: 'Input', requiresSignal: true, signalId: 'ai0' }],
    }),
    node('avg', 'signal', 'inst'),
    node('srv', 'server', 'inst'),
  ];
  const edges: GraphEdge[] = [
    edge('inst', 'dev', 'contains'),
    edge('dev', 'ch0', 'contains'),
    edge('dev', 'ch1', 'contains'),
    edge('ch0', 'ai0', 'produces'),
    edge('ch1', 'ai1', 'produces'),
    edge('ch0', 'ai0t', 'produces'),
    edge('ai0', 'ai0t', 'domain'),
    edge('ai0', 'fb', 'signal', 'Input'),
    edge('fb', 'avg', 'produces'),
    edge('inst', 'srv', 'publishes'),
  ];
  return {
    instanceId: 'inst',
    nodes,
    edges,
    groups: [
      { id: 'inst', name: 'Instance', parentId: null, kind: 'instance' },
      { id: 'dev', name: 'RefDev0', parentId: 'inst', kind: 'device' },
    ],
    stats: { nodes: nodes.length, edges: edges.length, byKind: {}, connections: 1 },
  };
}

const block = (layout: DiagramLayout, id: string) => layout.blocks.find((entry) => entry.node.id === id) as LayoutBlock;

describe('layoutGraph', () => {
  it('draws channels, function blocks and servers as blocks, and signals as their rows', () => {
    const layout = layoutGraph(sample());
    expect(layout.blocks.map((entry) => entry.node.id).sort()).toEqual(['ch0', 'ch1', 'fb', 'srv']);
    expect(block(layout, 'ch0').outputs.map((row) => row.id)).toEqual(['ai0']);
    expect(block(layout, 'fb').inputs[0]?.signalId).toBe('ai0');
    expect(block(layout, 'fb').outputs.map((row) => row.id)).toEqual(['avg']);
    expect(layout.groups.map((entry) => entry.group.id).sort()).toEqual(['dev', 'inst']);
  });

  it('leaves domain signals out unless they are asked for', () => {
    expect(block(layoutGraph(sample()), 'ch0').outputs.some((row) => row.id === 'ai0t')).toBe(false);
    expect(block(layoutGraph(sample(), { showDomain: true }), 'ch0').outputs.some((row) => row.id === 'ai0t')).toBe(true);
  });

  it('runs a connection from the output row to the port row', () => {
    const layout = layoutGraph(sample());
    const [connection] = layout.edges;
    const source = block(layout, 'ch0');
    const target = block(layout, 'fb');
    expect(layout.edges).toHaveLength(1);
    expect(connection?.path.startsWith(`M${source.x + source.width} ${source.y + (source.outputs[0]?.y ?? 0)} `)).toBe(true);
    expect(connection?.path.endsWith(`${target.x} ${target.y + (target.inputs[0]?.y ?? 0)}`)).toBe(true);
    expect(connection?.sourceRow).toBe('ai0');
    expect(connection?.targetRow).toBe('fb/in');
  });

  it('puts connected blocks along the flow and the others in a grid to its right', () => {
    const layout = layoutGraph(sample());
    expect(block(layout, 'ch0').connected).toBe(true);
    expect(block(layout, 'ch1').connected).toBe(false);
    expect(block(layout, 'ch0').layer).toBeLessThan(block(layout, 'fb').layer);
    expect(block(layout, 'fb').x).toBeGreaterThan(block(layout, 'ch0').x);
    // No connection runs through an unconnected block.
    expect(block(layout, 'ch1').x).toBeGreaterThan(block(layout, 'fb').x);
  });

  it('can leave out the blocks with no connection', () => {
    const ids = layoutGraph(sample(), { onlyConnected: true }).blocks.map((entry) => entry.node.id);
    expect(ids.sort()).toEqual(['ch0', 'fb']);
  });

  it('keeps a device with many channels compact', () => {
    const graph = sample();
    for (let i = 0; i < 20; i += 1) {
      graph.nodes.push(node(`c${i}`, 'channel', 'dev'), node(`s${i}`, 'signal', 'dev'));
      graph.edges.push(edge(`c${i}`, `s${i}`, 'produces'));
    }
    const dev = layoutGraph(graph).groups.find((entry) => entry.group.id === 'dev')!;
    // Four blocks a row rather than one column of twenty-two.
    expect(dev.height).toBeLessThan(22 * 60);
  });

  it('keeps blocks inside their device boxes', () => {
    const layout = layoutGraph(sample());
    for (const box of layout.groups) {
      for (const member of layout.blocks.filter((entry) => entry.node.groupId === box.group.id)) {
        expect(member.x).toBeGreaterThanOrEqual(box.x);
        expect(member.y).toBeGreaterThanOrEqual(box.y);
        expect(member.x + member.width).toBeLessThanOrEqual(box.x + box.width);
        expect(member.y + member.height).toBeLessThanOrEqual(box.y + box.height);
      }
    }
  });

  it('gives the signals a device produces itself a block of their own', () => {
    const graph = sample();
    graph.nodes.push(node('battery', 'signal', 'dev'));
    graph.edges.push(edge('dev', 'battery', 'produces'));
    const own = layoutGraph(graph).blocks.find((entry) => entry.node.kind === 'deviceSignals')!;
    expect(own.outputs.map((row) => row.id)).toEqual(['battery']);
    expect(own.node.groupId).toBe('dev');
  });

  it('finds the block and row under a point', () => {
    const layout = layoutGraph(sample());
    const source = block(layout, 'ch0');
    const hit = hitTest(layout, source.x + 20, source.y + (source.outputs[0]?.y ?? 0));
    expect(hit?.block.node.id).toBe('ch0');
    expect(hit?.row?.id).toBe('ai0');
    expect(hitTest(layout, -10, -10)).toBeNull();
  });

  it('draws the same picture twice for the same graph', () => {
    const picture = (layout: DiagramLayout) => JSON.stringify(layout.blocks.map((entry) => [entry.node.id, entry.x, entry.y]));
    expect(picture(layoutGraph(sample()))).toEqual(picture(layoutGraph(sample())));
  });

  it('survives a feedback loop and an empty instance', () => {
    const graph = sample();
    graph.edges.push(edge('avg', 'fb', 'signal'));
    expect(layoutGraph(graph).blocks.length).toBeGreaterThan(0);
    const empty = layoutGraph({
      instanceId: 'inst',
      nodes: [],
      edges: [],
      groups: [],
      stats: { nodes: 0, edges: 0, byKind: {}, connections: 0 },
    });
    expect(empty).toEqual({ blocks: [], edges: [], groups: [], width: 0, height: 0 });
  });
});
