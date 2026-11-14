# MCP security boundary

`@ankhorage/flow/mcp` discovers only named provider tools that have explicit provider and
tool-scope grants. Workflow definitions never carry STDIO commands, arguments, environment values,
or remote credentials; those details are host configuration.

Remote MCP discovery remains host-controlled. Every tool invocation now requires a
`FlowSecurityPort` permit: an exact actor, tenant, project, environment, capability, approval,
rate-limit and idempotency decision is made before Flow opens an execution connection. Omit the
port and Flow fails closed. Secret references resolve only inside the one-use server-side permit
callback; graph data, tool arguments, results, errors and audit events contain no secret payload.

Hosts supply the identity, durable approval store, rate-limit and audit adapters. The durable
operation store must atomically claim, consume, and release only unconsumed claims for an exact
identity; Flow releases a claim if rate limiting or a required permitted audit fails, so a later
retry can be authorized without creating a second executable permit. Flow does not implement
sessions, users, roles or a vault. It uses the published `SecretStoreAdapter` and can be tested
with the released `@ankhorage/secrets-supabase-vault` adapter without making Supabase a runtime
dependency.

Credential create and revoke are server-only `FlowSecurityPort` operations. They derive their
SecretStore scope from the granted actor and require the exact `secrets:create` or
`secrets:revoke` grant; their audits contain a reference but never a credential payload. Flow is
not an HTTP server, so hosts must expose those operations only from their authenticated server
boundary and must never bridge `resolve` or credential payloads to a browser.

Remote MCP requires a host-owned `FlowOutboundTransportPort`; Flow routes every MCP request through
that port and uses same-origin redirects only. The host transport enforces the configured host
allowlist, resolves immediately before every peer connection, rejects private and special-use
addresses, and reapplies those checks to redirects. Loopback development exceptions are not part
of the public Flow configuration.
