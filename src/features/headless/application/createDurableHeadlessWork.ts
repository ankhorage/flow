import type { FlowDataRef, FlowNode } from '@ankhorage/contracts/flow';

import type { FlowDefinitionRef, FlowDurableWork } from '../../../types/durableExecution.js';
import type { FlowNodeRegistry } from '../../../types/execution.js';

/** Create one trusted, attempt-specific delivery whose provider effect identity remains stable. */
export const createDurableHeadlessWork = (input: {
  readonly attempt: number;
  readonly dueAt: string;
  readonly flow: FlowDefinitionRef;
  readonly input?: Readonly<Record<string, FlowDataRef>>;
  readonly node: FlowNode;
  readonly registry: FlowNodeRegistry;
  readonly runId: string;
  readonly triggerId: string;
}): FlowDurableWork => {
  const operation = nodeOperation(input.node, input.registry);
  const idempotencyKey = `${input.runId}:step:${input.node.id}`;
  const securityOperation =
    operation.effect.kind === 'protected'
      ? operation.effect.createSecurityOperation({
          effect: { idempotencyKey },
          node: input.node,
          runId: input.runId,
        })
      : undefined;
  if (
    securityOperation !== undefined &&
    (securityOperation.idempotencyKey !== idempotencyKey ||
      securityOperation.operationId !== idempotencyKey)
  )
    throw new Error('FLOW_PROTECTED_EFFECT_IDENTITY_INVALID');
  return {
    attempt: input.attempt,
    dueAt: input.dueAt,
    effectKind: operation.effect.kind,
    flow: input.flow,
    id: `${input.runId}:step:${input.node.id}:attempt:${input.attempt}`,
    idempotencyKey,
    ...(input.input === undefined ? {} : { input: input.input }),
    runId: input.runId,
    ...(securityOperation === undefined ? {} : { securityOperation }),
    status: 'ready',
    stepId: input.node.id,
    triggerId: input.triggerId,
  };
};

/** Resolve a provider operation only from the trusted composition registry, never graph configuration. */
const nodeOperation = (node: FlowNode, registry: FlowNodeRegistry) => {
  const operationId = `${node.capability.providerId}:${node.capability.capabilityId}`;
  const operation = Object.entries(registry).find(([id]) => id === operationId)?.[1];
  if (operation === undefined) throw new Error(`FLOW_OPERATION_UNREGISTERED:${operationId}`);
  return operation;
};
