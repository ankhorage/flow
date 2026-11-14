import type { FlowDefinition, FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type {
  FlowHttpAccessPort,
  FlowHttpAuthenticatorPort,
  FlowRunEvent,
  FlowRuntime,
} from '../../../types/headless.js';
import type { FlowSecurityActor } from '../../../types/security.js';
import { createFlowOpenApi } from './createFlowOpenApi.js';

/*** Create the authenticated HTTP adapter for the canonical headless Flow command boundary. */
export const createFlowHttpHandler =
  (input: {
    readonly access: FlowHttpAccessPort;
    readonly authenticator: FlowHttpAuthenticatorPort;
    readonly runtime: FlowRuntime;
  }): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/openapi.json')
      return json(200, createFlowOpenApi());
    const actor = await input.authenticator.authenticateAsync(request);
    if (!actor) return error(401, 'FLOW_UNAUTHENTICATED');
    const capability = capabilityFor(request.method, url.pathname);
    if (!capability || !(await input.access.authorizeAsync({ actor, capability })))
      return error(403, 'FLOW_FORBIDDEN');
    if (!(await input.access.acquireAsync({ actor, capability })))
      return error(429, 'FLOW_RATE_LIMITED');
    try {
      return await routeAsync(request, url, input.runtime, actor);
    } catch {
      return error(400, 'FLOW_INVALID_REQUEST');
    }
  };

/*** Translate HTTP shapes without leaking transport details into the runtime. */
const routeAsync = async (
  request: Request,
  url: URL,
  runtime: FlowRuntime,
  actor: FlowSecurityActor,
): Promise<Response> => {
  const segments = url.pathname.split('/').filter(Boolean);
  const responders = [
    routeWorkflowAsync,
    routeWebhookAsync,
    routeRunAsync,
    routeEventsAsync,
    routeApprovalAsync,
  ];
  for (const respondAsync of responders) {
    const response = await respondAsync(request, url, segments, runtime, actor);
    if (response !== undefined) return response;
  }
  return error(404, 'FLOW_ROUTE_NOT_FOUND');
};

type RouteResponder = (
  request: Request,
  url: URL,
  segments: readonly string[],
  runtime: FlowRuntime,
  actor: FlowSecurityActor,
) => Promise<Response | undefined>;

/** Route definition commands without mixing them with run and event transport concerns. */
const routeWorkflowAsync: RouteResponder = async (request, url, segments, runtime, actor) => {
  if (matches(request, url, 'POST', /^\/v1\/workflows$/u))
    return json(
      201,
      await runtime.createDraftAsync(scope(actor), await body<FlowDefinition>(request)),
    );
  if (matches(request, url, 'GET', /^\/v1\/workflows\/[^/]+$/u))
    return value(await runtime.getWorkflowAsync(scope(actor), segments[2] ?? ''));
  if (matches(request, url, 'GET', /^\/v1\/workflows\/[^/]+\/\d+$/u))
    return value(
      await runtime.getWorkflowAsync(scope(actor), segments[2] ?? '', number(segments[3])),
    );
  if (matches(request, url, 'POST', /^\/v1\/workflows\/[^/]+\/\d+\/publish$/u))
    return value(await runtime.publishAsync(scope(actor), segments[2] ?? '', number(segments[3])));
  if (matches(request, url, 'POST', /^\/v1\/workflows\/[^/]+\/triggers\/[^/]+$/u))
    return json(
      202,
      await runtime.triggerAsync({
        ...(await body<TriggerBody>(request)),
        flowId: segments[2] ?? '',
        scope: scope(actor),
        triggerId: segments[4] ?? '',
      }),
    );
  return undefined;
};

/** Route signed webhook deliveries through the same idempotent runtime command. */
const routeWebhookAsync: RouteResponder = async (request, _url, segments, runtime, actor) => {
  if (!matches(request, _url, 'POST', /^\/v1\/webhooks\/[^/]+\/[^/]+$/u)) return undefined;
  return json(
    202,
    await runtime.triggerAsync({
      ...(await body<TriggerBody>(request)),
      flowId: segments[2] ?? '',
      scope: scope(actor),
      triggerId: segments[3] ?? '',
    }),
  );
};

