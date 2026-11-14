import type { FlowDefinitionRef, FlowDurableRun } from '../../../types/durableExecution.js';
import type { FlowClock } from '../../../types/execution.js';
import type { FlowResourceScope } from '../../../types/headless.js';
import { createDurableRun } from '../domain/createDurableRun.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

/*** Persist a new durable run without executing an operation or provider effect. */
export const createDurableRunAsync = async (
  input: {
    readonly flow: FlowDefinitionRef;
    readonly id: string;
    readonly scope?: FlowResourceScope;
  },
  dependencies: { readonly clock: FlowClock; readonly persistence: FlowPersistencePort },
): Promise<FlowDurableRun> => {
  const run = {
    ...createDurableRun(input, dependencies.clock.now()),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  };
  await dependencies.persistence.createRunAsync(run);
  return run;
};
