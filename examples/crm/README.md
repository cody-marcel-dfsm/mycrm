# CRM consumer examples

These examples show the My CRM-owned portions of a BOS interaction. Runtime
routes, source references, organization fields, selectors, schemas, limits,
guarantees, errors, and lifecycle actions always come from the installed BOS
connection's current application discovery and task-scoped Describe response.

## Discovery to search

For a search, request current application discovery through BOS, copy its
Describe contact, and ask Describe for only `search`. Extract the user's lookup
text and invoke the returned HTTPS method and URI with `{ "text": "..." }`.
Include `source` only when the user selected one, copying the complete
`{platform, application, plugin}` reference from Describe. Validate the result
against the advertised output and error contracts. Tests begin with a
tenant-neutral synthetic BOS discovery URL and fetch these contracts at
runtime; My CRM packages no BOS Service schema or wire example.

## Conceptual customer

[`conceptual-customer.json`](conceptual-customer.json) shows client reasoning
that several source records may represent one customer. The grouping preserves
every source-native record, selector, supporting fact, conflict, confidence,
and uncertainty. It creates no BOS or provider identity.

## Targeted mutation

[`targeted-update.json`](targeted-update.json) shows one request for one
conceptual customer with explicit source records. Each source and opaque
selector is copied from current evidence, and each source-specific change must
validate against current Describe. The client supplies no idempotency key,
version, execution identity, retry state, or authority selector.

## CRM journey contribution and client continuation

[`journey-contribution.json`](journey-contribution.json) contains only CRM
goals, evidence requirements, guarantees, presentation, and recovery guidance
for BOS-owned explain planning and BOSL authoring. My CRM compiles or executes
no graph.

When BOS returns an `awaiting_client` response, its CRM-domain `instruction`
contains graph-authored `goal` and `message`, resolved public inputs, and the exact `after_success` and
`on_failure` actions. `after_success.verb` is `complete` and
`on_failure.verb` is `failed`; each action has exactly
`{verb, method, href, payload_schema}`. Perform the minimum currently
discovered CRM work, then pass the selected action unchanged to
`bos.invokeReturnedAction(action, payload?)`. A later service response may
return top-level `step` or `state`; pass those actions unchanged through their
BOS dependency adapter methods rather than putting them inside the CRM
instruction.
The installed BOS adapter performs the protected invocation and attaches the
active identity-v2 context; My CRM adds and observes no authentication header.
A `null` payload schema is a physically bodyless request. The client never
constructs a lifecycle href and never sends a journey ID, execution ID, state,
transition, version, digest, idempotency key, CRM record, contact list, file,
or source identity through lifecycle completion.
