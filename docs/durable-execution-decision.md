# Durable execution architecture decision

**Status:** implemented on the Flow #7 delivery branch; pending full review acceptance (2026-11-14)

## Decision

Flow will use a provider-neutral persistence and worker architecture. The package core will own
the deterministic transition rules for immutable workflow revisions, runs, step attempts,
checkpoints, retry schedules, cancellation and queue claims. Persistence, clocks, worker
delivery and provider effects will be explicit adapters. A self-hosted adapter must remain usable
without a mandatory database or cloud dependency in the package core.

Temporal and Trigger.dev are not dependencies of `@ankhorage/flow`. They are viable deployment
choices behind an adapter only if a host explicitly selects and operates them.

Durable effects are authorized through the published canonical `FlowSecurityPort`. Flow does not
create another approval or secret boundary: it defers pending approvals as leased work and invokes
the returned permit only at the external-effect boundary.

## Implemented safe foundation

This PR implements a provider-neutral persistence port
for runs, checkpoints and work leases; immutable Flow definition references with revision-checked
run transitions; controlled-clock exponential retry calculations; and a self-hostable,
single-process JSON-file adapter. Adapter instances addressing the same normalized file path share
one process-local serialization boundary, use unique temporary snapshots, and persist a monotonic
lease fencing token. Completion requires the worker ID, the returned fencing token, and an
unexpired controlled-clock lease. Its tests prove stale transitions, bounded deterministic retry
times, concurrent multi-instance persistence, lease recovery after a stopped worker, fencing after
worker-ID reuse, completion idempotency, rejected corrupt envelopes, and that completed work cannot
be claimed twice.

The adapter persists an idempotency-keyed outbox record before delivery, does not resolve secrets,
and defers a pending approval without consuming its work item. Delivery is at least once: a crash
after an external call may redeliver the pending outbox record, so the provider adapter must honor
the supplied idempotency key. This is application-level idempotency, not an exactly-once claim.
It is not a multi-process database adapter: concurrent process coordination
belongs to a later adapter with an atomic storage primitive. This keeps the proven file adapter
within its single-process correctness boundary rather than implying unsupported delivery safety.

## Evaluation

| Option                            | Self-hosting and cost                                                                                                        | Replay and determinism                                                                                                                               | TypeScript integration                                                                                     | Complexity and fit                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Temporal                          | Self-hosting requires operating Temporal plus Cassandra, MySQL, or PostgreSQL; managed service is an additional vendor cost. | Durable replay is a first-class model, but workflow code must obey Temporal replay constraints.                                                      | Official TypeScript SDK, but its workflow programming model becomes part of Flow's public execution model. | Mature, but disproportionately heavy for versioned, user-defined declarative graphs and violates the no-required-backend core constraint. |
| Trigger.dev                       | Can self-host, but remains a platform deployment with its operational components; hosted use is a vendor service.            | Task retries and runs are durable, but Flow would translate graph revision, checkpoints and approval state into Trigger task semantics.              | TypeScript-first SDK.                                                                                      | Lower application ergonomics cost than Temporal, but couples Flow's core to a provider and does not provide Flow-owned replay semantics.  |
| Flow persistence and worker ports | A host can choose a file-backed/self-hosted adapter or a database adapter. The core has no cloud or database dependency.     | Flow persists immutable revision references and step-attempt checkpoints. Delivery is at-least-once; idempotency keys and an outbox protect effects. | Native portable TypeScript contracts and existing `@ankhorage/contracts/flow` snapshots.                   | Owns only Flow-specific orchestration and keeps provider integrations as adapters. This is the selected option.                           |

### Reproducible evidence

The comparison was checked on 2026-11-14 against the upstream sources below. They are also the
sources to re-check when choosing an adapter implementation:

- Temporal's self-hosting guide documents Docker, Kubernetes and from-scratch deployment, and
  requires Cassandra, MySQL or PostgreSQL: <https://docs.temporal.io/self-hosted-guide/deployment>.
- Temporal documents replay as a workflow-execution concern: <https://docs.temporal.io/workflow-execution>.
- Trigger.dev documents self-hosting: <https://trigger.dev/docs/self-hosting/overview>.
- Trigger.dev documents retries and attempt limits: <https://trigger.dev/docs/errors-retrying>.
- Flow's published trigger contract defines IANA time zones, POSIX cron matching, skipped
  spring-forward instants and both fall-back occurrences:
  `@ankhorage/contracts/flow` `FlowTrigger` (installed release `26.7.0`).

To reproduce the availability gate:

```sh
gh api repos/ankhorage/flow/issues/4 --jq '{number,state,closed_at,title}'
bun install --frozen-lockfile
rg -n 'executeAsync|FlowApprovalRequest|FlowSecretRef' src node_modules/@ankhorage/contracts/dist/flow.d.ts
```

The security PR is now merged and Flow `0.4.1` exposes its public `createFlowSecurityPort` root API.

## Published security integration boundary

The published canonical public boundary lets the worker ask the security owner to:

1. authorize the exact immutable `FlowDefinitionRef`, run, step attempt, capability and actor;
2. resolve secret references only inside that owner boundary, never into a Flow run, checkpoint,
   trace or browser DTO;
3. create and resolve approval gates with durable identity and audit metadata; and
4. reject the effect before delivery when authorization or approval is absent, expired, rejected
   or cancelled.

The worker consumes that boundary through its released root API and does not duplicate it or expose
secret material in persisted state.

## Delivery contract

The completed delivery slice follows these constraints:

1. Persist outbox identities before effects and retain immutable flow revision references and
   checkpoints. Database adapters may strengthen transaction boundaries but must retain the port.
2. Keep the self-hostable adapter explicitly single-process; database adapters remain optional
   outer adapters for multi-process coordination.
3. Claim due work with bounded concurrency and backpressure. A lease expiration can redeliver
   work, so the worker records a one-based immutable step attempt and uses deterministic retry
   backoff based on persisted attempt state.
4. Persist timers, cron occurrences and approvals as due work. Cron evaluation follows the
   published Flow contract for IANA time zones and DST; approval requests remain pending until
   their persisted resolution or expiry.
5. Before delivery, invoke the released Flow #4 owner boundary. Persist an idempotency key with
   the outbox record and pass it to a provider adapter. Delivery is **at least once**. An
   idempotency-aware provider can make its application-level effect once; the worker never claims
   an unconditional exactly-once guarantee.
6. Resume from a persisted checkpoint after a worker stop. Completed attempts are never invoked
   again; an in-flight attempt can be redelivered only through the idempotency/outbox path.

## Acceptance contract

Controlled-clock tests must prove worker restart, duplicate events, exhausted retry/backoff,
cancellation, concurrent callbacks, DST skipped/repeated local times, immutable revision pinning,
long-lived approval waits and the file-backed self-hosted adapter. A packed consumer must exercise
the public ports only. Build, typecheck, lint, Knip, format, Changeset status and Exact-HEAD CI
remain release gates.
