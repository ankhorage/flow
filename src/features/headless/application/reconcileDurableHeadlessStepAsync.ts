import type { FlowDurableRun, FlowDurableWork } from '../../../types/durableExecution.js';
import type { FlowRuntimeDependencies } from '../../../types/headless.js';
import { executeDurableHeadlessStepAsync } from './executeDurableHeadlessStepAsync.js';

/** Rebuild a protected step from its provider receipt before recovery finalizes its durable plan. */
export const reconcileDurableHeadlessStepAsync = async (
  input: { readonly run: FlowDurableRun; readonly work: FlowDurableWork },
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
) => {
  if (input.run.scope === undefined) throw new Error('FLOW_DURABLE_SCOPE_MISSING');
  const revision = await dependencies.store.getWorkflowAsync(
    input.run.scope,
    input.run.flow.id,
    input.run.flow.version,
  );
  if (revision === undefined) throw new Error('FLOW_WORKFLOW_VERSION_MISSING');
  return executeDurableHeadlessStepAsync(
    {
      definition: revision.definition,
      durableRun: input.run,
      reconcile: true,
      registry: dependencies.nodeRegistry,
      work: input.work,
    },
    clock,
  );
};
