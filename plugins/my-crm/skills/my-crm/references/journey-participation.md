# Journey participation

BOS skills own explain planning and BOSL authoring. BOS Service owns compilation, registration, authoritative state, sanctioned server operations, transitions, retries, receipts, and recovery. My CRM contributes CRM-domain material and consumes returned actions.

A CRM contribution contains the goal, concepts, constraints, evidence, source semantics, approvals, guarantees, presentation, and recovery guidance. It contains no BOSL state, transition, catch target, runtime identity, version, digest, revision, or source binding.

An `awaiting_client` CRM instruction contains graph-authored bounded `goal` and `message`, resolved public inputs, exact `after_success` completion action, and exact `on_failure` failed action. It has no client-invented `input_schema` or `actions` wrapper. Discover the requested public operation needed to satisfy that goal, perform the minimum CRM work, and pass the applicable action object unchanged to the BOS-owned dependency adapter. Each action contains exactly `{verb, method, href, payload_schema}`. Add no header, context field, or handle. A null payload schema means a physically bodyless request without `Content-Type`.

`step` and `state` are top-level actions in later BOS Service responses, never members of a CRM instruction. Let BOS choose the next action.

A `client_action_required` response for a server-owned step contains a
sanitized public error and a separate closed resolution with a bounded goal,
instruction, optional semantic operation, approval requirement and scope, and
one exact bodyless `step` action. Resolve only that goal through fresh
discovery, obtain the declared approval when required, and pass the returned
step action unchanged to BOS. Do not convert the public error into a provider
diagnosis or invent a lifecycle request.

The canonical recent-meeting follow-up does not require CRM lookup merely to obtain attendee addresses. Acceptance uses generated synthetic attendees under the reserved `example.invalid` domain. My CRM participates only when a later client instruction requests CRM expertise.

For CRM audience repair, interpret only the returned sanitized recipient failure. Discover the minimum current CRM operation, recommend a correction or regenerated audience that fits the original request, and obtain user permission before persisting any CRM change. Invoke the returned lifecycle `complete` action with only its compiler-approved acknowledgment. Never attach recipients or a server-held list reference. The following server nodes re-query and rematerialize the audience. A changed audience requires campaign reprepare and fresh approval before another send; previously proven successful deliveries stay excluded from any resend.
