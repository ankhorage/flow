import { expect, test } from 'bun:test';

import {
  executeAiNodeAsync,
  executeBoundedAgentAsync,
  FlowAiError,
  type FlowAiExecutionInput,
  type FlowAiModelPort,
} from '../src/ai.js';
import type { FlowSecurityPort } from '../src/index.js';

const schema = <T>(guard: (value: unknown) => value is T) => ({
  parse: (value: unknown): T => {
    if (!guard(value)) throw new Error('invalid');
    return value;
  },
});

const outputSchema = schema(
  (value): value is { readonly answer: string } =>
    typeof value === 'object' &&
    value !== null &&
    'answer' in value &&
    typeof value.answer === 'string',
);

const security = (permitted = true): FlowSecurityPort => ({
  authorizeAsync: async (operation) => {
    if (!permitted)
      throw new FlowAiError('tool_denied', 'The security boundary denied this operation.');
    return {
      operation: {
        actor: operation.actor,
        capability: operation.capability,
        idempotencyKey: operation.idempotencyKey,
        operationId: operation.operationId,
        secretRefs: operation.secretRefs ?? [],
      },
      executeAsync: async (callback) =>
        callback({ 'providers/fake': { token: 'SENTINEL_SECRET' } }),
    };
  },
  createSecretAsync: async () => {
    throw new Error('unused');
  },
  getSecretMetadataAsync: async () => {
    throw new Error('unused');
  },
  revokeSecretAsync: async () => {
    throw new Error('unused');
  },
});

const input = (
  model: FlowAiModelPort,
): FlowAiExecutionInput<unknown, { readonly answer: string }> => ({
  budget: { maxCostMicros: 10, maxOutputTokens: 10 },
  input: {
    context: { request: 'test' },
    prompt: 'answer',
    settings: { provider: 'fake', model: 'test' },
  },
  model,
  output: outputSchema,
  security: {
    actor: { id: 'actor', tenantId: 'tenant', projectId: 'project', environment: 'test' },
    idempotencyKey: 'key',
    operationId: 'operation',
    secretRefs: ['providers/fake'],
  },
  timeoutMs: 100,
});

const provider = (events: readonly unknown[]): FlowAiModelPort => ({
  streamAsync: async function* () {
    for (const event of events) yield event as never;
  },
});

test('streams typed output and redaction-safe telemetry through the provider-neutral port', async () => {
  const progress: unknown[] = [];
  const result = await executeAiNodeAsync(security(), {
    ...input(
      provider([
        { type: 'text', text: '{"answer":"' },
        { type: 'text', text: 'done"}' },
        { type: 'telemetry', telemetry: { inputTokens: 2, outputTokens: 3, costMicros: 4 } },
      ]),
    ),
    onProgressAsync: async (event) => {
      progress.push(event);
    },
  });
  expect(result).toEqual({
    attempts: 1,
    output: { answer: 'done' },
    telemetry: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
    text: '{"answer":"done"}',
  });
  expect(JSON.stringify(progress)).not.toContain('SENTINEL_SECRET');
});

test('fails closed for malformed JSON, quota, provider redaction, and budget overflow', async () => {
  await expect(
    executeAiNodeAsync(security(), input(provider([{ type: 'text', text: '{' }]))),
  ).rejects.toMatchObject({
    code: 'invalid_output',
  });
  const quota: FlowAiModelPort = {
    streamAsync: async function* () {
      throw { code: 'quota', detail: 'SENTINEL_SECRET' };
    },
  };
  await expect(executeAiNodeAsync(security(), input(quota))).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  const redacted: FlowAiModelPort = {
    streamAsync: async function* () {
      throw new Error('SENTINEL_SECRET');
    },
  };
  await expect(executeAiNodeAsync(security(), input(redacted))).rejects.not.toThrow(
    'SENTINEL_SECRET',
  );
  await expect(
    executeAiNodeAsync(
      security(),
      input(
        provider([
          { type: 'telemetry', telemetry: { inputTokens: 1, outputTokens: 11, costMicros: 1 } },
        ]),
      ),
    ),
  ).rejects.toMatchObject({ code: 'budget_exceeded' });
});

