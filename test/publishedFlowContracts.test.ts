import '@ankhorage/contracts/flow';

import { expect, test } from 'bun:test';
import type {
  FlowApprovalRequest,
  FlowDefinition,
  FlowRunSnapshot,
  FlowStepSnapshot,
} from '@ankhorage/contracts/flow';

const definition: FlowDefinition = {
  id: 'meal-planning',
  version: 1,
  title: 'Meal planning',
  nodes: [
    {
      id: 'collect-preferences',
      capability: { providerId: 'recipes', capabilityId: 'preferences.collect' },
      config: {
        household: { kind: 'inline', value: { servings: 2 } },
        apiCredential: { kind: 'secret', ref: 'recipes-api-key' },
      },
      ports: [{ id: 'preferences', direction: 'output', required: true }],
    },
    {
      id: 'create-plan',
      capability: { providerId: 'recipes', capabilityId: 'plan.create' },
      ports: [
        { id: 'preferences', direction: 'input', required: true },
        { id: 'plan', direction: 'output' },
      ],
    },
  ],
  edges: [
    {
      id: 'preferences-to-plan',
      source: { nodeId: 'collect-preferences', portId: 'preferences' },
      target: { nodeId: 'create-plan', portId: 'preferences' },
      condition: { kind: 'value', path: '/servings', equals: 2 },
    },
  ],
  triggers: [
    { id: 'manual-start', kind: 'manual' },
    { id: 'weekday-plan', kind: 'schedule', cron: '0 8 * * 1-5', timezone: 'Etc/UTC' },
  ],
};

const step: FlowStepSnapshot = {
  id: 'step-1',
  nodeId: 'create-plan',
  status: 'succeeded',
  attempt: 1,
  input: { preferences: { kind: 'inline', value: { servings: 2 } } },
  output: { plan: { kind: 'artifact', artifactId: 'meal-plan', mediaType: 'application/json' } },
};

const run: FlowRunSnapshot = {
  id: 'run-1',
  flow: { id: definition.id, version: definition.version },
  status: 'waiting_for_approval',
  trigger: { triggerId: 'manual-start', kind: 'manual' },
  createdAt: '2026-11-12T08:00:00.000Z',
  steps: [step],
};

const approval: FlowApprovalRequest = {
  id: 'approval-1',
  runId: run.id,
  step: { runId: run.id, id: step.id, nodeId: step.nodeId, attempt: step.attempt },
  status: 'pending',
  requestedAt: '2026-11-12T08:01:00.000Z',
  context: { kind: 'inline', value: { planId: 'meal-plan' } },
};

test('consumes a published, serializable Flow graph and execution snapshots', () => {
  const serialized = JSON.stringify({ definition, run, approval });
  const restored = JSON.parse(serialized) as {
    readonly approval: FlowApprovalRequest;
    readonly definition: FlowDefinition;
    readonly run: FlowRunSnapshot;
  };

  expect(restored).toEqual({ definition, run, approval });
  expect(restored.definition.nodes[0]?.config?.apiCredential).toEqual({
    kind: 'secret',
    ref: 'recipes-api-key',
  });
  expect(restored.run.steps[0]?.output?.plan).toEqual({
    kind: 'artifact',
    artifactId: 'meal-plan',
    mediaType: 'application/json',
  });
  expect(restored.approval.step).toEqual({
    runId: 'run-1',
    id: 'step-1',
    nodeId: 'create-plan',
    attempt: 1,
  });
});

const invalidFlow: FlowDefinition = {
  ...definition,
  // @ts-expect-error Flow revisions are numeric.
  version: 'one',
};

void invalidFlow;
