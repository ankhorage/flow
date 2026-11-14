# MCP security boundary

`@ankhorage/flow/mcp` discovers only named provider tools that have explicit provider and
tool-scope grants. Workflow definitions never carry STDIO commands, arguments, environment values,
or remote credentials; those details are host configuration.

Production remote MCP discovery remains host-controlled. Every tool invocation now requires a
`FlowSecurityPort` permit: an exact actor, tenant, project, environment, capability, approval,
rate-limit and idempotency decision is made before Flow opens an execution connection. Omit the
port and Flow fails closed. Secret references resolve only inside the one-use server-side permit
callback; graph data, tool arguments, results, errors and audit events contain no secret payload.

Hosts supply the identity, durable approval store, rate-limit and audit adapters. Flow does not
implement sessions, users, roles or a vault. It uses the published `SecretStoreAdapter` and can be
tested with the released `@ankhorage/secrets-supabase-vault` adapter without making Supabase a
runtime dependency.

The only remote exception is host-controlled development testing with
`allowDevelopmentLoopback: true`. It accepts literal `127.0.0.1` or `::1` over HTTP with an empty
host allowlist. DNS names, redirects, credentials, and production access are not part of that
exception, so it cannot be used to bypass production SSRF or DNS-rebinding protections.
