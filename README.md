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
owns the CRM skills and MCP contract that consume its application discovery
resources. One host-managed BOS connection authenticates every accessible MCP;
the My CRM MCP delegates authentication to the BOS plugin and declares no
second login, OAuth binding, token, or credential lifecycle. BOS supplies
authentication, service integration, authorization, graph runtime, audit, and
lifecycle management.

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

## Authentication and MCP target

The distributable uses the universal OpenAI plugin structure: skills, its MCP
contract, and a required BOS product dependency. The My CRM MCP operates through
the established BOS connection. It describes current semantic operations,
schemas, documentation, resource audience, and deterministic HTTPS API
contracts. My CRM invokes those APIs for business execution. The BOS server
contains no My CRM-specific route, service, resource, registration, skill
group, or release metadata.

The current `0.2.0` prototype still declares the retired
`https://dfsm.ai/mcp/apps/leaddirector/crm` resource and attempts business
operations through MCP. Its package metadata also declares a separate My CRM
connection. Those behaviors are nonconforming and require replacement before
release.

The final MCP declaration will expose the application-scoped My CRM contract
through the BOS-authenticated transport, delegate authentication to the BOS
plugin, and retain bounded startup and call budgets without creating a second
authenticated connection.

The package contains no `.app.json`, token, API key, authorization header,
customer identifier, OAuth endpoint configuration, login flow, token storage,
or refresh implementation.

My CRM requires the BOS plugin as a product dependency. The BOS plugin and its
skills establish or recover the BOS connection through the host. The BOS
service revalidates the exact organization, application, installation, role,
capability, and provider authority for every operation; My CRM receives no
authority selector. My CRM discovers the current API contract through its MCP
on the BOS-authenticated transport and executes CRM work through the advertised
deterministic HTTPS API. Authentication failures delegate to BOS for recovery.

Authentication recovery is an automatic continuation. My CRM preserves the
pending CRM request, delegates the challenge to BOS, refreshes its authenticated
MCP discovery through the BOS connection after recovery, and resumes the original operation once. My CRM
does not return login instructions, send the user to settings, or ask them to
repeat the CRM request. The host may display its native consent action while BOS
keeps the operation active.

## Automation contract

My CRM contributes CRM goals, semantics, constraints, and parameters to
BOS Operations Center client-owned explain planning and BOSL authoring. Graph
validation, registration, activation, invocation, status, and reconciliation
use only deterministic HTTPS operations advertised by current application
discovery. My CRM contains no local BOSL compiler or runtime executor and
creates no server or database state of its own.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
