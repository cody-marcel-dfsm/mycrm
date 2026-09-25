---
name: my-crm-automation
description: Contribute CRM goals and constraints to BOS-owned explain planning and BOSL authoring, then consume returned journey instructions and actions.
---

# My CRM Automation

Route explicit explain, preview, and automation requests to installed BOS operating-system/application-client skills. They interpret the complete prompt, request current discovery and Describe, construct explain plans, author BOSL, and control lifecycle interaction. My CRM contributes only CRM goals, concepts, constraints, required evidence, source semantics, approvals, guarantees, presentation, and recovery guidance.

When a user asks to explain, inspect, or preview an organization's automation plugin, route the request to the BOS workflow orchestrator. Require fresh `app.describe`, `plugins.list`, and the selected plugin's exact `service.describe` contract. My CRM contributes CRM terminology, goals, constraints, required evidence, and the customer-facing interpretation of the described workflow; BOS owns the complete explain plan.

Present the customer's progression through the automation plugin, starting with its described trigger and continuing through verified human touchpoints, automated steps, connected services, approvals, success outcomes, final failure outcomes, and recovery. Lead with a source-backed diagram of that plugin workflow and use only interfaces, channels, operations, and services named by current Describe evidence. Keep technical steps, node ownership, effects, typed inputs and outputs, and readiness in the explain plan or supporting detail.

Do not substitute the Lead Director record-state graph, a record's current journey position, a shortest lifecycle path, plugin health, or campaign status for the automation workflow. Use `my-crm-customer-journey` only when the user asks about an individual record or the organization's record lifecycle itself. If the plugin Describe contract is unavailable, retain it as an explicit dependency and do not infer the automation from generic CRM behavior.

Implement no local FSM or BOSL dialect, compiler, validator, graph registry, transition selection, execution engine, runtime state, version, digest, revision, or identifier.

For a CRM-domain client instruction:

1. Require the BOS Service `awaiting_client` instruction shape: graph-authored bounded `goal` and `message`, resolved public inputs, exact `after_success` completion action, and exact `on_failure` failed action. Reject the retired client-invented `input_schema` and `actions` wrapper.
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
