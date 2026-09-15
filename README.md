# My CRM

My CRM is an independent Apache-2.0 reference plugin for building a native GPT
integration on BOS. It proves that a developer can own, test, package, and
publish a BOS application from an independent repository using public
authenticated discovery and deterministic HTTPS contracts.

My CRM extends the basic Lead Director CRM skills currently distributed with
BOS Operations Center. Lead Director remains focused on basic sales-flow lead
interactions during the transition. My CRM owns the broader CRM experience and
is the planned successor to that embedded skill set once replacement acceptance
is complete.

The plugin gives GPT provider-neutral record, pipeline, activity, federation,
journey, and automation skills. It requires the separately installed BOS
product for platform identity, OAuth, and recovery. My CRM
owns a host-managed authenticated MCP connection and the CRM skills that consume
its application discovery resources. BOS supplies authentication, service integration,
authorization, graph runtime, audit, and lifecycle management.

## Repository boundary

This repository consumes only published BOS contracts and authenticated HTTPS
or MCP endpoints. It contains no workspace dependency, import, symlink, or
build step into a BOS-owned repository.

## Layout

- `plugins/my-crm/` — native ChatGPT/Codex plugin package.
- `src/fsm/` — deterministic CRM automation graph generator.
- `src/bos/` — public BOS developer API client.
- `contracts/` — versioned public schemas required by the integration.
- `examples/` — a conforming CRM automation example.
- `scripts/` — boundary, contract, Vault, and registration tooling.
- `Vault/` — private project requirements, architecture, decisions,
  specifications, evidence, and reviews; excluded from Git and packages.

## Validate

```bash
npm test
npm run vault:sync
```

## Product connection target

The distributable uses the universal OpenAI plugin structure: skills plus one
required product-owned host connection to an application-scoped MCP resource.
The MCP describes current semantic operations, schemas, documentation, resource
audience, and deterministic HTTPS API contracts. My CRM invokes those APIs for
business execution. The BOS server contains no My CRM-specific route, service,
resource, registration, skill group, or release metadata.

The current `0.2.0` prototype still declares the retired
`https://dfsm.ai/mcp/apps/leaddirector/crm` resource and attempts business
operations through MCP. That resource returns HTTP 404 and the implementation
requires replacement before release.

The final MCP declaration will use its exact application-scoped resource as
`oauth_resource`, require the connection during startup, and retain bounded
startup and call budgets.

The package contains no `.app.json`, token, API key, authorization header,
customer identifier, OAuth endpoint configuration, login flow, token storage,
or refresh implementation.

My CRM requires the BOS plugin as a product dependency. The BOS plugin and its
skills establish or recover OAuth through the host. The BOS service binds that
grant to one organization, application, installation, and role; My CRM receives
no authority selector. My CRM discovers the current API contract through its
authenticated application MCP and executes CRM work through the advertised
deterministic HTTPS API. Authentication failures return to BOS for recovery.

Authentication recovery is an automatic continuation. My CRM preserves the
pending CRM request, delegates the challenge to BOS, refreshes its authenticated
MCP discovery after recovery, and resumes the original operation once. My CRM
does not return login instructions, send the user to settings, or ask them to
repeat the CRM request. The host may display its native consent action while BOS
keeps the operation active.

## Automation contract

My CRM contributes CRM goals, semantics, constraints, and parameters to BOS-owned
explain planning and BOSL authoring. Graph validation, registration, activation,
invocation, status, and reconciliation use only deterministic HTTPS operations
advertised by current application discovery. My CRM contains no local BOSL
compiler or runtime executor and creates no server or database state of its own.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