test('retries only retryable provider failures and propagates denial, timeout, and cancellation', async () => {
  let calls = 0;
  const retrying: FlowAiModelPort = {
    streamAsync: async function* () {
      calls += 1;
      if (calls === 1) throw { retryable: true };
      yield { type: 'output', value: { answer: 'retried' } };
    },
  };
  await expect(
    executeAiNodeAsync(security(), { ...input(retrying), retry: { maxAttempts: 2 } }),
  ).resolves.toMatchObject({ attempts: 2, output: { answer: 'retried' } });
  await expect(executeAiNodeAsync(security(false), input(retrying))).rejects.toMatchObject({
    code: 'tool_denied',
  });
  const waiting: FlowAiModelPort = {
    streamAsync: async function* ({ signal }) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  };
  await expect(
    executeAiNodeAsync(security(), { ...input(waiting), timeoutMs: 1 }),
  ).rejects.toBeInstanceOf(FlowAiError);
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeAiNodeAsync(security(), { ...input(waiting), signal: controller.signal }),
  ).rejects.toMatchObject({
    code: 'cancelled',
  });
});

test('returns stable timeout and cancellation errors when a provider ignores aborts indefinitely', async () => {
  const stalled: FlowAiModelPort = {
    streamAsync: async function* () {
      await new Promise<never>(() => undefined);
    },
  };
  await expect(
    executeAiNodeAsync(security(), { ...input(stalled), timeoutMs: 10 }),
  ).rejects.toMatchObject({ code: 'timed_out' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await expect(
    executeAiNodeAsync(security(), { ...input(stalled), signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'cancelled' });
});

test('enforces one cumulative budget across retries and rejects invalid provider telemetry', async () => {
  let calls = 0;
  const retrying: FlowAiModelPort = {
    streamAsync: async function* () {
      calls += 1;
      yield { type: 'telemetry', telemetry: { costMicros: 6, inputTokens: 1, outputTokens: 6 } };
      if (calls === 1) throw { retryable: true };
      yield { type: 'output', value: { answer: 'never' } };
    },
  };
  await expect(
    executeAiNodeAsync(security(), { ...input(retrying), retry: { maxAttempts: 2 } }),
  ).rejects.toMatchObject({ code: 'budget_exceeded' });
  expect(calls).toBe(2);
  for (const telemetry of [
    { costMicros: -1, inputTokens: 0, outputTokens: 0 },
    { costMicros: Number.NaN, inputTokens: 0, outputTokens: 0 },
    { costMicros: 0, inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 },
    { costMicros: 0.5, inputTokens: 0, outputTokens: 0 },
    { costMicros: 'invalid', inputTokens: 0, outputTokens: 0 },
  ])
    await expect(
      executeAiNodeAsync(security(), input(provider([{ type: 'telemetry', telemetry }]))),
    ).rejects.toMatchObject({ code: 'provider_failure' });
});

test('bounds agent steps, requires security approval, and rejects tools outside its explicit allowlist', async () => {
  const agentInput = {
    allowedTools: ['echo'],
    maxSteps: 2,
    output: outputSchema,
    planner: {
      nextAsync: async () => ({ type: 'tool' as const, name: 'unsafe', arguments: {} }),
    },
    security: input(provider([])).security,
    securityPort: security(),
    tools: [{ name: 'echo', invokeAsync: async () => ({ answer: 'unused' }) }],
  };
  await expect(executeBoundedAgentAsync(agentInput)).rejects.toMatchObject({ code: 'tool_denied' });
  await expect(
    executeBoundedAgentAsync({
      ...agentInput,
      planner: { nextAsync: async () => ({ type: 'tool' as const, name: 'echo', arguments: {} }) },
      securityPort: security(false),
    }),
  ).rejects.toMatchObject({ code: 'tool_denied' });
});
