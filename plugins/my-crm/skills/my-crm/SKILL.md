---
name: my-crm
description: Extend the basic Lead Director sales-flow skills with provider-neutral CRM records, pipelines, activities, federation, customer journeys, and graph automations through the current organization's My CRM MCP capabilities.
---

# My CRM

Use the installed My CRM product's authenticated MCP connection for every CRM operation. Require the BOS product for platform identity and installed-app discovery. Treat the package resource URL as sealed configuration and derive organization, role, services, sources, operations, schemas, and grants from current authenticated discovery.

Treat My CRM as the independent external extension and planned successor to the basic Lead Director CRM skill set in BOS Operations Center. Lead Director covers basic sales-flow lead interactions during the transition. My CRM owns the complete CRM experience described here. The current `leaddirector/crm` MCP resource is routing metadata and creates no client dependency on Lead Director or any particular source system.

## Establish context

1. Resolve `bos_get_context`, then select exactly one authorized organization: an explicit organization in the request, the validated local default label, or the sole available organization.
2. Use only the selected role's opaque `context_id` where the live schema requests it. Never construct raw tenant, app, installation, provider, or source authority.
3. Refresh the My CRM tool and resource catalog after authentication, context, permission, service, or schema changes. Tool presence declares an operation; the server reauthorizes every call.
4. Use a cached discovery snapshot only while its context, digest, epoch, and client-configured freshness remain valid.
5. Select operations by current semantic contract and schema. Report an absent operation distinctly from denial, timeout, or provider authorization failure.

Read [CRM operations](references/crm-operations.md) for source selection, caching, streaming, mutations, and reconciliation rules.

## Handle CRM work

- Omit source selection for general requests so the service resolves all enabled and authorized sources.
- Resolve explicit sources from current server-returned opaque handles. Display labels never become routing keys.
- Issue one provider-neutral operation for a logical federated query. The server owns source fan-out, concurrency, provider translation, and source recovery.
- Show whether each result set is cached or fresh and show its last-updated time in the user's local time using readable wording.
- Render only server-returned source lifecycle events as progressive execution evidence. Finish with one terminal reconciled result.
- Keep source-native records distinct. Merge or link only when the user asks or the discovered MCP operation explicitly supports it; retain provenance for every field.
- Treat a mutation within one source according to its declared guarantee. Preserve server-returned reconciliation actions for uncertain outcomes.
- Limit updates and deletes to one exact affected source record per logical task. Block unknown or multi-record scope. Confirm every prepared delete after showing its exact organization, source, record, version, semantics, and consequences.
- Include tool-reported usage in the final result. If token usage is available from the host, include it as a separate client execution measure.

## Explain a request

When the user says `explain` or asks for a plan, produce a read-only plan and stop before the data operation. Include:

- organization and application scope;
- discovery or cached-discovery decision;
- semantic capabilities and skills selected;
- one service invocation and server-deferred or explicit opaque source scope;
- normalized query parameters without secrets;
- cache and freshness policy;
- merge, attribution, and error behavior;
- mutation approvals, transactional boundaries, and recovery behavior;
- expected graph or tool calls through the stack.

Do not execute the planned CRM operation unless the user also asks to proceed.

## Build CRM automations

Use `my-crm-automation` and [FSM authoring](references/fsm-authoring.md). Generate a declarative graph from user intent using only capability identifiers present in the current contract. Submit it only through graph operations advertised on the My CRM connection.

Fail closed when graph operations are absent. Provide the local draft and the missing semantic operation without calling a speculative endpoint.

## Route to focused expertise

- Use `my-crm-record-operations` for exact lookup, search, list, create, update, and delete.
- Use `my-crm-pipeline-operations` for stages, ownership, status, value, and next actions.
- Use `my-crm-activity-operations` for source-attributed timelines.
- Use `my-crm-federation-operations` for comparison, merged presentation, conflicts, and supported reconciliation.
- Use `my-crm-customer-journey` whenever displaying a lead or explaining its graph position and routes.
- Use `my-crm-automation` for FSM explain, generation, validation, installation, activation, and invocation.

## Safety boundary

- Never access a provider API, database, credential store, or private BOS route directly.
- Never hard-code provider brands or assume all organizations have the same sources.
- Never invent a capability identifier or silently substitute a similar operation.
- Never claim cross-source atomicity or perform client-side per-source recovery.
- Preserve organization, application, user, role, and request context across every MCP call.
