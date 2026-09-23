# My CRM

My CRM is the first independently built, Apache-2.0 CRM-expertise plugin for BOS and the first independently owned external product in the BOS Product Family. It is the reference implementation showing how an outside company can build a client agent or plugin against the BOS operating system through published authenticated discovery and deterministic HTTPS contracts. My CRM contains no BOS source dependency, authentication client, source adapter, database access, or execution runtime.

## What it owns

My CRM interprets natural-language CRM intent, selects focused domain skills, consumes current organization-defined entity and operation metadata, and presents source-preserving results. It reasons when records may describe one conceptual customer while retaining every source record, provenance item, conflict, confidence statement, and uncertainty.

The installed BOS product owns the authenticated connection, login and recovery, authority, discovery transport, source federation, deterministic execution, idempotency, retries, receipts, explain planning, BOSL authoring, and journey runtime. My CRM delegates the exact affected protected resource plus the bounded `{category, code, source}` recovery condition automatically, remains pending through BOS-owned host action, invalidates the prior authority cache partition, refreshes discovery when BOS reports ready, and resumes the same public operation once.

## Public-contract flow

1. Ask installed BOS discovery for the current application operations.
2. Request Describe for one to five public operation keys needed by the task.
3. Copy complete source references, schemas, limits, guarantees, errors, and exact HTTPS methods and URIs.
4. When `execution.context_header` is present, validate the literal `X-BOS-Context-Handle` marker and delegate the complete contact to the installed BOS dependency adapter. Delegate returned journey lifecycle and state actions to that adapter unchanged. BOS selects and attaches the current fresh opaque identity-v2 handle for both paths; My CRM never receives or stores its value.
5. Invoke only the returned deterministic HTTPS contract.
6. Present live or shared-cache origin, local-time freshness, source coverage, guarantees, public failures, and recovery instructions.

General searches omit a source so BOS owns federation. Explicit-source requests copy the entire discovered `{platform, application, plugin}` reference. Update and delete requests carry one to five explicit source records for one conceptual customer. My CRM supplies no organization selector, credential, client ID, idempotency key, retry state, execution ID, source ID, or internal identifier.

## Package and release candidate

The distributable contains source-first record, pipeline, activity, federation, customer-journey, automation, and shared-cache maintenance skills, public consumer schemas, examples, and pure client helpers. Its `.bos-product.json` metadata requires BOS, names BOS as the connection owner, and declares automatic authentication handoff. It contains no `.mcp.json`, resource URL, token, second MCP connection, or OAuth binding. My CRM consumes its independently scoped CRM discovery and semantics through the installed BOS connection and current Lead Director MCP/Describe contracts. The frozen BOS Service and BOS Operations Center dependency-v2 contracts are imported; final release validation remains held for native/live acceptance.

`npm run build` creates a deterministic Codex plugin release candidate under `dist/my-crm`. The candidate includes the skills-only plugin, public consumer contracts, examples, pure client helpers, license, notice, and a complete content-digest manifest. `npm run release:check` rebuilds it, runs the full suite, and verifies byte parity with canonical sources. The repository-local marketplace at `.agents/plugins/marketplace.json` points only to this built candidate. It adds no MCP or authentication binding.

The versioned Lead Director consumer artifacts under `contracts/bos/lead-director/v1/` are byte-exact copies of an Oracle-approved BOS public contract release. `contracts/bos/lead-director/import-provenance.json` records its immutable archive, manifest, bundle, and source-revision evidence. Package validation pins the complete eleven-file inventory, checks every manifest-listed digest, and verifies Describe, CRUD, and `api.contract.get` example/schema parity. The private `api.contract.get` artifacts are release-conformance evidence for BOS-owned explain planning and BOSL authoring; My CRM delegates that flow to installed BOS skills and does not invoke the contract from its runtime.

Import an updated committed BOS bundle only from an immutable archive with externally verified digests:

