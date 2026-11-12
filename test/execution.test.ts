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
    expect(() =>
      compileFlowGraph(
        {
          ...branchingDefinition,
          nodes: [
            {
              id: 'left',
              capability: { providerId: 'flow', capabilityId: 'noop' },
              ports: [
                { id: 'in', direction: 'input' },
                { id: 'out', direction: 'output' },
              ],
            },
            {
              id: 'right',
              capability: { providerId: 'flow', capabilityId: 'noop' },
              ports: [
                { id: 'in', direction: 'input' },
                { id: 'out', direction: 'output' },
              ],
            },
          ],
          edges: [
            {
              id: 'left-right',
              source: { nodeId: 'left', portId: 'out' },
              target: { nodeId: 'right', portId: 'in' },
            },
            {
              id: 'right-left',
              source: { nodeId: 'right', portId: 'out' },
              target: { nodeId: 'left', portId: 'in' },
            },
          ],
        },
        registry,
      ),
    ).toThrow('FLOW_GRAPH_CYCLE');
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
      'test:bad': {
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

  test('validates nested schemas and resolves declared schema references', async () => {
    const definition: FlowDefinition = {
      id: 'nested-schema',
      version: 1,
      title: 'Nested schema',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'emit',
          capability: { providerId: 'test', capabilityId: 'emit' },
          ports: [{ id: 'value', direction: 'output', data: { schemaRef: { id: 'person' } } }],
        },
      ],
    };
    const operations = {
      'test:emit': {
        executeAsync: async () => ({
          output: { value: { kind: 'inline' as const, value: { name: 'Ada', tags: ['flow'] } } },
        }),
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      {
        runId: 'nested',
        triggerId: 'manual',
        schemaRegistry: {
          person: {
            type: 'object',
            required: ['name', 'tags'],
            properties: {
              name: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      clock,
    );
    expect(result.run.status).toBe('succeeded');
  });

  test('rejects invalid nested data resolved through a schema reference', async () => {
    const definition: FlowDefinition = {
      id: 'invalid-nested',
      version: 1,
      title: 'Invalid nested',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'emit',
          capability: { providerId: 'test', capabilityId: 'invalid-nested' },
          ports: [{ id: 'value', direction: 'output', data: { schemaRef: { id: 'person' } } }],
        },
      ],
    };
    const operations = {
      'test:invalid-nested': {
        executeAsync: async () => ({
          output: { value: { kind: 'inline' as const, value: { name: 'Ada', tags: [1] } } },
        }),
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      {
        runId: 'invalid-nested',
        triggerId: 'manual',
        schemaRegistry: {
          person: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      clock,
    );
    expect(result.run.steps[0]?.error?.code).toBe('FLOW_PORT_SCHEMA_MISMATCH');
  });

  test('fails closed for unresolved references and unsupported schema constraints', async () => {
    const definition: FlowDefinition = {
      id: 'unsupported-schema',
      version: 1,
      title: 'Unsupported schema',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'emit',
          capability: { providerId: 'test', capabilityId: 'emit' },
          ports: [{ id: 'value', direction: 'output', data: { schema: { format: 'email' } } }],
        },
      ],
    };
    const operations = {
      'test:emit': {
        executeAsync: async () => ({
          output: { value: { kind: 'inline' as const, value: 'value' } },
        }),
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      { runId: 'unsupported', triggerId: 'manual' },
      clock,
    );
    expect(result.run.steps[0]?.error?.code).toBe('FLOW_SCHEMA_UNSUPPORTED_CONSTRAINT');
  });

  test('resolves operations by provider-qualified capability', () => {
    expect(() =>
      compileFlowGraph(
        {
          ...branchingDefinition,
          nodes: [
            { id: 'node', capability: { providerId: 'other', capabilityId: 'noop' }, ports: [] },
          ],
          edges: [],
        },
        registry,
      ),
    ).toThrow('FLOW_OPERATION_UNREGISTERED:other:noop');
  });

  test('executes a failure branch before returning the failed run', async () => {
    const calls: string[] = [];
    const definition: FlowDefinition = {
      id: 'failure-branch',
      version: 1,
      title: 'Failure branch',
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'fail',
          capability: { providerId: 'test', capabilityId: 'fail' },
          ports: [{ id: 'out', direction: 'output' }],
        },
        { id: 'recover', capability: { providerId: 'test', capabilityId: 'recover' }, ports: [] },
      ],
      edges: [
        {
          id: 'failure',
          source: { nodeId: 'fail', portId: 'out' },
          target: { nodeId: 'recover', portId: 'ignored' },
          condition: { kind: 'outcome', outcome: 'failure' },
        },
      ],
    };
    const operations = {
      'test:fail': {
        executeAsync: async () => {
          throw new Error('FLOW_OPERATION_FAILED: secret');
        },
      },
      'test:recover': {
        executeAsync: async () => {
          calls.push('recover');
          return {};
        },
      },
    };
    const repairedDefinition = {
      ...definition,
      nodes: [
        definition.nodes[0]!,
        { ...definition.nodes[1]!, ports: [{ id: 'ignored', direction: 'input' as const }] },
      ],
    } satisfies FlowDefinition;
    const result = await executeFlowAsync(
      compileFlowGraph(repairedDefinition, operations),
      operations,
      { runId: 'failure', triggerId: 'manual' },
      clock,
    );
    expect([result.run.status, calls]).toEqual(['failed', ['recover']]);
  });

  test('redacts host error messages and requires declared outputs', async () => {
    const definition: FlowDefinition = {
      id: 'redaction',
      version: 1,
      title: 'Redaction',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'node',
          capability: { providerId: 'test', capabilityId: 'secret' },
          ports: [{ id: 'required', direction: 'output', required: true }],
        },
      ],
    };
    const operations = {
      'test:secret': {
        executeAsync: async () => {
          throw new Error('credential top-secret-value');
        },
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      { runId: 'redaction', triggerId: 'manual' },
      clock,
    );
    expect(result.run.steps[0]?.error).toEqual({
      code: 'FLOW_OPERATION_FAILED',
      message: 'The operation failed.',
      retryable: false,
    });
  });

  test('fails an operation that omits a required output', async () => {
    const definition: FlowDefinition = {
      id: 'required-output',
      version: 1,
      title: 'Required output',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'node',
          capability: { providerId: 'test', capabilityId: 'empty' },
          ports: [{ id: 'required', direction: 'output', required: true }],
        },
      ],
    };
    const operations = { 'test:empty': { executeAsync: async () => ({ output: {} }) } };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      { runId: 'required-output', triggerId: 'manual' },
      clock,
    );
    expect(result.run.steps[0]?.error?.code).toBe('FLOW_OUTPUT_REQUIRED_PORT_MISSING');
  });

  test('does not execute nodes whose required input was not propagated', async () => {
    const definition: FlowDefinition = {
      id: 'skipped',
      version: 1,
      title: 'Skipped',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        {
          id: 'node',
          capability: { providerId: 'test', capabilityId: 'required-input' },
          ports: [{ id: 'value', direction: 'input', required: true }],
        },
      ],
    };
    const operations = { 'test:required-input': { executeAsync: async () => ({ output: {} }) } };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      { runId: 'skipped', triggerId: 'manual' },
      clock,
    );
    expect(result.run.steps).toEqual([]);
  });

  test('records cancellation that occurs during asynchronous node execution', async () => {
    const controller = new AbortController();
    const definition: FlowDefinition = {
      id: 'cancel',
      version: 1,
      title: 'Cancel',
      edges: [],
      triggers: [{ id: 'manual', kind: 'manual' }],
      nodes: [
        { id: 'node', capability: { providerId: 'test', capabilityId: 'cancel' }, ports: [] },
      ],
    };
    const operations = {
      'test:cancel': {
        executeAsync: async () => {
          controller.abort();
          return {};
        },
      },
    };
    const result = await executeFlowAsync(
      compileFlowGraph(definition, operations),
      operations,
      { runId: 'cancel', triggerId: 'manual', signal: controller.signal },
      clock,
    );
    expect(result.run.status).toBe('cancelled');
  });
});
