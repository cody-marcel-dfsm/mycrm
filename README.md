# My CRM

My CRM is an independent Apache-2.0 reference plugin for building a native GPT
integration on BOS. It proves that a developer can own, test, package, and
publish a BOS application from an independent repository using the public
product MCP contract.

My CRM extends the basic Lead Director CRM skills currently distributed with
BOS Operations Center. Lead Director remains focused on basic sales-flow lead
interactions during the transition. My CRM owns the broader CRM experience and
is the planned successor to that embedded skill set once replacement acceptance
is complete.

The plugin gives GPT provider-neutral record, pipeline, activity, federation,
journey, and automation skills. It requires the separately installed BOS
product for platform identity and discovery. My CRM owns its product-scoped
OAuth connection; BOS supplies authenticated execution, service integration,
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

## Product connection

The distributable uses the universal OpenAI plugin structure: skills plus one
required product-owned remote MCP server declaration. The sealed resource is:

`https://dfsm.ai/mcp/apps/leaddirector/crm`

The MCP declaration uses this exact URL as `oauth_resource`, requires the
connection during startup, and assigns 180 seconds to startup and tool calls.
The package contains no `.app.json`, token, API key, authorization header, or
customer identifier. ChatGPT/Codex performs OAuth discovery from the product
resource.

My CRM requires the BOS plugin as a product dependency. BOS resolves the
authenticated organization and installed-app directory. My CRM executes CRM
work only through its own product connection.

The current `/leaddirector/crm` resource name is server routing metadata for the
published CRM capability group. It does not make Lead Director a client-side
runtime or source-system dependency of My CRM.

## Automation contract

The client generates structurally valid provider-neutral FSM documents from
capability identifiers present in current discovery. It validates, installs,
activates, or invokes a graph only when the live My CRM MCP advertises the
corresponding operation and schema. The client contains no speculative REST
endpoint and creates no server or database state of its own.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
