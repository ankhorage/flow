import type { FlowDefinitionRef, FlowDurableRun } from '../../../types/durableExecution.js';

/*** Create a revision-zero run pinned permanently to one published flow definition. */
export const createDurableRun = (
  input: { readonly flow: FlowDefinitionRef; readonly id: string },
  now: Date,
): FlowDurableRun => ({
  createdAt: now.toISOString(),
  flow: { ...input.flow },
  id: input.id,
  revision: 0,
  status: 'queued',
  updatedAt: now.toISOString(),
});