```bash
npm run contracts:import -- \
  --archive /absolute/path/to/lead-director-public-contract.tgz \
  --sha256 <archive-sha256> \
  --source-revision <full-40-character-bos-commit>
```

The importer rejects links, path traversal, extra files, missing files, wrong contract identity, unapproved authentication impact, and digest mismatches. It accepts the owner-approved identity-v2 context-marker release only when the manifest also asserts that OAuth login, token, grant, callback, and session behavior is unchanged. Add `--check` to prove the committed copy is byte-identical without changing files.

Import the published BOS Operations Center dependency-v2 schema and contract
only with their externally verified digests, full committed source revision,
release version, and BOS-only adapter source provenance:

```bash
npm run contracts:import-boc -- \
  --schema /absolute/path/to/external-product-dependency.v2.schema.json \
  --schema-sha256 <schema-sha256> \
  --contract /absolute/path/to/external-product-dependency.v2.md \
  --contract-sha256 <contract-sha256> \
  --source-revision <full-40-character-boc-commit> \
  --adapter-sha256 <adapter-source-sha256> \
  --boc-version <semantic-version>
```

The importer copies only the two verified public artifacts and records their
immutable provenance. It creates no sibling-source, build, or runtime
dependency.

My CRM contributes CRM goals and constraints to BOS-owned explain planning and BOSL authoring. It validates structured CRM client instructions and delegates returned lifecycle actions verbatim to the installed BOS dependency adapter. Each action has exactly `{verb, method, href, payload_schema}`; My CRM adds no route, header, identity, or authority state. The BOS adapter owns the protected invocation and authentication recovery. My CRM implements no local FSM/BOSL compiler or executor.

CRM audience repair follows the same boundary. My CRM reasons from the returned sanitized recipient failure, recommends the minimum correction, obtains user permission before a CRM mutation, and completes the returned client step with only its advertised acknowledgment. BOS re-queries and rematerializes the audience. Any changed audience requires campaign reprepare and fresh approval before send; My CRM never transports recipients or a server-held list reference through a lifecycle action.

The [CRM consumer examples](examples/crm/README.md) distinguish discovered and copied contract values from My CRM-owned reasoning for search, conceptual reconciliation, targeted mutation, and journey continuation.

## Validate

```bash
npm test
npm run release:check
npm run vault:sync
```

Install and verify the local release candidate through the supported Codex plugin CLI after BOS is installed and enabled:

```bash
npm run install:local
npm run install:verify
```

The installer uses `codex plugin marketplace add` and `codex plugin add`. Release versions are immutable: when the same version is already installed, the tool verifies its cached bytes and returns without rewriting them; changed bytes require a version bump. Installing a new version never removes the working candidate first and never patches the plugin cache. Runtime verification checks the copied cache bytes returned by Codex against the release manifest, confirms installed BOS is the dependency, and confirms My CRM still declares no MCP or app binding.

Rollback removes only this local candidate through the native CLI; it leaves BOS and its authenticated connection intact:

```bash
codex plugin remove my-crm@my-crm-local
```

Live staging conformance is a separate authorized gate because it uses the installed native Codex runtime and authenticated BOS connection. The entrypoint performs BOS application discovery, task-scoped Describe, and the exact discovered read-only CRM search for `cody.marcel@dfsm.ai`. It validates the returned public contract and asserts source attribution, freshness presentation, and conceptual-customer assessment. It performs no business mutation and accepts no organization, authority, credential, token, installation, role, internal, or provider identifier:

```bash
MYCRM_LIVE_ACCEPTANCE=1 npm run test:live
```

When native BOS sign-in is required, the result is `HOST_ACTION_REQUIRED`; the BOS product and host retain authentication ownership. Set `MYCRM_LIVE_EVIDENCE_OUT` to a new file path to preserve sanitized machine-readable evidence. Local contract tests use sanitized source-neutral fixtures. The controlled read-only attendee for separately authorized end-to-end acceptance is `cody.marcel@dfsm.ai`.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
