# @ankhorage/flow

## 0.6.2

### Patch Changes

- 9deb25f: Add canonical repository metadata for package discovery and documentation.

## 0.6.1

### Patch Changes

- f32b474: Normalize untrusted MCP transport and provider failures to stable redaction-safe errors while
  proving approved STDIO and remote tool invocation in isolated consumers.

## 0.6.0

### Minor Changes

- df1785f: Add provider-neutral typed AI execution with secure BYOK, streaming telemetry, budgets, retries, cancellation, and bounded agent tools.

## 0.5.0

### Minor Changes

- 63d8dd6: Add provider-neutral durable execution with fenced workers, retries, checkpoints, cron matching,
  outbox idempotency, cancellation, and published-security approval waits.

## 0.4.1

### Patch Changes

- 8e96c13: Load the optional MCP SDK only when MCP discovery or approved execution opens a provider connection.

## 0.4.0

### Minor Changes

- f7431ac: Add a provider-neutral Flow security port with scoped authorization, full-identity approval gates,
  host-persisted atomic claim and consumption, audit events, rate limits, SSRF-safe targets, and
  server-only secret resolution. Remote MCP execution now requires this explicit security boundary
  and a host-owned transport that controls every resolved peer connection.

## 0.3.0

### Minor Changes

- 9bd21b1: Add an optional, fail-closed MCP tool discovery entrypoint with explicit provider and tool scopes.

## 0.2.0

### Minor Changes

- 24a9d4d: Bootstrap the standalone Flow package with public provider subpaths and packed-consumer validation.
- 1ba3dca: Add deterministic headless graph compilation, safe built-in operations, and single-process execution.

### Patch Changes

- 5b3e567: Declare the published workflow contracts dependency used by Flow's public consumer boundary.
