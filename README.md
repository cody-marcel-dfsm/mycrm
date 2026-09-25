# My CRM

My CRM is the first independently built, Apache-2.0 CRM-expertise plugin for BOS and the first independently owned external product in the BOS Product Family. It is the reference implementation showing how an outside company can build a client agent or plugin against the BOS operating system through published authenticated discovery and deterministic HTTPS contracts. My CRM contains no BOS source dependency, authentication client, source adapter, database access, or execution runtime.

## What it owns

My CRM interprets natural-language CRM intent, selects focused domain skills, consumes current organization-defined entity and operation metadata, and presents source-preserving results. It reasons when records may describe one conceptual customer while retaining every source record, provenance item, conflict, confidence statement, and uncertainty.

The installed BOS product owns the authenticated connection, login and recovery, authority, discovery transport, source federation, deterministic execution, idempotency, retries, receipts, shared-cache binding, explain planning, BOSL authoring, and journey runtime. My CRM delegates the exact affected protected resource plus the bounded `{category, code, source}` recovery condition automatically, remains pending through BOS-owned host action, asks BOS to invalidate the current private cache authority, refreshes discovery when BOS reports ready, and resumes the same public operation once.

## Public-contract flow

1. Ask installed BOS discovery for the current application operations.
2. Request Describe for one to five public operation keys needed by the task.
3. Copy complete source references, schemas, limits, guarantees, errors, and exact HTTPS methods and URIs.
4. Pass the entire current described-operation object unchanged to the installed BOS dependency adapter. This includes its operation, status, execution, input and output schemas, effect, limits, guarantees, error contract, and sources. When `execution.context_header` is present, validate the literal `X-BOS-Context-Handle` marker without constructing its value. Delegate returned journey lifecycle and state actions to that adapter unchanged. BOS selects and attaches the current fresh opaque identity-v2 handle for every protected path; My CRM never receives or stores its value.
5. Let BOS invoke only that operation's returned deterministic HTTPS contract and validate the public response against its current output or error schema.
6. Present live or shared-cache origin, local-time freshness, source coverage, guarantees, public failures, and recovery instructions.

General searches omit a source so BOS owns federation. Explicit-source requests copy the entire discovered `{platform, application, plugin}` reference. Update and delete requests carry one to five explicit source records for one conceptual customer. My CRM supplies no organization selector, credential, client ID, idempotency key, retry state, execution ID, source ID, or internal identifier.

## Package and release candidate

The distributable contains source-first record, pipeline, activity, federation, customer-journey, automation, and shared-cache maintenance skills, public consumer schemas, examples, and pure client helpers. Its `.bos-product.json` metadata requires BOS, names BOS as the connection owner, and declares automatic authentication handoff. It contains no `.mcp.json`, resource URL, token, second MCP connection, or OAuth binding. My CRM consumes its independently scoped CRM discovery and semantics through the installed BOS connection and current Lead Director MCP/Describe contracts. The frozen BOS Service and BOS Operations Center dependency-v2 contracts are imported; final release validation remains held for native/live acceptance.

`npm run build` creates a deterministic Codex plugin release candidate under `dist/my-crm`. The candidate includes the skills-only plugin, public consumer contracts, examples, pure client helpers, license, notice, and a complete content-digest manifest. `npm run release:check` rebuilds it, runs the full suite, and verifies byte parity with canonical sources. The repository-local marketplace at `.agents/plugins/marketplace.json` points only to this built candidate. It adds no MCP or authentication binding.

The versioned Lead Director artifacts under `contracts/bos/lead-director/v1/`
and journey-consumer artifacts under `contracts/bos/service-journey/v1/` are
byte-exact copies of the deployed immutable BOS Service public release.
Import provenance records the archive, manifest, bundle, source revision,
deployed revision, and image digest. Package validation pins the complete
public inventory, checks every published digest, verifies Describe, CRUD, and
`api.contract.get` parity, and validates the canonical
`client_action_required` example against its published schema and the My CRM
consumer. The private `api.contract.get` artifacts are release-conformance
evidence for BOS-owned explain planning and BOSL authoring; My CRM delegates
that flow to installed BOS skills and does not invoke the contract from its
runtime.

Import an updated committed BOS bundle only from an immutable archive with externally verified digests:

```bash
npm run contracts:import -- \
  --archive /absolute/path/to/lead-director-public-contract.tgz \
  --sha256 <archive-sha256> \
  --source-revision <full-40-character-bos-commit>
```

