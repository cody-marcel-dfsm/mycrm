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

## Package

The distributable contains seven source-first skills, public consumer schemas, examples, and pure client helpers. Its product metadata requires BOS and declares the BOS-owned connection. It declares no second MCP or OAuth binding. [Official OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) currently documents bundled MCP connections, registered app mappings, and skills-only packages; it does not document a cross-plugin shared-connection declaration. The approved independently scoped My CRM MCP declaration therefore remains a blocking host prerequisite. The package is intentionally skills-only until a supported declaration can reuse the established BOS connection.

The versioned Lead Director consumer artifacts under `contracts/bos/lead-director/v1/` are byte-exact copies of the current Oracle-approved BOS public contract release `bos-public-contract-release/v1`, bundle digest `fd73779783242b4420dc72d7d8ade232f5adbc318ae69261b584b2b5dcfd5367`. Package validation checks every local file digest against that release manifest and verifies each published CRUD example against its advertised invocation schemas.

My CRM contributes CRM goals and constraints to BOS-owned explain planning and BOSL authoring. It validates structured CRM client instructions and invokes returned lifecycle actions verbatim. It implements no local FSM/BOSL compiler or executor.

## Validate

```bash
npm test
npm run vault:sync
```

Live staging conformance is a separate authorized gate because it requires published host/server contracts and isolated mutable fixtures. Local contract tests use sanitized source-neutral fixtures. The controlled read-only attendee is `cody.marcel@dfsm.ai`.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
