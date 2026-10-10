# Journey participation

BOS skills own explain planning and BOSL authoring. BOS Service owns compilation, registration, authoritative state, sanctioned server operations, transitions, retries, receipts, and recovery. My CRM contributes CRM-domain material and consumes returned actions.

A CRM contribution follows [contracts/my-crm/v1/crm-journey-contribution.schema.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/contracts/my-crm/v1/crm-journey-contribution.schema.json) and [examples/crm/journey-contribution.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/examples/crm/journey-contribution.json). Its required fields are `goal`, `concepts`, `constraints`, `requiredEvidence`, `approvals`, `guarantees`, `presentation`, and `recovery`; their installed definitions and the marketplace starter contract paths are in the [My CRM router](../SKILL.md#normative-artifacts-and-installed-definitions). It contains no BOSL state, transition, catch target, runtime identity, version, digest, revision, or source binding.

An `awaiting_client` CRM instruction contains graph-authored bounded `goal` and `message`, resolved public inputs, exact `after_success` completion action, and exact `on_failure` failed action. It has no client-invented `input_schema` or `actions` wrapper. Discover the requested public operation needed to satisfy that goal, perform the minimum CRM work, and pass the applicable action object unchanged to the BOS-owned dependency adapter. Each action contains exactly `{verb, method, href, payload_schema}`. Add no header, context field, or handle. A null payload schema means no caller business payload: pass the unchanged action to BOS without a payload. BOS owns compatible POST framing and may use exact `{}` with JSON `Content-Type`; GET state actions remain body-free. Supply no JSON `null` or nonempty object.

`step` and `state` are top-level actions in later BOS Service responses, never members of a CRM instruction. Let BOS choose the next action.

A `client_action_required` response for a server-owned step contains a
sanitized public error and a separate closed resolution with a bounded goal,
instruction, optional semantic operation, approval requirement and scope, and
one exact no-payload `step` action. Resolve only that goal through fresh
discovery, obtain the declared approval when required, and pass the returned
step action unchanged to BOS. Do not convert the public error into a provider
diagnosis or invent a lifecycle request.

The `canonical-recent-meeting-follow-up` starter defined in [contracts/my-crm/v1/marketplace-prompt-contracts.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/contracts/my-crm/v1/marketplace-prompt-contracts.json) does not require CRM lookup merely to obtain attendee addresses. Acceptance uses generated synthetic attendees under the reserved `example.invalid` domain. My CRM participates only when a later client instruction requests CRM expertise.

For CRM audience repair, interpret only the returned sanitized recipient failure. Discover the minimum current CRM operation, recommend a correction or regenerated audience that fits the original request, and obtain user permission before persisting any CRM change. Invoke the returned lifecycle `complete` action with only its compiler-approved acknowledgment. Never attach recipients or a server-held list reference. The following server nodes re-query and rematerialize the audience. A changed audience requires campaign reprepare and fresh approval before another send; previously proven successful deliveries stay excluded from any resend.

## Protocol agreement and interrupted participation

Apply the preflight and recovery rules in `my-crm-automation` before BOS starts or resumes CRM participation. Require fresh advertised version/schema agreement for the graph-authored instruction profile. Missing metadata, unsupported versions, the retired wrapper, or a response contradicting the agreement trigger one discovery refresh and then the sanitized client outcome `AUTOMATION_PROTOCOL_INCOMPATIBLE`. Keep an existing workflow paused with its continuation preserved; BOS owns the compatibility selection and server contracts.

When an action's transport outcome is unknown and no successor was received, repeat that exact unresolved action with its original payload through BOS under the advertised replay guarantee. Recover a lost lifecycle acknowledgment separately from a confirmed CRM effect. Reconcile an uncertain CRM effect through its advertised receipt/status contract and replay only under its discovered guarantees. A transport error never supplies a published `on_failure` payload.

At any phase, delegate challenged 401, established uppercase handoff, and MCP-session recovery to BOS through `READY`; refresh discovery, re-Describe, recheck protocol and authorized scope, and resume the preserved request once under the established authentication budget. Ordinary transport retries cannot consume that authentication resume; nested adapter/client calls cannot reset either budget. Follow a received successor; recover lost task context only through advertised state/reconciliation. Changed scope, effects, approvals, contracts, expired actions, unavailable safe recovery, or exhausted bounded retries leave a diagnosable pending outcome until BOS supplies a valid continuation or confirmed terminal result. Invent no request, restart, transition, or failure acknowledgment.
