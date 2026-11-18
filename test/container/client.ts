const endpoint = 'http://flow-api:4318';
const authorization = { authorization: `Bearer ${process.env.FLOW_API_TOKEN}` };
const request = (path: string, input: RequestInit = {}): Promise<Response> =>
  fetch(`${endpoint}${path}`, input);
const definition = {
  edges: [],
  id: 'container-flow',
  nodes: [],
  title: 'Container Flow',
  triggers: [{ id: 'manual', kind: 'manual' }],
  version: 1,
};

const requireStatus = async (response: Response, status: number): Promise<Response> => {
  if (response.status !== status) throw new Error('FLOW_CONTAINER_HTTP_STATUS_UNEXPECTED');
  return response;
};

const mainAsync = async (): Promise<void> => {
  const mode = process.env.FLOW_CONTAINER_MODE;
  if (mode === 'health') return waitForHealthAsync();
  if (mode === 'reject-unauthorized-operation') return rejectUnauthorizedOperationAsync();
  if (mode === 'create-publish-trigger') return createPublishAndTriggerAsync();
  if (mode === 'trigger-recovery-run') return triggerRecoveryRunAsync();
  if (mode === 'wait-for-run') return waitForRunAsync();
  throw new Error('FLOW_CONTAINER_CLIENT_MODE_INVALID');
};

/** Verify the API is reachable over the Docker network from this distinct container namespace. */
const waitForHealthAsync = async (): Promise<void> => {
  for (const _attempt of Array.from({ length: 100 })) {
    if ((await request('/health')).ok) return;
    await Bun.sleep(50);
  }
  throw new Error('FLOW_CONTAINER_API_UNREACHABLE');
};

/** Ensure an unauthenticated client cannot perform a workflow mutation. */
const rejectUnauthorizedOperationAsync = async (): Promise<void> => {
  await requireStatus(
    await request('/v1/workflows', {
      body: JSON.stringify(definition),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    401,
  );
};

/** Create, publish, and queue durable work without coupling the API to a worker lifecycle. */
const createPublishAndTriggerAsync = async (): Promise<void> => {
  await requireStatus(
    await request('/v1/workflows', {
      body: JSON.stringify(definition),
      headers: { ...authorization, 'content-type': 'application/json' },
      method: 'POST',
    }),
    201,
  );
  await requireStatus(
    await request('/v1/workflows/container-flow/1/publish', {
      headers: authorization,
      method: 'POST',
    }),
    200,
  );
  await triggerAsync('initial');
};

/** Queue a second run after a worker shutdown so the restarted worker must recover it durably. */
const triggerRecoveryRunAsync = async (): Promise<void> => triggerAsync('recovery');

/** Trigger one API-authorized run and emit only its opaque identifier for the CI harness. */
const triggerAsync = async (idempotencyKey: string): Promise<void> => {
  const response = await requireStatus(
    await request('/v1/workflows/container-flow/triggers/manual', {
      body: JSON.stringify({ idempotencyKey }),
      headers: { ...authorization, 'content-type': 'application/json' },
      method: 'POST',
    }),
    202,
  );
  process.stdout.write(((await response.json()) as { readonly id: string }).id);
};

/** Poll durable state through the API until a separately started worker completes the queued run. */
const waitForRunAsync = async (): Promise<void> => {
  const runId = process.env.FLOW_RUN_ID;
  if (runId === undefined) throw new Error('FLOW_CONTAINER_RUN_ID_REQUIRED');
  for (const _attempt of Array.from({ length: 100 })) {
    const response = await request(`/v1/runs/${runId}`, { headers: authorization });
    if (
      response.ok &&
      ((await response.json()) as { readonly status: string }).status === 'succeeded'
    )
      return;
    await Bun.sleep(50);
  }
  throw new Error('FLOW_CONTAINER_DURABLE_RECOVERY_FAILED');
};

void mainAsync();
