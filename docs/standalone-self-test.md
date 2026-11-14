# Standalone self-test

This package has no mandatory external backend. The standalone adapter persists runtime state in
`FLOW_STATE_PATH` and canonical durable worker state beside it, then runs the worker independently
from HTTP clients. `startFlowServerAsync` is fail-closed: a network server needs an explicit
authenticator and access policy. The CLI below supplies its token-authenticated loopback composition.

Start the server from the package checkout with Bun 1.4.2:

```sh
FLOW_API_TOKEN=local-flow-token FLOW_PORT=4318 FLOW_STATE_PATH=/tmp/flow-runtime.json bun run serve
```

It reports `Flow server listening on http://127.0.0.1:4318`. In another terminal, use that URL and token:

```sh
curl -i http://127.0.0.1:4318/health
curl -i http://127.0.0.1:4318/openapi.json
curl -i -X POST http://127.0.0.1:4318/v1/workflows -H 'authorization: Bearer local-flow-token' -H 'content-type: application/json' --data '{"id":"demo","version":1,"title":"Demo","nodes":[],"edges":[],"triggers":[{"id":"manual","kind":"manual"}]}'
curl -i -X POST http://127.0.0.1:4318/v1/workflows/demo/1/publish -H 'authorization: Bearer local-flow-token'
curl -i -X POST http://127.0.0.1:4318/v1/workflows/demo/triggers/manual -H 'authorization: Bearer local-flow-token' -H 'content-type: application/json' --data '{"idempotencyKey":"demo-001"}'
```

Expected results are `200 {"status":"ok"}`, `200` with OpenAPI, `201` for the draft, `200` for publication, and `202` with a run id for the trigger. Replace `RUN_ID` below with that id after a brief worker interval:

```sh
curl -i -H 'authorization: Bearer local-flow-token' http://127.0.0.1:4318/v1/runs/RUN_ID
curl -N -H 'authorization: Bearer local-flow-token' 'http://127.0.0.1:4318/v1/events?runId=RUN_ID'
```

The run becomes `succeeded`; the SSE response contains `run_queued`, `run_started`, and `run_completed`. HTTP responses omit run and node input/output payloads. Repeating the trigger with `demo-001` returns the original run. `POST /v1/runs/RUN_ID/cancel` and `POST /v1/runs/RUN_ID/retry` expose the cancellation and retry command boundaries.

To reproduce cleanly, stop the process, remove both state files, and repeat the start command:

```sh
rm -f /tmp/flow-runtime.json /tmp/flow-runtime.json.durable
FLOW_API_TOKEN=local-flow-token FLOW_PORT=4318 FLOW_STATE_PATH=/tmp/flow-runtime.json bun run serve
```

The worker leases durable work, persists an outbox identity before an effect, and recovers expired
leases after restart. HTTP, SSE, and audit projections redact payloads and arbitrary provider error
or trace messages; only stable public status and error codes are exposed.
