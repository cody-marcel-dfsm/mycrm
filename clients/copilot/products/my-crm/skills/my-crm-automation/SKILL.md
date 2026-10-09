---
name: my-crm-automation
description: When required BOS authoring and runtime contracts are available, contribute CRM expertise to ad hoc dynamic workflows, then consume returned journey instructions and actions. Use after fixed-workflow precedence when a CRM objective has multiple dependent steps, crosses services, needs durable recovery, or explicitly requires custom composition.
---

# My CRM Automation

Route explicit explain, preview, and automation requests to the installed BOS `bos-workflow-orchestrator` skill. Use BOS `bos-app-discovery` for authenticated application, service, and contract discovery, and BOS `bos-mcp-client` for connection/context selection and authentication recovery. `bos-workflow-orchestrator` interprets the complete prompt, requests current discovery and Describe, constructs explain plans, authors BOSL, and controls lifecycle interaction. My CRM contributes only CRM goals, concepts, constraints, required evidence, source semantics, approvals, guarantees, presentation, and recovery guidance.

## Test the authoring/runtime entry condition

Before contributing to ad hoc composition, use `bos-app-discovery` to resolve
and invoke the current application's advertised semantic `app.describe`
operation through the installed BOS connection. Use its discovered callable
name and input schema. Check the fresh response for both contract advertisements:

1. **Authoring:** `bosl.schema_uri`, `bosl.reference_uri`, and
   `bosl.examples_uri` name the exact BOSL resources; `bosl.descriptor_etag`
   identifies the current descriptor. Have `bos-workflow-orchestrator` read the
   advertised schema, reference, and examples before authoring. Copy resource
   URIs verbatim. The etag is freshness evidence, not a registration precondition.
2. **Registration/runtime:** `journey_registration.contract.capability` and
   `journey_registration.contract.input` advertise the lookup separately from
   `describe.operations`. For the current Lead Director contract these are
   `api.contract.get` and `{"operation":"lead-director.journeys.register"}`.
   Resolve that capability through current discovery and invoke it with the
   exact returned input. Require the actual validated response for operation
   `lead-director.journeys.register`, contract version
   `lead-director-journey-registration/v1` or
   `lead-director-journey-registration/v2`, matching fresh discovery. Copy its
   exact advertised execution URI. Its `input_schema` describes raw BOSL;
   `output_schema`, `limits`, `guarantees`, `execution`, and `public_errors`
   describe registration and the supported runtime response. Follow lifecycle
   actions only when BOS returns them; construct no lifecycle endpoint.

Registration behavior follows the discovered contract version. Version 1
retains its existing immediate lifecycle response and execution behavior;
consume that response and its returned instructions and actions. Version 2
compiles and registers raw BOSL and returns
`{compiled: true, identity, actions.start}`. Version 2 execution begins only when
`bos-workflow-orchestrator` invokes the exact returned `actions.start` through
the BOS connection. A bodyless start advertises `payload_schema: null`; send
no payload. My CRM contributes domain expertise and consumes CRM instructions
when the journey reaches its client step. Keep the compilation receipt separate
from `awaiting_client` and `client_action_required` CRM instruction envelopes.

The entry condition passes only when both advertisements and their required
resource/contract reads are present and valid. A missing key, failed read,
unsupported contract, or invalid response leaves the affected authoring/runtime
contract unavailable or unresolved: report the exact missing dependency and
stop ad hoc composition. BOS installation, ordinary CRM Describe success, and
an advertised lookup alone do not establish this condition. Check each selected
plugin/operation's source readiness separately; contract availability grants no
execution authority and does not establish that a provider is ready.

An explain/preview request still routes to `bos-workflow-orchestrator` for a
read-only plan from current Describe evidence. Explaining an installed plugin
requires the plugin discovery below, without registering or executing a journey;
missing custom-authoring/runtime evidence does not block that independent read.
If a required BOS skill is absent, report its exact skill name as a dependency.

## CRM workflow contribution

First select a complete applicable focused CRM workflow when one covers the
objective. Select ad hoc composition only when no complete fixed workflow
covers the objective or the user explicitly requests custom composition. In
that branch, a request that spans multiple dependent CRM or non-CRM steps,
requires a durable human/automation handoff, or needs bounded recovery is an ad
hoc workflow candidate. My CRM contributes the CRM portion and never creates a
local graph, compiler, transition engine, or runtime.

## Normative artifacts and installed definitions

Repository paths below belong to `cody-marcel-dfsm/mycrm`; their links locate the
source artifacts even when the installed package contains only skills. The
following definitions are available directly in this skill.

