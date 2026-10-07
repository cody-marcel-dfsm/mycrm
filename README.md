# My CRM

## Understand your customers and their next actions

My CRM helps teams understand customer records, pipeline status, activity, and next actions across their authorized CRM systems. It applies provider-neutral CRM expertise through BOS, the service gateway for controlled execution of permissioned workflows. Your service infrastructure, authoritative business state, data stores, and private implementation IP stay outside the agent host; authorized inputs, results, public skills, and permitted scoped caches can reach the AI workspace.

**Requires BOS.** Install the separate BOS product and use its existing authenticated connection. BOS enforces your roles, rules, and approval gates and owns service execution and audit. My CRM presents the evidence you need to evaluate an outcome: source records, observation times, coverage, conflicts, uncertainty, and partial failures. Changes across sources are non-atomic and preserve each source's declared guarantee.

### Who it helps

Use My CRM when your team needs to find or compare customer records, understand currently advertised pipeline and activity information, or review an application's customer journey. Each task uses the operations available in your authorized BOS scope. Multi-step workflow participation depends on the required live BOS authoring and runtime contracts.

### Evaluate access

BOS business access is pre-launch and invite-only. [Request an invite](https://dfsm.ai/apps/bos/#request-invite) to discuss your CRM use case. An invite request does not promise access, and installing the public My CRM package does not grant permission to business services.

This Apache-2.0 repository is public. Its supported installation path builds a versioned package and adds it through a local custom Codex marketplace after BOS is installed and enabled. Repository availability, local installation, and publication in an official ChatGPT or Codex directory are separate stages. The commands appear under [Validate](#validate).

### A synthetic example

“Find the synthetic CRM record named Rivera and show its current details; read only.” My CRM uses current BOS discovery and the advertised HTTPS read contract, then presents the returned source evidence and freshness. A missing record, unavailable operation, or incomplete source response is reported as that outcome. This illustrates a supported task shape; it supplies no customer story or live readiness claim.

### For builders

My CRM is independently built and released and demonstrates an external domain client consuming published BOS discovery and deterministic HTTPS contracts. Its package owns CRM reasoning, skills, examples, and thin client helpers. The technical ownership and contract flow follow below.

## What it owns

My CRM interprets natural-language CRM intent, selects focused domain skills, consumes current organization-defined entity and operation metadata, and presents source-preserving results. It reasons when records may describe one conceptual customer while retaining every source record, provenance item, conflict, confidence statement, and uncertainty.

The installed BOS product owns the authenticated connection, login and recovery, authority, discovery transport, source federation, deterministic execution, idempotency, receipts, shared-cache binding, explain planning, BOSL authoring, and journey runtime. My CRM invokes exact discovered operation contacts through the configured BOS-authenticated HTTPS transport. On an established uppercase handoff condition or challenged HTTP 401, My CRM asks BOS to recover through `READY`, refreshes discovery, re-Describes the operation, and retries the exact preserved request once.

## Public-contract flow

1. Ask installed BOS discovery for the current application operations.
2. Request Describe for one to five public operation keys needed by the task.
3. Copy complete source references, schemas, limits, guarantees, errors, and exact HTTPS methods and URIs.
4. Invoke the advertised endpoint through the configured authenticated BOS connection. My CRM supplies only values allowed by the current discovered input schema and never constructs an authority selector, authentication header, context handle, route, or provider binding.
5. Validate the response against the current discovered output or error schema.
6. Present live or shared-cache origin, local-time freshness, source coverage, guarantees, public failures, and recovery instructions.

General searches omit a source so BOS owns federation. Explicit-source requests copy the entire discovered `{platform, application, plugin}` reference. Update and delete requests carry one to five explicit source records for one conceptual customer. My CRM supplies no organization selector, credential, client ID, idempotency key, retry state, execution ID, source ID, or internal identifier.

## Package and release candidate

The distributable contains source-first record, pipeline, activity, federation, customer-journey, automation, and cache-maintenance skills, examples, and My CRM client helpers. Its `.bos-product.json` metadata requires BOS, names BOS as the connection owner, declares automatic authentication handoff, and advertises the canonical `lead_director_*` package-verification tools through that dependency. It contains no `.mcp.json`, resource URL, token, second MCP connection, OAuth binding, BOS Service or BOS Operations Center contract, schema, manifest, archive, provenance record, or executable adapter. My CRM knows only the configured BOS discovery URL, discovers current operations and schemas dynamically from authenticated BOS discovery APIs, and invokes the advertised endpoints through BOS authenticated transport.

`npm run build` creates a deterministic Codex plugin release candidate under `dist/my-crm`. The candidate includes the skills-only plugin, examples, My CRM client helpers, license, and notice. `npm run release:check` rebuilds it, runs the full suite, and verifies package-boundary conformance. The repository-local marketplace at `.agents/plugins/marketplace.json` points only to this built candidate. It adds no MCP or authentication binding and carries no frozen BOS server or client artifact.

Local contract tests generate tenant-neutral synthetic discovery-service responses at test time. They exercise discovery and Describe recovery through BOS readiness, fresh schema selection, exact advertised endpoint invocation, My CRM-owned bounded continuation, response validation, and contract evolution without loading a frozen BOS Service or BOS Operations Center copy.

My CRM contributes CRM goals and constraints to BOS-owned explain planning and BOSL authoring. It validates structured CRM client instructions and invokes returned lifecycle actions through the configured authenticated BOS connection. Each action has exactly `{verb, method, href, payload_schema}`; My CRM adds no route, header, identity, or authority state. BOS owns protected invocation and authentication recovery. My CRM implements no local FSM/BOSL compiler or executor.

CRM audience repair follows the same boundary. My CRM reasons from the returned sanitized recipient failure, recommends the minimum correction, obtains user permission before a CRM mutation, and completes the returned client step with only its advertised acknowledgment. BOS re-queries and rematerializes the audience. Any changed audience requires campaign reprepare and fresh approval before send; My CRM never transports recipients or a server-held list reference through a lifecycle action.

The [CRM consumer examples](examples/crm/README.md) distinguish values copied at runtime from current discovery responses from My CRM-owned reasoning for search, conceptual reconciliation, targeted mutation, and journey continuation.

## Validate

```bash
npm test
npm run release:check
npm run vault:sync
```

`npm test` runs the privacy gate across source, tests, fixtures, documentation,
and Vault; release build/check run it again against the generated package. The
gate rejects non-reserved email addresses, UUID values, BOS context-handle
values, and identity-bearing evidence fields. A centrally managed customer
denylist can augment these generic patterns without entering this repository:

```bash
MYCRM_PRIVACY_DENYLIST_FILE=/absolute/path/outside/MyCRM/customer-identifiers.txt npm run check:privacy
```

The denylist path must resolve outside this repository. Its values are never
copied into source, logs, Vault, evidence, or the release package.
Synthetic discovery responses pass the same privacy audit before they are
retained as My CRM test evidence.

Install and verify the local release candidate through the supported Codex plugin CLI after BOS is installed and enabled:

```bash
npm run install:local
npm run install:verify
```

The installer uses `codex plugin marketplace add` and `codex plugin add`. Release versions are immutable: when the same version is already installed, the tool verifies its cached bytes and returns without rewriting them; changed bytes require a version bump. Installing a new version never removes the working candidate first and never patches the plugin cache. Runtime verification checks the installed My CRM package boundary, confirms installed BOS is the dependency, verifies the exact canonical `lead_director_*` package-verification set, and confirms My CRM declares no MCP or app binding and packages no BOS contracts, schemas, manifests, archives, provenance, or executables.

Rollback removes only this local candidate through the native CLI; it leaves BOS and its authenticated connection intact:

```bash
codex plugin remove my-crm@my-crm-local
```

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
