import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {checkPrivacy} from "../scripts/check-privacy.mjs";
import {contentHash} from "../scripts/oracle-inputs.mjs";
import {seriesDigest} from "../scripts/oracle-series.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-native-provenance-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "Vault/tmp"), {recursive: true});
  const write = async (name, value) => { const filename = path.join(root, name); await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, typeof value === "string" ? value : JSON.stringify(value)); return filename; };
  const run = randomUUID();
  const original = await write(`.git/oracle/runs/${run}/process.json`, {exit_code: 0, signal: null, interrupted: false});
  await write(`.git/oracle/runs/${run}/outcome.json`, {kind: "proposal", reviewer_invoked: true, started_at: "synthetic-start", finished_at: "synthetic-finish", outcome: "APPROVED"});
  await write(`.git/oracle/runs/${run}/reviewer.json`, {role: "independent-project-oracle", role_instruction_sha256: "1".repeat(64)});
  const seriesId = randomUUID(), base = "1".repeat(40);
  const series = {schema: "my-crm.oracle-series/v1", series_id: seriesId, base_commit: base, rounds: [{round: 1, review_status: "COMPLETE", verdict: "APPROVED", snapshot: {files: {}}, coverage: [], validations: [], findings: []}]}; series.sha256 = seriesDigest(series);
  await write(`.git/oracle/series/${base}.json`, series);
  return {root, write, original, run, seriesId, base, series};
}

test("only verified native Oracle provenance is allowed in exact private typed fields", async (t) => {
  const f = await fixture(t);
  await f.write("Vault/tmp/custody.json", {schema: "my-crm.proposal-evidence-custody/v1", files: [{original: f.original, sha256: contentHash(await readFile(f.original))}]});
  await f.write("Vault/tmp/completion.json", {schema: "my-crm.shipment-completion/v1", oracle: {series_id: f.seriesId}});
  await checkPrivacy({root: f.root, denylistValues: []});
  await f.write("Vault/tmp/customer.json", {customer_id: f.seriesId});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
});

test("private copied native diagnostics retain proven run identities without permitting authority handles", async (t) => {
  const f = await fixture(t);
  const record = {invocation: {id: f.run, kind: "proposal"}, existing_other_scope_proposal: f.run,
    original_error_outcomes_preserved: [f.run], series: {id: f.seriesId},
    summary: `Original native execution: ${path.dirname(f.original)}/outcome.json`,
    response: {path: f.original}};
  const filename = await f.write("Vault/tmp/native-continuation.json", record), original = await readFile(filename);
  await checkPrivacy({root: f.root, denylistValues: []});
  assert.deepEqual(await readFile(filename), original);
  await f.write("Vault/tmp/native-continuation.json", {...record, customer_id: f.run});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await f.write("Vault/tmp/native-continuation.json", {...record, authority_handle: randomUUID()});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await f.write("Vault/tmp/native-continuation.json", record);
  await rm(path.join(path.dirname(f.original), "outcome.json"));
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
});

test("raw and decoded UUIDs survive duplicate-key JSON representations without exemptions", async (t) => {
  const f = await fixture(t), unverified = randomUUID();
  const cases = [
    `{"schema":"unverified.customer/v1","customer_id":"${unverified}","customer_id":"synthetic"}`,
    `{"schema":"my-crm.shipment-completion/v1","oracle":{"series_id":"${f.seriesId}"},"customer_id":"${unverified}","customer_id":"synthetic"}`,
    `{"schema":"my-crm.shipment-completion/v1","oracle":{"series_id":"${unverified}","series_id":"${f.seriesId}"}}`,
    `{"schema":"my-crm.proposal-evidence-custody/v1","files":[{"original":"${unverified}","original":${JSON.stringify(f.original)},"sha256":"${contentHash(await readFile(f.original))}"}]}`,
    `{"schema":"unverified.customer/v1","customer_id":"${unverified.replaceAll("-", "\\u002d")}","customer_id":"synthetic"}`
  ];
  for (const content of cases) {
    const filename = await f.write("Vault/tmp/duplicates.json", content);
    await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
    assert.equal(await readFile(filename, "utf8"), content);
  }
});

test("forged custody hashes and unverified native series keep UUID rejection", async (t) => {
  const f = await fixture(t);
  await f.write("Vault/tmp/custody.json", {schema: "my-crm.proposal-evidence-custody/v1", files: [{original: f.original, sha256: "0".repeat(64)}]});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await rm(path.join(f.root, "Vault/tmp/custody.json"));
  await f.write("Vault/tmp/completion.json", {schema: "my-crm.shipment-completion/v1", oracle: {series_id: randomUUID()}});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await f.write("Vault/tmp/completion.json", {schema: "my-crm.shipment-completion/v1", oracle: {series_id: f.seriesId}});
  await f.write(`.git/oracle/series/${f.base}.json`, {...f.series, sha256: "0".repeat(64)});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
});

test("foreign native paths and boundary-return links never supply a provenance exemption", async (t) => {
  const f = await fixture(t), foreign = await mkdtemp(path.join(os.tmpdir(), "my-crm-foreign-native-"));
  t.after(() => rm(foreign, {recursive: true, force: true}));
  const outside = path.join(foreign, f.run, "process.json"); await mkdir(path.dirname(outside)); await writeFile(outside, await readFile(f.original));
  const custody = {schema: "my-crm.proposal-evidence-custody/v1", files: [{original: outside, sha256: contentHash(await readFile(outside))}]};
  await f.write("Vault/tmp/custody.json", custody);
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await rm(f.original); await symlink(outside, f.original);
  custody.files[0].original = f.original; await f.write("Vault/tmp/custody.json", custody);
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
});

test("public typed lookalikes and customer/denylist values retain all privacy gates", async (t) => {
  const f = await fixture(t);
  await f.write("public.json", {schema: "my-crm.shipment-completion/v1", oracle: {series_id: f.seriesId}});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: []}), /uuid-value/);
  await rm(path.join(f.root, "public.json"));
  await f.write("Vault/tmp/completion.json", {schema: "my-crm.shipment-completion/v1", oracle: {series_id: f.seriesId}, customer_id: randomUUID(), marker: "synthetic-denied-customer"});
  await assert.rejects(checkPrivacy({root: f.root, denylistValues: ["synthetic-denied-customer"]}), /uuid-value[\s\S]*externally denied/);
});
