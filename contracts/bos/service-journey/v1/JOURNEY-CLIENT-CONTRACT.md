# BOS journey client contract

The BOS Service owns journey state, transitions, idempotency, opaque action
capabilities, and route construction. A client invokes the fully resolved
actions returned by BOS verbatim. It creates no execution identifier, action
identifier, state revision, step identifier, retry identifier, or idempotency
key.

`client_action_required` means the current server-executable step needs an
intelligent client to achieve the declared resolution goal before execution can
continue. The response contains a sanitized public error, the semantic goal and
instruction, an optional operation to discover, approval requirements, and the
same journey's opaque `after_success` action. The instruction grants no new
authority. The client uses authenticated discovery and existing skills, obtains
the requested approval when required, completes the authorized operation, and
then invokes `resolution.after_success` exactly as returned.

Operation identifiers and values in examples are synthetic and tenant-neutral.
Clients use operations discovered for their current organization and never
derive a provider, customer, organization, or authority from an example.

The accompanying schema and example are the normative consumer shape. The Lead
Director Describe bundle is authoritative for operation discovery and
invocation contracts.
