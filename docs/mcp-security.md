# MCP security boundary

`@ankhorage/flow/mcp` discovers only named provider tools that have explicit provider and
tool-scope grants. Workflow definitions never carry STDIO commands, arguments, environment values,
or remote credentials; those details are host configuration.

Production remote MCP discovery and every tool invocation are unavailable until Flow Issue #4
releases the canonical approval and security transport boundary. This is deliberate fail-closed
behavior: a callback supplied by a caller is not authorization.

The only remote exception is host-controlled development testing with
`allowDevelopmentLoopback: true`. It accepts literal `127.0.0.1` or `::1` over HTTP with an empty
host allowlist. DNS names, redirects, credentials, and production access are not part of that
exception, so it cannot be used to bypass production SSRF or DNS-rebinding protections.
