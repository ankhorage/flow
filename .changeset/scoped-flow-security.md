---
'@ankhorage/flow': minor
---

Add a provider-neutral Flow security port with scoped authorization, full-identity approval gates,
host-persisted atomic claim and consumption, audit events, rate limits, SSRF-safe targets, and
server-only secret resolution. Remote MCP execution now requires this explicit security boundary
and a host-owned transport that controls every resolved peer connection.
