/*** Build the authenticated HTTP contract implemented by the Flow headless adapter. */
export const createFlowOpenApi = () => ({
  components: {
    schemas: schemas(),
    securitySchemes: { bearerAuth: { scheme: 'bearer', type: 'http' } },
  },
  info: { title: 'Flow headless API', version: '1.0.0' },
  openapi: '3.1.0',
  paths: paths(),
});

/*** Describe the public redacted response and command payloads. */
const schemas = () => ({
  Error: {
    additionalProperties: false,
    properties: {
      error: { properties: { code: { type: 'string' } }, required: ['code'], type: 'object' },
    },
    required: ['error'],
    type: 'object',
  },
  FlowDefinition: {
    additionalProperties: false,
    properties: {
      edges: { type: 'array' },
      id: { type: 'string' },
      nodes: { type: 'array' },
      title: { type: 'string' },
      triggers: { type: 'array' },
      version: { minimum: 1, type: 'integer' },
    },
    required: ['id', 'version', 'title', 'nodes', 'edges', 'triggers'],
    type: 'object',
  },
  OpenApi: { type: 'object' },
  Run: {
    additionalProperties: true,
    properties: { id: { type: 'string' }, status: { type: 'string' } },
    required: ['id', 'status'],
    type: 'object',
  },
  TriggerRequest: {
    additionalProperties: false,
    properties: { idempotencyKey: { minLength: 1, type: 'string' }, input: { type: 'object' } },
    required: ['idempotencyKey'],
    type: 'object',
  },
  WorkflowRevision: {
    additionalProperties: true,
    properties: {
      definition: { $ref: '#/components/schemas/FlowDefinition' },
      publishedAt: { format: 'date-time', type: 'string' },
    },
    required: ['definition'],
    type: 'object',
  },
});

/*** Map each supported route to an explicit operation identifier and response contract. */
const paths = () => ({
  '/health': { get: operation('health', 'OpenApi') },
  '/openapi.json': { get: operation('openApi', 'OpenApi') },
  '/v1/approvals/{approvalId}/{decision}': {
    post: operation('resolveApproval', 'WorkflowRevision'),
  },
  '/v1/events': { get: operation('readEvents', 'Run', undefined, 200, true, 'text/event-stream') },
  '/v1/runs': { get: operation('listRuns', 'Run', undefined, 200, true) },
  '/v1/runs/{runId}': { get: operation('getRun', 'Run') },
  '/v1/runs/{runId}/cancel': { post: operation('cancelRun', 'Run') },
  '/v1/runs/{runId}/retry': { post: operation('retryRun', 'Run') },
  '/v1/webhooks/{flowId}/{triggerId}': {
    post: operation('triggerWebhook', 'Run', 'TriggerRequest', 202),
  },
  '/v1/workflows': { post: operation('createWorkflow', 'WorkflowRevision', 'FlowDefinition', 201) },
  '/v1/workflows/{flowId}': { get: operation('getWorkflow', 'WorkflowRevision') },
  '/v1/workflows/{flowId}/{version}': { get: operation('getWorkflowRevision', 'WorkflowRevision') },
  '/v1/workflows/{flowId}/{version}/publish': {
    post: operation('publishWorkflow', 'WorkflowRevision'),
  },
  '/v1/workflows/{flowId}/triggers/{triggerId}': {
    post: operation('triggerWorkflow', 'Run', 'TriggerRequest', 202),
  },
});

/*** Describe one authenticated operation including all stable error envelopes. */
const operation = (
  operationId: string,
  response: string,
  request?: string,
  status = 200,
  array = false,
  contentType = 'application/json',
) => ({
  operationId,
  ...(request === undefined
    ? {}
    : {
        requestBody: {
          content: { 'application/json': { schema: reference(request) } },
          required: true,
        },
      }),
  responses: {
    [status]: success(response, array, contentType),
    400: failure(),
    401: failure(),
    403: failure(),
    404: failure(),
    429: failure(),
  },
  security: [{ bearerAuth: [] }],
});

/*** Render the success response schema for JSON and event streams. */
const success = (response: string, array: boolean, contentType: string) => ({
  content: {
    [contentType]: {
      schema:
        contentType === 'application/json'
          ? array
            ? { items: reference(response), type: 'array' }
            : reference(response)
          : { type: 'string' },
    },
  },
  description: 'Success',
});
/*** Reference one declared schema. */
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/*** Render a stable public error response. */
const failure = () => ({
  content: { 'application/json': { schema: reference('Error') } },
  description: 'Error',
});
