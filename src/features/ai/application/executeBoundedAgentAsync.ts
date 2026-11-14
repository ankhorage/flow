import type { FlowAiAgentExecutionInput } from '../../../types/ai.js';
import { FlowAiError } from '../FlowAiError.js';

/** Executes a deterministic agent plan with an exact tool allowlist and a hard step bound. */
export const executeBoundedAgentAsync = async <T>(
  input: FlowAiAgentExecutionInput<T>,
): Promise<T> => {
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  if (!Number.isInteger(input.maxSteps) || input.maxSteps < 1)
    throw new FlowAiError('agent_step_limit', 'Agent maxSteps must be a positive integer.');
  const allowed = new Set(input.allowedTools);
  if ([...allowed].some((name) => !tools.has(name)))
    throw new FlowAiError('tool_denied', 'An agent allowlist contains an unavailable tool.');
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const history: { readonly name: string; readonly result: unknown }[] = [];
  for (const step of Array.from({ length: input.maxSteps }, (_, index) => index + 1)) {
    if (signal.aborted) throw new FlowAiError('cancelled', 'The agent operation was cancelled.');
    const next = await input.planner.nextAsync({ signal, steps: history, tools: [...allowed] });
    if (next.type === 'final') {
      try {
        return input.output.parse(next.output);
      } catch {
        throw new FlowAiError('invalid_output', 'The agent returned malformed structured output.');
      }
    }
    if (!allowed.has(next.name))
      throw new FlowAiError('tool_denied', 'The requested agent tool is not allowlisted.');
    const tool = tools.get(next.name);
    if (!tool) throw new FlowAiError('tool_denied', 'The requested agent tool is unavailable.');
    const permit = await input.securityPort.authorizeAsync({
      actor: input.security.actor,
      capability: `ai:tool:${next.name}`,
      idempotencyKey: `${input.security.idempotencyKey}:${step}`,
      operationId: `${input.security.operationId}:${step}`,
      secretRefs: input.security.secretRefs,
    });
    const result = await permit.executeAsync(async () =>
      tool.invokeAsync({ arguments: next.arguments, signal }),
    );
    history.push({ name: next.name, result });
  }
  throw new FlowAiError('agent_step_limit', 'The agent exceeded its configured step limit.');
};
