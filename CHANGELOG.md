# @ankhorage/flow

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