Marketplace starters are defined by [contracts/my-crm/v1/marketplace-prompt-contracts.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/contracts/my-crm/v1/marketplace-prompt-contracts.json), validated by [contracts/my-crm/v1/marketplace-prompt-contracts.schema.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/contracts/my-crm/v1/marketplace-prompt-contracts.schema.json):

- `find-customer-records`: search CRM matches for external attendees from the last completed meeting; read only.
- `canonical-recent-meeting-follow-up`: preview unsent follow-up for those attendees and show recipients and content; no initial CRM lookup or mutation, with explicit approval required before a later send.
- `compare-customer-across-sources`: find those attendees' CRM matches and compare the first conceptual customer across sources; read only.

All three use My CRM's configured BOS scope and BOS-owned journey orchestration,
current discovery, calendar-derived identity, and stop when no qualifying
attendee exists. Preserve provenance and freshness; comparison also preserves
reconciliation evidence and uncertainty. Apply the detailed routing rules in this skill.

The CRM contribution's normative shape is [contracts/my-crm/v1/crm-journey-contribution.schema.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/contracts/my-crm/v1/crm-journey-contribution.schema.json), illustrated by
[examples/crm/journey-contribution.json](https://github.com/cody-marcel-dfsm/mycrm/blob/main/examples/crm/journey-contribution.json). It is a closed object with all eight fields required:

| Field | Type | CRM meaning |
| --- | --- | --- |
| `goal` | Non-empty string | CRM objective that contributes to the user's request. |
| `concepts` | Array | Relevant organization-described CRM concepts and source semantics. |
| `constraints` | Array | Scope and domain limits, including source-record preservation. |
| `requiredEvidence` | Array | Current observations needed to support the CRM work. |
| `approvals` | Array | Required human approvals and their scope; empty when none apply. |
| `guarantees` | Array | Declared read or mutation guarantees and transaction boundaries. |
| `presentation` | Array | Result requirements for provenance, freshness, conflicts, and uncertainty. |
| `recovery` | Array | CRM guidance for returned public recovery instructions. |

Arrays may be empty; the schema adds no item type restriction. Contribute no
additional object fields, BOSL state, transition, runtime identity, or source
binding. BOS owns authoring and runtime execution; live discovery supplies
execution contracts.

Route each marketplace starter through the installed BOS `bos-workflow-orchestrator` skill because its audience or lookup identity comes from the latest completed meeting. Ask BOS to resolve the `my-crm` plugin's configured default unless the user explicitly selected another authorized organization for this task. Stay within the resulting BOS-authenticated organization, application, installation, user, and role scope; never request organization data, tenant identifiers, or authority selectors. If the default is unavailable, or no qualifying meeting, external attendee, or CRM match exists, report that outcome and stop without probing another organization or requesting replacement input.

For the follow-up starter, perform no initial CRM lookup: the meeting attendees already supply the audience. Require the BOS-owned review and explicit approval step before send, and involve My CRM only when a later returned client instruction requests CRM expertise. For the two read-only starters, allow only the currently discovered CRM search and no mutation.

When a user asks to explain, inspect, or preview an organization's automation plugin, route the request to BOS `bos-workflow-orchestrator`. Require fresh `app.describe`, `plugins.list`, and the selected plugin's exact `service.describe` contract. My CRM contributes CRM terminology, goals, constraints, required evidence, and the customer-facing interpretation of the described workflow; BOS owns the complete explain plan.

Present the customer's progression through the automation plugin, starting with its described trigger and continuing through verified human touchpoints, automated steps, connected services, approvals, success outcomes, final failure outcomes, and recovery. Lead with a source-backed diagram of that plugin workflow and use only interfaces, channels, operations, and services named by current Describe evidence. Keep technical steps, node ownership, effects, typed inputs and outputs, and readiness in the explain plan or supporting detail.

Do not substitute the Lead Director record-state graph, a record's current journey position, a shortest lifecycle path, plugin health, or campaign status for the automation workflow. Use [my-crm-customer-journey](../my-crm-customer-journey/SKILL.md) only when the user asks about an individual record or the organization's record lifecycle itself. If the plugin Describe contract is unavailable, retain it as an explicit dependency and do not infer the automation from generic CRM behavior.

Implement no local FSM or BOSL dialect, compiler, validator, graph registry, transition selection, execution engine, runtime state, version, digest, revision, or identifier.

## Agree on the instruction protocol before execution

Before BOS starts or resumes a workflow that can request CRM expertise, require fresh authenticated discovery and Describe of its instruction contract. Agree with BOS on the server's published protocol version and instruction schema before any CRM effect or lifecycle start. This client supports the graph-authored `awaiting_client` profile described below: bounded `goal` and `message`, resolved public inputs, `after_success`/`complete`, and `on_failure`/`failed`, with exact `{verb, method, href, payload_schema}` actions. Protocol compatibility metadata is distinct from forbidden journey runtime versions and belongs outside the CRM instruction and contribution.

Use only the version metadata, versioned schema identity, selection mechanism, and acknowledgment advertised by the discovered contract. If selection is advertised, BOS selects a mutually supported version through that exact contract and verifies the server acknowledgment. A single advertised version can establish agreement when its published schema and semantics match this supported profile. A versioned schema identity can serve as the version when the contract explicitly defines it that way. A version number alone, an unversioned shape, or a previously cached agreement is insufficient. Add no invented handshake endpoint, envelope field, version header, or lifecycle payload field.

If there is no mutually supported version, metadata is missing, or the returned schema contradicts the agreement, refresh discovery and Describe once. Recheck before executing anything. If still incompatible, stop automation with the client diagnostic `AUTOMATION_PROTOCOL_INCOMPATIBLE`: state the supported profile, the advertised public version/schema identity when available, the incompatible or missing fields, whether the workflow never started or is paused, and the next action to restore compatibility (update the installed client or ask the service owner to publish a supported version). Report only sanitized public metadata. This diagnostic is a client outcome, never an invented server error or `on_failure` payload. Record unavailable version evidence as unavailable; retain any pending continuation under BOS ownership.

A server emitting the retired `input_schema`/`actions` wrapper reaches this same diagnostic path. Execute no CRM effect and invoke no action from that incompatible instruction. Translate no retired wrapper, guess no version, and perform no automatic downgrade. For an existing workflow, preserve the unresolved action and confirmed receipts for BOS recovery. Revalidate the agreed contract on every instruction and after discovery refresh; a changed contract requires fresh agreement and review before resumption.

For a CRM-domain client instruction:

1. Require the BOS Service `awaiting_client` instruction shape: graph-authored bounded `goal` and `message`, resolved public inputs, exact `after_success` completion action, and exact `on_failure` failed action. Route the retired client-invented `input_schema` and `actions` wrapper through the compatibility diagnostic above.
2. Combine the goal with the original user objective and discover the minimum current CRM capability.
3. Invoke its exact HTTPS contract and retain only public receipt or correlation evidence needed by the returned continuation.
4. Require the exact returned `{verb, method, href, payload_schema}` shape. After success, invoke `after_success` unchanged through `bos.invokeReturnedAction(action, payload?)`; after a published failure, invoke `on_failure` the same way. Send only the compiler-approved lifecycle payload and add no header or context field.
5. When `payload_schema` is `null`, omit both body and `Content-Type`; never send `{}` or JSON `null`.

Do not put `step` inside the CRM instruction. BOS selects every next and catch transition, and a later top-level service response may return a `step` action for the BOS client to invoke when ready. Do not transport CRM records, contact lists, files, source identities, transition names, or runtime state through lifecycle completion.

When BOS returns `client_action_required` for a server-owned node, validate the
sanitized public error and the separate closed resolution. Use the resolution's
goal and optional semantic operation to discover the minimum current CRM
capability. Respect its exact approval requirement and approval scope. After
the resolution is satisfied, invoke only its returned bodyless `step` action
through BOS. Supply no journey state, retry state, transition, or replacement
action.

When a returned CRM instruction reports invalid campaign recipients, reason from the sanitized failure and current CRM evidence. Recommend the smallest correction or regenerated audience that satisfies the user's original objective. Obtain user permission before any CRM mutation, invoke only the newly discovered CRM operation, and acknowledge completion with the exact returned lifecycle payload. Send no audience or server-held list reference through `complete`. BOS re-queries and rematerializes the audience. Any changed audience invalidates the prior campaign approval, so require campaign reprepare and fresh user approval before another send while preserving recipients already proven successfully delivered.

## Recover an interrupted instruction

Before each request, preserve its exact advertised contract/action and approved payload, including absence of a body, in the active BOS-owned task context. Retain the original objective, validated instruction, established protocol agreement, confirmed public receipts, and approval scope. My CRM creates no durable execution journal, runtime identity, retry field, or idempotency key. A confirmed CRM effect and its lifecycle acknowledgment are separate outcomes: acknowledgment recovery reuses the confirmed result and never repeats the CRM work.

When an action's transport outcome is unknown and no successor was received, repeat that exact unresolved action through BOS. Preserve its verb, method, href, payload schema, and payload unchanged. A bodyless action remains bodyless. Server idempotency owns replay safety; require the current advertised lifecycle replay guarantee. A timeout, disconnect, rejected transport promise, truncated response, or lost continuation provides no evidence of business failure. Send `on_failure` only for a confirmed published failure with the compiler-approved payload.

| Interruption | Client recovery action |
|---|---|
| Discovery, Describe, or version selection transport fails | Retry the same discovery/selection request through BOS within the bounded policy below. Keep the preflight incomplete and execute no CRM or lifecycle effect until agreement is verified. |
| CRM HTTPS operation loses its response during the instruction | Preserve the exact request and classify the effect as unknown. Use the operation's advertised receipt/status reconciliation through BOS first. Repeat the exact request only when its discovered idempotency/replay guarantee permits it; repeat a safe read under its contract. If no safe reconciliation or replay is advertised, pause with the operation outcome unknown and ask BOS to retain it for service-owner recovery. Invoke neither lifecycle branch until the CRM outcome is confirmed. |
| `bos.invokeReturnedAction` throws or loses the response to `after_success`, `on_failure`, or a resolution's bodyless `step` | Repeat only that exact unresolved lifecycle action and its original payload through BOS under the advertised replay guarantee. Preserve the confirmed CRM result or published failure; keep the same branch. |
| A lifecycle response is lost, truncated, or lacks a valid successor or terminal outcome | Treat that action as unresolved and repeat it exactly. Follow only a validated successor or terminal result returned by BOS; infer no next step from the last instruction. |
| A valid successor was received but processing was interrupted | Resume from that successor. If it was lost from the task context, ask BOS to use an already returned or freshly advertised state/reconciliation contract, then follow its current response. Repeating a completed predecessor requires the service's advertised reconciliation/replay prescription. |
| Challenged HTTP 401, established uppercase authentication handoff, or MCP-session recovery condition at any phase | Preserve the pending request/action, delegate automatically to BOS through `READY`, refresh authenticated discovery, re-Describe, recheck protocol agreement and scope, then retry the exact preserved request once. Preserve the established one-resume authentication recovery budget separately from ordinary transport retries; nested calls cannot reset it, and transport retries cannot consume it. |
| Scope, effect, approval requirement, or protocol changes during recovery; action expires or is rejected deterministically | Pause. Ask BOS to revalidate the original authorized scope and use its discovered state/reconciliation contract. Require fresh review/approval for changed effects or approval scope; require fresh protocol agreement for a changed contract. Resume only from a currently valid returned action. Report confirmed terminal `expired`/`failed` results as such. |
| Original unresolved action/payload is missing after context loss | Recover the authoritative continuation using BOS's discovered state/reconciliation contract and confirmed receipts. If it cannot reconstruct a safe continuation, report automation paused with recovery unavailable and ask BOS/service owner to recover it. Construct no replacement action and restart no workflow. |

For ordinary transport recovery, use the server's advertised bounded retry/backoff prescription. When none is advertised, allow one automatic repeat of a safe read or service-idempotent lifecycle action, then pause with `AUTOMATION_RECOVERY_PENDING`. Count ordinary transport retries across the whole recovery episode, including transport retries already performed by the BOS adapter. Keep the established one post-READY authentication resume available independently of that transport budget. Never stack client and adapter loops for the same recovery class. If BOS has exhausted ordinary transport retries, pause that transport recovery; a recognized authentication challenge still follows the established BOS authentication recovery path once. Report the interrupted phase, confirmed versus unknown outcome, sanitized public correlation evidence when available, and the exact next recovery step. Retain the unresolved request/action with BOS for a later authorized resume; exhaustion leaves the workflow pending and sends no invented `failed` acknowledgment.

When an authoritative result confirms CRM success, acknowledge with the original `after_success` and compiler-approved payload; when it confirms a published failure, use the original `on_failure`. An authoritative pending result stays pending. Repeated `awaiting_client` after acknowledgment loss requires reconciliation of the prior effect and acknowledgment before any CRM operation is repeated. Honor confirmed terminal results and user stop, and let BOS select every successor and catch transition.

## Post-mutation cache handoff

For every CRM mutation invoked by a client instruction or recovery correction, delegate post-mutation invalidation exclusively to `my-crm-cache-maintenance` before acknowledging workflow completion. If this skill invokes the mutation, hand off confirmed outcomes and receipts once under that owner’s rules, including partial successes and newly confirmed commits from returned state actions. If a focused mutation skill executes it, that skill makes the handoff; perform no independent invalidation or duplicate handoff, and preserve any incomplete-maintenance status in the CRM result presentation using only the permitted lifecycle payload.
