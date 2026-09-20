# My CRM

My CRM is an independent Apache-2.0 CRM-expertise plugin for BOS. It consumes published authenticated discovery and deterministic HTTPS contracts as an external developer. It contains no BOS source dependency, authentication client, source adapter, database access, or execution runtime.

## What it owns

My CRM interprets natural-language CRM intent, selects focused domain skills, consumes current organization-defined entity and operation metadata, and presents source-preserving results. It reasons when records may describe one conceptual customer while retaining every source record, provenance item, conflict, confidence statement, and uncertainty.

The installed BOS product owns the authenticated connection, login and recovery, authority, discovery transport, source federation, deterministic execution, idempotency, retries, receipts, explain planning, BOSL authoring, and journey runtime. My CRM delegates authentication automatically, refreshes discovery when BOS reports ready, and resumes the same public operation once.

## Public-contract flow

1. Ask installed BOS discovery for the current application operations.
2. Request Describe for one to five public operation keys needed by the task.
3. Copy complete source references, schemas, limits, guarantees, errors, and exact HTTPS methods and URIs.
4. Invoke only the returned deterministic HTTPS contract.
5. Present live or shared-cache origin, local-time freshness, source coverage, guarantees, public failures, and recovery instructions.

General searches omit a source so BOS owns federation. Explicit-source requests copy the entire discovered `{platform, application, plugin}` reference. Update and delete requests carry one to five explicit source records for one conceptual customer. My CRM supplies no organization selector, credential, client ID, idempotency key, retry state, execution ID, source ID, or internal identifier.

## Package and release candidate

The distributable contains seven source-first skills, public consumer schemas, examples, and pure client helpers. Its product metadata requires BOS and declares the BOS-owned connection. It declares no second MCP or OAuth binding. [Official OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) currently documents bundled MCP connections, registered app mappings, and skills-only packages; it does not document a cross-plugin shared-connection declaration. The approved independently scoped My CRM MCP declaration therefore remains a blocking host prerequisite. The package is intentionally skills-only until a supported declaration can reuse the established BOS connection.

`npm run build` creates a deterministic Codex plugin release candidate under `dist/my-crm`. The candidate includes the skills-only plugin, public consumer contracts, examples, pure client helpers, license, notice, and a complete content-digest manifest. `npm run release:check` rebuilds it, runs the full suite, and verifies byte parity with canonical sources. The repository-local marketplace at `.agents/plugins/marketplace.json` points only to this built candidate. It adds no MCP or authentication binding.

The versioned Lead Director consumer artifacts under `contracts/bos/lead-director/v1/` are byte-exact copies of an Oracle-approved BOS public contract release. `contracts/bos/lead-director/import-provenance.json` records its immutable archive, manifest, bundle, and source-revision evidence. Package validation pins the complete eleven-file inventory, checks every manifest-listed digest, and verifies Describe, CRUD, and `api.contract.get` example/schema parity. The private `api.contract.get` artifacts are release-conformance evidence for BOS-owned explain planning and BOSL authoring; My CRM delegates that flow to installed BOS skills and does not invoke the contract from its runtime.

Import an updated committed BOS bundle only from an immutable archive with externally verified digests:

```bash
npm run contracts:import -- \
  --archive /absolute/path/to/lead-director-public-contract.tgz \
  --sha256 <archive-sha256> \
  --source-revision <full-40-character-bos-commit>
```

The importer rejects links, path traversal, extra files, missing files, wrong contract identity, authentication-impacting bundles, and digest mismatches. Add `--check` to prove the committed copy is byte-identical without changing files.

My CRM contributes CRM goals and constraints to BOS-owned explain planning and BOSL authoring. It validates structured CRM client instructions and invokes returned lifecycle actions verbatim. It implements no local FSM/BOSL compiler or executor.

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

Live staging conformance is a separate authorized gate because it uses the installed native Codex runtime and authenticated BOS connection. The entrypoint performs only BOS application discovery and task-scoped Describe for Lead Director search; it performs no business mutation and accepts no organization, authority, credential, token, installation, role, internal, or provider identifier:

```bash
MYCRM_LIVE_ACCEPTANCE=1 npm run test:live
```

When native BOS sign-in is required, the result is `HOST_ACTION_REQUIRED`; the BOS product and host retain authentication ownership. Set `MYCRM_LIVE_EVIDENCE_OUT` to a new file path to preserve sanitized machine-readable evidence. Local contract tests use sanitized source-neutral fixtures. The controlled read-only attendee for separately authorized end-to-end acceptance is `cody.marcel@dfsm.ai`.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
