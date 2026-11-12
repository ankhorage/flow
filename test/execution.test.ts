import { describe, expect, test } from 'bun:test';
import type { FlowDefinition } from '@ankhorage/contracts/flow';

import { compileFlowGraph, createDefaultNodeRegistry, executeFlowAsync } from '../src/index.js';

const registry = createDefaultNodeRegistry();
const clock = { now: () => new Date('2026-11-12T12:00:00.000Z') };

const branchingDefinition: FlowDefinition = {
  id: 'branching',
  version: 1,
  title: 'Branching',
  triggers: [{ id: 'manual', kind: 'manual' }],
  nodes: [
    {
      id: 'source',
      capability: { providerId: 'flow', capabilityId: 'transform' },
      config: { value: { kind: 'inline', value: { approved: true } } },
      ports: [{ id: 'value', direction: 'output' }],
    },
    {
      id: 'accepted',
      capability: { providerId: 'flow', capabilityId: 'noop' },
      ports: [{ id: 'value', direction: 'input', required: true }],
    },
    {
      id: 'rejected',
      capability: { providerId: 'flow', capabilityId: 'noop' },
      ports: [{ id: 'value', direction: 'input', required: true }],
    },
  ],
  edges: [
    {
      id: 'accepted-edge',
      source: { nodeId: 'source', portId: 'value' },
      target: { nodeId: 'accepted', portId: 'value' },
      condition: { kind: 'value', path: '/approved', equals: true },
    },
    {
      id: 'rejected-edge',
      source: { nodeId: 'source', portId: 'value' },
      target: { nodeId: 'rejected', portId: 'value' },
      condition: { kind: 'value', path: '/approved', equals: false },
    },
  ],
};

describe('single-process Flow execution', () => {
  test('executes a typed branching graph deterministically', async () => {
    const graph = compileFlowGraph(branchingDefinition, registry);
    const result = await executeFlowAsync(
      graph,
      registry,
      { runId: 'run-1', triggerId: 'manual' },
      clock,
    );

    expect(result.run.status).toBe('succeeded');
    expect(result.run.steps.map((step) => step.nodeId)).toEqual(['source', 'accepted']);
    expect(result.run.steps[0]?.output).toEqual({
      value: { kind: 'inline', value: { approved: true } },
    });
  });

  test('rejects invalid graphs before an operation can run', () => {
    const cyclic = {
      ...branchingDefinition,
      edges: [
        ...branchingDefinition.edges,
        {
          id: 'cycle',
          source: { nodeId: 'accepted', portId: 'value' },
          target: { nodeId: 'source', portId: 'value' },
        },
      ],
    };
    expect(() => compileFlowGraph(cyclic, registry)).toThrow('FLOW_GRAPH_INVALID_EDGE_PORT:cycle');
    expect(() =>
      compileFlowGraph(
        {
          ...branchingDefinition,
          nodes: [
            { id: 'unsafe', capability: { providerId: 'flow', capabilityId: 'code' }, ports: [] },
          ],
          edges: [],
        },
        registry,
      ),
    ).toThrow('FLOW_CODE_EXECUTION_DISABLED');
  });

  test('returns a structured failure for an output outside its port schema', async () => {
    const definition: FlowDefinition = {
      id: 'typed',
      version: 1,
      title: 'Typed',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'typed-node',
          capability: { providerId: 'test', capabilityId: 'bad' },
          ports: [{ id: 'count', direction: 'output', data: { schema: { type: 'integer' } } }],
        },
      ],
    };
    const bad = {
      bad: {
        executeAsync: async () => ({
          output: { count: { kind: 'inline' as const, value: 'wrong' } },
        }),
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, bad),
      bad,
      { runId: 'run-typed', triggerId: 'manual' },
      clock,
    );
    expect(result.run.status).toBe('failed');
    expect(result.run.steps[0]?.error?.code).toBe('FLOW_PORT_SCHEMA_MISMATCH');
  });
});