/** Route run lifecycle commands and return only redacted run observations. */
const routeRunAsync: RouteResponder = async (request, url, segments, runtime, actor) => {
  if (matches(request, url, 'GET', /^\/v1\/runs$/u))
    return json(
      200,
      (await runtime.listRunsAsync(scope(actor), url.searchParams.get('flowId') ?? undefined)).map(
        redactRun,
      ),
    );
  if (matches(request, url, 'GET', /^\/v1\/runs\/[^/]+$/u))
    return redactedValue(await runtime.getRunAsync(scope(actor), segments[2] ?? ''));
  if (matches(request, url, 'POST', /^\/v1\/runs\/[^/]+\/cancel$/u))
    return redactedValue(await runtime.cancelRunAsync(scope(actor), segments[2] ?? ''));
  if (matches(request, url, 'POST', /^\/v1\/runs\/[^/]+\/retry$/u))
    return redactedValue(await runtime.retryRunAsync(scope(actor), segments[2] ?? ''));
  return undefined;
};

/** Route finite SSE polling queries independently from client connection lifetime. */
const routeEventsAsync: RouteResponder = async (request, url, _segments, runtime, actor) => {
  if (request.method !== 'GET' || url.pathname !== '/v1/events') return undefined;
  return events(
    (
      await runtime.readEventsAsync(
        scope(actor),
        number(url.searchParams.get('after') ?? '0'),
        url.searchParams.get('runId') ?? undefined,
      )
    ).map(redactEvent),
  );
};

/** Route one actor-bound approval decision. */
const routeApprovalAsync: RouteResponder = async (request, _url, segments, runtime, actor) => {
  if (
    request.method === 'POST' &&
    segments[0] === 'v1' &&
    segments[1] === 'approvals' &&
    segments.length === 4
  )
    return value(
      await runtime.resolveApprovalAsync({
        actorId: actor.id,
        approvalId: segments[2] ?? '',
        approved: segments[3] === 'approve',
        scope: scope(actor),
      }),
    );
  return undefined;
};

/** Match a method and a fully constrained route before indexing its known path segments. */
const matches = (request: Request, url: URL, method: string, path: RegExp): boolean =>
  request.method === method && path.test(url.pathname);

/*** Define one small request DTO so transport input remains separate from Flow contracts. */
interface TriggerBody {
  readonly idempotencyKey: string;
  readonly input?: Record<string, { readonly kind: 'inline'; readonly value: never }>;
}

/*** Return the canonical redacted run projection; payloads and node I/O never cross this boundary. */
const redactRun = (run: FlowRunSnapshot) => ({
  ...run,
  input: undefined,
  output: undefined,
  steps: run.steps.map((step) => ({
    ...step,
    input: undefined,
    output: undefined,
    trace: redactTrace(step.trace),
  })),
  trace: redactTrace(run.trace),
});

/*** Preserve trace metadata while removing arbitrary attributes that could carry secret material. */
const redactTrace = (trace: FlowRunSnapshot['trace'] | undefined) =>
  trace?.map(({ level, timestamp }) => ({ level, message: 'Workflow trace event.', timestamp }));

const redactEvent = (event: FlowRunEvent): FlowRunEvent => ({
  ...event,
  ...(event.trace === undefined
    ? {}
    : { trace: { ...event.trace, message: 'Workflow trace event.' } }),
});

const scope = (actor: FlowSecurityActor) => ({
  projectId: actor.projectId,
  tenantId: actor.tenantId,
});

/*** Map route families to host-owned capability checks. */
const capabilityFor = (method: string, pathname: string): string | undefined =>
  pathname === '/health' || pathname === '/openapi.json'
    ? undefined
    : `${method.toLowerCase()}:${pathname.startsWith('/v1/webhooks') ? 'webhook' : pathname.split('/').slice(1, 3).join(':')}`;

/*** Parse only JSON request bodies and fail closed on malformed transport data. */
const body = async <Value>(request: Request): Promise<Value> => request.json() as Promise<Value>;

/*** Decode a non-negative integer path/query value. */
const number = (value: string | null | undefined): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('FLOW_INVALID_NUMBER');
  return parsed;
};

/*** Write a stable JSON response. */
const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status,
  });

/*** Return a stable envelope for public failures. */
const error = (status: number, code: string): Response => json(status, { error: { code } });

/*** Render a missing resource with the canonical stable error code. */
const value = (result: unknown): Response =>
  result === undefined ? error(404, 'FLOW_NOT_FOUND') : json(200, result);

/*** Apply the redaction contract before returning a single run. */
const redactedValue = (run: FlowRunSnapshot | undefined): Response =>
  run === undefined ? error(404, 'FLOW_NOT_FOUND') : json(200, redactRun(run));

/*** Render a finite polling response as Server-Sent Events for capability-compatible clients. */
const events = (values: readonly unknown[]): Response =>
  new Response(values.map((value) => `event: flow\ndata: ${JSON.stringify(value)}\n\n`).join(''), {
    headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
  });
