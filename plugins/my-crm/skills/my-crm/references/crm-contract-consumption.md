# CRM contract consumption

Start from the installed BOS product's authenticated `app.describe`. Request one to five current public operation keys required by the user's task, then call the returned `describe` contact. Consume `described` and `not_available` statuses verbatim. Copy operation schemas, complete source availability wrappers, limits, guarantees, `error_contract`, and the exact execution contact. When a source includes a source-specific contract, require its complete input, output, receipt, limits, guarantees, and error set; never fill in a missing source-specific value. Invoke business work through the BOS-owned deterministic HTTPS transport and never through MCP `tools/call`.

An advertised `execution.context_header` is a transport marker and must equal `X-BOS-Context-Handle`. Pass that discovered contact to the BOS external-product dependency adapter. Pass returned journey lifecycle and state action objects to that adapter unchanged. For both paths the adapter selects and attaches the current fresh opaque identity-v2 handle when invoking the protected HTTPS contact. My CRM never receives, constructs, persists, interprets, displays, or attaches a handle value.

General reads omit `source`; BOS selects participating sources and performs parallel federation. Explicit-source work copies the entire current `{platform, application, plugin}` value. A source display label is never a routing value.

Search sends non-empty user lookup text. Create sends one described source and dynamic changes. Update and delete send one to five explicit targets for one conceptual customer. Each target carries one complete source reference, one opaque selector, and update changes when applicable. My CRM sends no result limit, paging state, idempotency key, version, retry state, execution identity, authority selector, source identifier, or database key.

Public failures contain only stable code, actionable message, retryability, public correlation evidence, and bounded validation details. A structured instruction is a sibling of the error. Follow only returned actions and never expose raw service or source failures.

For a protected-resource authentication or MCP-session condition, preserve the affected resource unchanged and delegate only that resource plus the exact `{category, code, source}` condition to BOS. Wait through the BOS-owned host action, refresh current discovery after `READY`, and resume the preserved operation once.
