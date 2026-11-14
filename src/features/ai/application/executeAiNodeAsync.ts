import type {
  FlowAiExecutionInput,
  FlowAiModelEvent,
  FlowAiResult,
  FlowAiTelemetry,
} from '../../../types/ai.js';
import type { FlowSecurityPort } from '../../../types/security.js';
import { FlowAiError } from '../FlowAiError.js';

/** Executes a typed, streamed AI node through the canonical Flow security and secret boundary. */
export const executeAiNodeAsync = async <TContext, TOutput>(
  securityPort: FlowSecurityPort,
  input: FlowAiExecutionInput<TContext, TOutput>,
): Promise<FlowAiResult<TOutput>> => {
  validateExecutionInput(input);
  const permit = await securityPort.authorizeAsync({
    actor: input.security.actor,
    capability: `ai:${input.input.settings.provider}:${input.input.settings.model}`,
    idempotencyKey: input.security.idempotencyKey,
    operationId: input.security.operationId,
    secretRefs: input.security.secretRefs,
  });
  return permit.executeAsync(async (credentials) => executePermittedAsync(input, credentials));
};

/** Runs retries only around an unconsumed stream attempt and preserves one shared budget. */
const executePermittedAsync = async <TContext, TOutput>(
  input: FlowAiExecutionInput<TContext, TOutput>,
  credentials: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<FlowAiResult<TOutput>> => {
  const attempts = input.retry?.maxAttempts ?? 1;
  const telemetry = emptyTelemetry();
  for (const attempt of Array.from({ length: attempts }, (_, index) => index + 1)) {
    try {
      return await streamAttemptAsync(input, credentials, telemetry, attempt);
    } catch (error) {
      if (!isRetryable(error) || attempt === attempts) throw toFlowAiError(error);
      await input.onProgressAsync?.({ type: 'retry', attempt });
    }
  }
  throw new FlowAiError('provider_failure', 'The AI provider did not produce an output.');
};

/** Consumes exactly one provider stream while propagating cancellation and timeout. */
const streamAttemptAsync = async <TContext, TOutput>(
  input: FlowAiExecutionInput<TContext, TOutput>,
  credentials: Readonly<Record<string, Readonly<Record<string, string>>>>,
  telemetry: FlowAiTelemetry,
  attempt: number,
): Promise<FlowAiResult<TOutput>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  try {
    if (signal.aborted) throw abortError(controller, input.signal);
    const stream = consumeStreamAsync(input, credentials, signal, telemetry);
    try {
      return await awaitStreamOrAbortAsync(stream, signal, () =>
        abortError(controller, input.signal),
      ).then(({ output, text }) => ({ attempts: attempt, output, telemetry, text }));
    } finally {
      void stream.catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
  }
};

/** Consumes a provider iterator without granting it control over the caller's cancellation deadline. */
const consumeStreamAsync = async <TContext, TOutput>(
  input: FlowAiExecutionInput<TContext, TOutput>,
  credentials: Readonly<Record<string, Readonly<Record<string, string>>>>,
  signal: AbortSignal,
  telemetry: FlowAiTelemetry,
): Promise<{ readonly output: TOutput; readonly text: string }> => {
  const state = { attemptTelemetry: emptyTelemetry(), output: undefined as unknown, text: '' };
  for await (const event of input.model.streamAsync({
    context: input.input.context,
    credentials,
    prompt: input.input.prompt,
    settings: input.input.settings,
    signal,
  }))
    await applyEventAsync(input, state, telemetry, event);
  if (signal.aborted) throw new FlowAiError('cancelled', 'The AI operation was cancelled.');
  return { output: parseOutput(input, state.output, state.text), text: state.text };
};

/** Returns the stream result or promptly returns the stable error when its controlling signal aborts. */
const awaitStreamOrAbortAsync = async <T>(
  stream: Promise<T>,
  signal: AbortSignal,
  error: () => FlowAiError,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = () => {
      const abortError = error();
      reject(abortError);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void stream.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (streamError: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(toProviderError(streamError));
      },
    );
  });

/** Applies one trusted provider event without allowing it to exceed the configured budget. */
const applyEventAsync = async <TContext, TOutput>(
  input: FlowAiExecutionInput<TContext, TOutput>,
  state: { attemptTelemetry: FlowAiTelemetry; output: unknown; text: string },
  telemetry: FlowAiTelemetry,
  event: FlowAiModelEvent,
): Promise<void> => {
  if (event.type === 'text') {
    state.text += event.text;
    await input.onProgressAsync?.(event);
    return;
  }
  if (event.type === 'output') {
    state.output = event.value;
    return;
  }
  validateTelemetry(event.telemetry, state.attemptTelemetry);
  const cumulative = addTelemetry(
    telemetry,
    subtractTelemetry(event.telemetry, state.attemptTelemetry),
  );
  assertBudget(input.budget, cumulative);
  state.attemptTelemetry = event.telemetry;
  assignTelemetry(telemetry, cumulative);
  await input.onProgressAsync?.(event);
};

