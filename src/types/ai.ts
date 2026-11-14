import type { SecretRef } from '@ankhorage/contracts/secrets';

import type { FlowSecurityActor } from './security.js';
import type { FlowSecurityPort } from './security.js';

/** A portable schema boundary that keeps provider responses typed without coupling to a validator. */
export interface FlowAiSchema<T> {
  parse(value: unknown): T;
}

/** Provider-neutral model selection deliberately contains no credential material. */
export interface FlowAiModelSettings {
  readonly model: string;
  readonly provider: string;
}

/** Immutable input accepted by one AI node. */
export interface FlowAiInput<TContext = unknown> {
  readonly context: TContext;
  readonly prompt: string;
  readonly settings: FlowAiModelSettings;
}

/** A monotonic usage observation supplied by a provider while generating. */
export interface FlowAiTelemetry {
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Provider stream data. Output is intentionally unknown until the consumer schema accepts it. */
export type FlowAiModelEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'telemetry'; readonly telemetry: FlowAiTelemetry }
  | { readonly type: 'output'; readonly value: unknown };

/** The provider boundary; adapters may load SDKs, but Flow core never does. */
export interface FlowAiModelPort {
  streamAsync(input: {
    readonly context: unknown;
    readonly credentials: Readonly<Record<SecretRef, Readonly<Record<string, string>>>>;
    readonly prompt: string;
    readonly settings: FlowAiModelSettings;
    readonly signal: AbortSignal;
  }): AsyncIterable<FlowAiModelEvent>;
}

/** Hard per-node execution limits. */
export interface FlowAiBudget {
  readonly maxCostMicros: number;
  readonly maxOutputTokens: number;
}

/** Retry policy is bounded and applies only to provider-declared retryable failures. */
export interface FlowAiRetryPolicy {
  readonly maxAttempts: number;
}

/** Server-owned identity for AI secret resolution and approval. */
export interface FlowAiSecurityContext {
  readonly actor: FlowSecurityActor;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly secretRefs: readonly SecretRef[];
}

/** Observable, redaction-safe progress emitted during a node run. */
export type FlowAiProgress =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'telemetry'; readonly telemetry: FlowAiTelemetry }
  | { readonly type: 'retry'; readonly attempt: number };

/** Complete result of a typed AI node invocation. */
export interface FlowAiResult<T> {
  readonly attempts: number;
  readonly output: T;
  readonly telemetry: FlowAiTelemetry;
  readonly text: string;
}

/** Input to the AI use case. Raw credentials are deliberately absent. */
export interface FlowAiExecutionInput<TContext, TOutput> {
  readonly budget: FlowAiBudget;
  readonly input: FlowAiInput<TContext>;
  readonly model: FlowAiModelPort;
  readonly onProgressAsync?: (progress: FlowAiProgress) => Promise<void> | void;
  readonly output: FlowAiSchema<TOutput>;
  readonly retry?: FlowAiRetryPolicy;
  readonly security: FlowAiSecurityContext;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

/** A host tool that an agent may invoke only by its exact configured name. */
export interface FlowAiAgentToolPort {
  readonly name: string;
  invokeAsync(input: {
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** One deterministic agent action returned by a model-selected planner. */
export type FlowAiAgentStep =
  | { readonly type: 'final'; readonly output: unknown }
  | {
      readonly type: 'tool';
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly name: string;
    };

/** Planner boundary for bounded agent execution. */
export interface FlowAiAgentPlannerPort {
  nextAsync(input: {
    readonly signal: AbortSignal;
    readonly steps: readonly { readonly name: string; readonly result: unknown }[];
    readonly tools: readonly string[];
  }): Promise<FlowAiAgentStep>;
}

/** Explicit input for a bounded, allowlist-only agent. */
export interface FlowAiAgentExecutionInput<T> {
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
  readonly output: FlowAiSchema<T>;
  readonly planner: FlowAiAgentPlannerPort;
  readonly security: FlowAiSecurityContext;
  readonly securityPort: FlowSecurityPort;
  readonly signal?: AbortSignal;
  readonly tools: readonly FlowAiAgentToolPort[];
}