The importer rejects links, path traversal, extra files, missing files, wrong contract identity, unapproved authentication impact, and digest mismatches. It accepts the owner-approved identity-v2 context-marker release only when the manifest also asserts that OAuth login, token, grant, callback, and session behavior is unchanged. Add `--check` to prove the committed copy is byte-identical without changing files.

For a deployed BOS Service release, import the sanitized public-only composite
archive so the Lead Director and journey-consumer contracts advance together:

```bash
npm run contracts:import-bos-service -- \
  --archive /absolute/path/to/bos-service-public-consumer-contract.tgz \
  --archive-sha256 <archive-sha256> \
  --bundle-sha256 <embedded-lead-director-bundle-sha256> \
  --source-revision <full-40-character-bos-commit> \
  --artifact-status deployed_staging \
  --deployed-revision <cloud-run-revision> \
  --image-digest sha256:<deployed-image-digest>
```

This importer accepts only the exact public schemas, examples, manifest,
consumer documentation, and provenance. It rejects private implementation or
Vault design files and updates both contract families as one rollback-safe
operation.

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

Import the BOS Operations Center client seam only from its immutable
public-contract archive and externally verified archive, manifest, and bundle
digests:

```bash
npm run contracts:import-boc-client -- \
  --archive /absolute/path/to/bos-client-dependency-v1.tgz \
  --archive-sha256 <archive-sha256> \
  --manifest-sha256 <manifest-sha256> \
  --bundle-sha256 <bundle-sha256> \
  --source-revision <full-40-character-boc-commit> \
  --boc-version <semantic-version>
```

The importer enforces the exact public inventory and schema identity, verifies
every contract-file digest, verifies the ordered executable-file bindings, and
recomputes the bundle digest over both sets. My CRM receives the ready cache
consumer accepted by the installed BOS public helper; it has no cache
constructor and supplies no cache binding, authority, user digest, or cache
root.

My CRM contributes CRM goals and constraints to BOS-owned explain planning and BOSL authoring. It validates structured CRM client instructions and delegates returned lifecycle actions verbatim to the installed BOS dependency adapter. Each action has exactly `{verb, method, href, payload_schema}`; My CRM adds no route, header, identity, or authority state. The BOS adapter owns the protected invocation and authentication recovery. My CRM implements no local FSM/BOSL compiler or executor.

CRM audience repair follows the same boundary. My CRM reasons from the returned sanitized recipient failure, recommends the minimum correction, obtains user permission before a CRM mutation, and completes the returned client step with only its advertised acknowledgment. BOS re-queries and rematerializes the audience. Any changed audience requires campaign reprepare and fresh approval before send; My CRM never transports recipients or a server-held list reference through a lifecycle action.

The [CRM consumer examples](examples/crm/README.md) distinguish discovered and copied contract values from My CRM-owned reasoning for search, conceptual reconciliation, targeted mutation, and journey continuation.

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
Immutable public-contract imports pass the same privacy audit before any
candidate file is installed into the repository.

Install and verify the local release candidate through the supported Codex plugin CLI after BOS is installed and enabled:

```bash
npm run install:local
npm run install:verify
```

The installer uses `codex plugin marketplace add` and `codex plugin add`. Release versions are immutable: when the same version is already installed, the tool verifies its cached bytes and returns without rewriting them; changed bytes require a version bump. Installing a new version never removes the working candidate first and never patches the plugin cache. Runtime verification checks the copied My CRM bytes returned by Codex against the release manifest, verifies every installed BOS adapter/cache executable against the imported BOC manifest, confirms installed BOS is the dependency, and confirms My CRM still declares no MCP or app binding.

Rollback removes only this local candidate through the native CLI; it leaves BOS and its authenticated connection intact:

```bash
codex plugin remove my-crm@my-crm-local
```

Live staging conformance is a separate authorized gate because it uses the installed native Codex runtime and authenticated BOS connection. The entrypoint requires a server-advertised synthetic acceptance context, generates a unique `example.invalid` query, performs BOS application discovery, task-scoped Describe, and the exact discovered read-only CRM search, then validates the public contract, source attribution, freshness presentation, and conceptual-customer assessment. It refuses real-customer contexts and performs no business mutation or identity-bearing request:

```bash
MYCRM_LIVE_ACCEPTANCE=1 npm run test:live
```

When native BOS sign-in or a server-advertised synthetic acceptance context is required, the result is `HOST_ACTION_REQUIRED`; the BOS product and host retain authentication ownership. Set `MYCRM_LIVE_EVIDENCE_OUT` to a new file path to preserve sanitized machine-readable evidence. Local and live contract acceptance use only generated tenant-neutral fixtures under reserved invalid domains.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
