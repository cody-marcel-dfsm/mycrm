---
name: my-crm-automation
description: Contribute CRM goals and constraints to BOS-owned explain planning and BOSL authoring, then consume returned journey instructions and actions.
---

# My CRM Automation

Route explicit explain, preview, and automation requests to installed BOS operating-system/application-client skills. They interpret the complete prompt, request current discovery and Describe, construct explain plans, author BOSL, and control lifecycle interaction. My CRM contributes only CRM goals, concepts, constraints, required evidence, source semantics, approvals, guarantees, presentation, and recovery guidance.

Implement no local FSM or BOSL dialect, compiler, validator, graph registry, transition selection, execution engine, runtime state, version, digest, revision, or identifier.

For a CRM-domain client instruction:

1. Require the BOS Service `awaiting_client` instruction shape: graph-authored bounded `goal` and `message`, resolved public inputs, exact `after_success` completion action, and exact `on_failure` failed action. Reject the retired client-invented `input_schema` and `actions` wrapper.
2. Combine the goal with the original user objective and discover the minimum current CRM capability.
3. Invoke its exact HTTPS contract and retain only public receipt or correlation evidence needed by the returned continuation.
4. Require the exact returned `{verb, method, href, payload_schema}` shape. After success, invoke `after_success` unchanged through `bos.invokeReturnedAction(action, payload?)`; after a published failure, invoke `on_failure` the same way. Send only the compiler-approved lifecycle payload and add no header or context field.
5. When `payload_schema` is `null`, omit both body and `Content-Type`; never send `{}` or JSON `null`.

Do not put `step` inside the CRM instruction. BOS selects every next and catch transition, and a later top-level service response may return a `step` action for the BOS client to invoke when ready. Do not transport CRM records, contact lists, files, source identities, transition names, or runtime state through lifecycle completion.

When a returned CRM instruction reports invalid campaign recipients, reason from the sanitized failure and current CRM evidence. Recommend the smallest correction or regenerated audience that satisfies the user's original objective. Obtain user permission before any CRM mutation, invoke only the newly discovered CRM operation, and acknowledge completion with the exact returned lifecycle payload. Send no audience or server-held list reference through `complete`. BOS re-queries and rematerializes the audience. Any changed audience invalidates the prior campaign approval, so require campaign reprepare and fresh user approval before another send while preserving recipients already proven successfully delivered.
