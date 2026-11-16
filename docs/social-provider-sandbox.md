# Social provider sandbox acceptance

This package supplies only the SDK-free `@ankhorage/flow/social` boundary. A host owns concrete
provider adapters, provider applications, credentials, artifact retrieval, and the approved
`FlowOutboundTransportPort`. It must run this acceptance only with provider-authorized sandbox
credentials and a sandbox tenant/account binding.

Before a sandbox run, the host must verify that the adapter's exact endpoint and allowlist identify
the provider sandbox, that the authenticated actor has the required tenant, project, and environment
grant, and that the stored OAuth payload is bound to that tenant, platform, account ID, and account
type. The graph contains only the SecretRef; it must never contain an OAuth payload or token.

The sandbox flow is Draft -> Approval -> Schedule -> Publish -> Analytics. It must use a newly
created, uniquely marked sandbox post, capture only the returned post ID, timestamps, normalized
metrics, and provenance, then remove the sandbox post where the provider permits removal. The host
must prove that every provider request passed through `FlowOutboundTransportPort` and that approval,
idempotency, and rate-limit denials make no provider request.

Do not run this flow against a production account, and do not report provider-sandbox or live-posting
acceptance until an authorized sandbox run has completed. Logs, graph snapshots, responses, test
artifacts, and audit events must be checked for absence of credential values before retaining them.