/** Parses an explicit structured event or the final text as JSON through the caller schema. */
const parseOutput = <TContext, TOutput>(
  input: FlowAiExecutionInput<TContext, TOutput>,
  explicitOutput: unknown,
  text: string,
): TOutput => {
  try {
    return input.output.parse(explicitOutput === undefined ? JSON.parse(text) : explicitOutput);
  } catch {
    throw new FlowAiError(
      'invalid_output',
      'The AI provider returned malformed structured output.',
    );
  }
};

/** Requires positive finite execution limits before an external provider can start. */
const validateExecutionInput = (input: FlowAiExecutionInput<unknown, unknown>): void => {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    throw new FlowAiError('timed_out', 'AI timeout must be positive.');
  if (input.retry && (!Number.isInteger(input.retry.maxAttempts) || input.retry.maxAttempts < 1))
    throw new FlowAiError('provider_failure', 'AI retry attempts must be a positive integer.');
  if (
    !Number.isSafeInteger(input.budget.maxCostMicros) ||
    !Number.isSafeInteger(input.budget.maxOutputTokens) ||
    input.budget.maxCostMicros < 0 ||
    input.budget.maxOutputTokens < 0
  )
    throw new FlowAiError('budget_exceeded', 'AI budgets must be finite non-negative values.');
};

/** Rejects usage at the first provider report that crosses a hard budget. */
const assertBudget = (
  budget: FlowAiExecutionInput<unknown, unknown>['budget'],
  telemetry: FlowAiTelemetry,
): void => {
  if (
    telemetry.costMicros > budget.maxCostMicros ||
    telemetry.outputTokens > budget.maxOutputTokens
  )
    throw new FlowAiError('budget_exceeded', 'The AI node exceeded its configured budget.');
};

/** Rejects malformed provider usage and decreases within one retry attempt. */
const validateTelemetry = (telemetry: FlowAiTelemetry, previous: FlowAiTelemetry): void => {
  if (
    !Number.isSafeInteger(telemetry.costMicros) ||
    !Number.isSafeInteger(telemetry.inputTokens) ||
    !Number.isSafeInteger(telemetry.outputTokens) ||
    telemetry.costMicros < 0 ||
    telemetry.inputTokens < 0 ||
    telemetry.outputTokens < 0 ||
    telemetry.costMicros < previous.costMicros ||
    telemetry.inputTokens < previous.inputTokens ||
    telemetry.outputTokens < previous.outputTokens
  )
    throw new FlowAiError('provider_failure', 'The AI provider returned invalid usage telemetry.');
};

/** Calculates one monotonic provider observation's contribution to the execution-wide total. */
const subtractTelemetry = (
  telemetry: FlowAiTelemetry,
  previous: FlowAiTelemetry,
): FlowAiTelemetry => ({
  costMicros: telemetry.costMicros - previous.costMicros,
  inputTokens: telemetry.inputTokens - previous.inputTokens,
  outputTokens: telemetry.outputTokens - previous.outputTokens,
});

/** Adds validated provider usage to the retry-wide total. */
const addTelemetry = (left: FlowAiTelemetry, right: FlowAiTelemetry): FlowAiTelemetry => ({
  costMicros: left.costMicros + right.costMicros,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
});

/** Updates the locally owned retry-wide accumulator after its replacement value passed validation. */
const assignTelemetry = (target: FlowAiTelemetry, source: FlowAiTelemetry): void => {
  Object.assign(target, source);
};

/** Creates zero-valued telemetry that cannot contain provider metadata or secrets. */
const emptyTelemetry = (): FlowAiTelemetry => ({ costMicros: 0, inputTokens: 0, outputTokens: 0 });

/** Distinguishes intentional provider retry signals without exposing provider response bodies. */
const isRetryable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;

/** Preserves the provider's narrow retry and quota classifications while keeping Promise rejection safe. */
const toProviderError = (
  value: unknown,
): Error & { readonly code?: string; readonly retryable?: true } => {
  if (value instanceof Error) return value;
  const error = new Error('The AI provider stream failed.');
  if (typeof value !== 'object' || value === null) return error;
  return Object.assign(error, {
    ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
    ...('retryable' in value && value.retryable === true ? { retryable: true as const } : {}),
  });
};

/** Maps cancellation and provider failures to stable public errors with no provider payload. */
const toFlowAiError = (error: unknown): FlowAiError => {
  if (error instanceof FlowAiError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'quota')
    return new FlowAiError('quota_exceeded', 'The AI provider quota was exceeded.');
  return new FlowAiError('provider_failure', 'The AI provider request failed.');
};

/** Converts an aborted execution into its caller-visible timeout or cancellation result. */
const abortError = (controller: AbortController, signal: AbortSignal | undefined): FlowAiError =>
  controller.signal.aborted
    ? new FlowAiError('timed_out', 'The AI operation timed out.')
    : signal?.aborted
      ? new FlowAiError('cancelled', 'The AI operation was cancelled.')
      : new FlowAiError('cancelled', 'The AI operation was cancelled.');
