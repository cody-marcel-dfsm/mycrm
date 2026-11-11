import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import * as s from "../scripts/oracle-spec.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const selection = (change = {}) => ({change_class: "bug_fix", scope_paths: ["src/example.mjs", "tests/*"], categories: [{name: "sanity", tests: [], fixtures: []}, {name: "focused", tests: ["tests/example.test.mjs"], fixtures: []}], reason: "Synthetic focused repair", revision_of: null, ...change});
const answer = (change = {}) => ({title: "Synthetic repair", runtime_paths: ["src/example.mjs"], acceptance: [{criterion: "The example returns the corrected value.", tests: ["tests/example.test.mjs"]}], tests: [{module: "tests/example.test.mjs", purpose: "Prove the corrected value."}], findings: [{severity: "warning", message: "Synthetic warning."}], ...change});
const base = "a".repeat(40), proposal = "Problem: synthetic. Cause: synthetic. Recommended change: synthetic.";
const build = (change = {}) => s.buildSpec({answer: answer(), selection: selection(), base, engine: "codex", model: "synthetic-model", oracle: "b".repeat(64), host: "synthetic-host", time: "2026-11-11T00:00:00Z", proposal, ...change});
const contract = (spec = build(), change = {}) => ({selection: selection(), base_commit: base, proposal_sha256: sha(proposal), spec, ...change});

test("seal reproduces the BOS reference spec exactly with the shared canonical form", () => {
  const vector = s.parseStrict(readFileSync(new URL("./support/oracle-spec-bos-vector.json", import.meta.url), "utf8"));
  assert.equal(vector.kind, s.KIND);
  assert.equal(s.computeSeal(vector), vector.seal);
  assert.equal(s.sealMatches(vector), true);
  // Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False) vectors.
  assert.equal(s.canonicalJson({"é": "ü\n \"\\", a: [1, true, null, "\u0001"], B: {z: 0, y: -2}}), '{"B":{"y":-2,"z":0},"a":[1,true,null,"\\u0001"],"é":"ü\\n \\"\\\\"}');
  assert.equal(s.computeSeal({kind: s.KIND, seal: "ignored", a: 1}), sha(Buffer.concat([Buffer.from("oracle-spec/1\0"), Buffer.from('{"a":1,"kind":"oracle-spec/1"}')])));
  for (const value of [1.5, NaN, Infinity, 2 ** 60, undefined, new Date(0)]) assert.throws(() => s.canonicalJson({value}), s.SpecError);
});

test("tampering with content, stamp or seal fails and only APPROVED specs verify", () => {
  const spec = build();
  assert.equal(s.assertSpec(spec), spec);
  for (const change of [v => v.acceptance[0] = "Changed.", v => v.stamp.model = "other", v => v.base = "c".repeat(40), v => v.seal = "0".repeat(64), v => delete v.seal]) {
    const copy = structuredClone(spec); change(copy); assert.throws(() => s.assertSpec(copy), /Seal|keys/);
  }
  const rejected = {...structuredClone(spec), verdict: "REJECTED"}; rejected.seal = s.computeSeal(rejected);
  assert.throws(() => s.assertSpec(rejected), /Only an APPROVED/);
  assert.throws(() => s.parseStrict('{"kind":"oracle-spec/1","kind":"x"}'), /repeats/);
  assert.throws(() => s.parseStrict("{\"a\":NaN}"));
});

test("malformed answers and specs are refused with their exact shape problems", () => {
  const criterion = tests => [{criterion: "A criterion.", tests}];
  for (const change of [{tests: []}, {acceptance: []}, {acceptance: ["one"]}, {acceptance: criterion([])}, {acceptance: criterion(["tests/other.test.mjs"])}, {acceptance: [...criterion(["tests/example.test.mjs"]), {criterion: " ", tests: ["tests/example.test.mjs"]}]}, {tests: [{module: "tests/example.test.mjs", purpose: "x"}, {module: "tests/unused.test.mjs", purpose: "Covers nothing."}]}, {acceptance: criterion(["tests/../x.test.mjs"]), tests: [{module: "tests/../x.test.mjs", purpose: "x"}]}, {acceptance: criterion(["--test-only"]), tests: [{module: "--test-only", purpose: "x"}]}, {tests: [{module: "tests/example.test.mjs", covers: [0], purpose: "x"}]}, {findings: [{severity: "blocking", message: "Stop."}]}, {findings: [{severity: "info", message: "x"}]}, {runtime_paths: ["/abs.mjs"]}, {extra: true}]) {
    assert.ok(s.answerProblems(answer(change)).length, JSON.stringify(change));
  }
  assert.deepEqual(s.answerProblems(answer()), []);
  const line = `ORACLE_SPEC=${JSON.stringify(answer())}`;
  assert.deepEqual(s.proposalSpecAnswer(`text\n${line}\nORACLE_VERDICT=APPROVED`), answer());
  for (const output of ["no spec", `${line}\n${line}`, "ORACLE_SPEC={bad", `ORACLE_SPEC=${JSON.stringify(answer({tests: []}))}`]) assert.throws(() => s.proposalSpecAnswer(output), s.SpecError);
  assert.throws(() => build({engine: "other"}), /engine/);
  assert.throws(() => build({model: " "}), /model identity/);
  assert.throws(() => build({answer: answer({runtime_paths: ["src/outside.mjs"]})}), /outside scope/);
});

test("parent stamp binds engine, model, Oracle files, host, UTC time and exact input digests", () => {
  const spec = build({request: "Synthetic request bytes"});
  assert.deepEqual(Object.keys(spec.stamp).sort(), ["engine", "host", "model", "oracle_sha256", "proposal_sha256", "request_sha256", "time"]);
  assert.equal(spec.stamp.proposal_sha256, sha(proposal));
  assert.equal(spec.stamp.request_sha256, sha("Synthetic request bytes"));
  assert.equal(build().stamp.request_sha256, null);
  assert.deepEqual([spec.kind, spec.base, spec.design, spec.verdict, spec.scope], [s.KIND, base, null, "APPROVED", selection().scope_paths]);
  assert.match(s.oracleSha256(new URL("..", import.meta.url).pathname), /^[a-f0-9]{64}$/);
  assert.deepEqual(s.ORACLE_FILES, [".agents/skills/oracle/SKILL.md", "scripts/oracle-review.mjs", "scripts/oracle-engine.mjs", "scripts/oracle-spec.mjs"]);
  assert.equal(JSON.stringify(spec).includes(proposal), false);
});

test("privacy boundary rejects credentials, addresses, home paths and copied private text", () => {
  for (const text of ["Authorization: Bearer abcdefghijklmnop", "password = hunter2hunter2", "Contact someone@example.com.", "Read /home/someone/private.md", "token sk_live_abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----"]) {
    assert.throws(() => build({answer: answer({acceptance: [{criterion: text, tests: ["tests/example.test.mjs"]}]})}), /not publishable|credential|address|home path/, text);
  }
  const privateText = "the private feedback says the quarterly retention workflow for this account must never send reminders on weekends";
  assert.throws(() => build({proposal: `Problem: ${privateText}.`, answer: answer({acceptance: [{criterion: `Ensure ${privateText}.`, tests: ["tests/example.test.mjs"]}]})}), /copies 12/);
  assert.throws(() => build({privateTexts: [privateText], answer: answer({findings: [{severity: "warning", message: privateText}]})}), /copies 12/);
  assert.ok(build({privateTexts: [privateText], answer: answer({acceptance: [{criterion: "Reminders respect the configured weekend schedule.", tests: ["tests/example.test.mjs"]}]})}));
  assert.throws(() => s.verifyContractSpec(contract(build(), {selection: selection({reason: "Mail someone@example.com"})})), /not publishable/);
});

test("contract and spec are one executable test contract", () => {
  assert.equal(s.verifyContractSpec(contract()).seal, build().seal);
  const {spec: _omitted, ...withoutSpec} = contract(); assert.throws(() => s.verifyContractSpec(withoutSpec), /missing/);
  assert.throws(() => s.verifyContractSpec({...contract(), selection: {...selection(), change_class: "docs_only"}}), /docs_only/);
  assert.equal(s.verifyContractSpec({selection: {...selection(), change_class: "docs_only"}}), null);
  assert.throws(() => s.verifyContractSpec(contract(build(), {base_commit: "d".repeat(40)})), /base/);
  assert.throws(() => s.verifyContractSpec(contract(build(), {proposal_sha256: "e".repeat(64)})), /proposal/);
  assert.throws(() => s.verifyContractSpec(contract(build(), {selection: selection({scope_paths: ["src/example.mjs", "tests/*", "src/more.mjs"]})})), /scope/);
  const extraTest = selection(); extraTest.categories[1].tests.push("tests/other.test.mjs");
  assert.throws(() => s.verifyContractSpec(contract(build(), {selection: extraTest})), /tests differ/);
  assert.throws(() => s.verifyContractSpec(contract(build(), {selection: selection({change_class: "feature", design: "Vault/docs/design/x.md"})})), /design/);
  const tampered = build(); tampered.tests[0].purpose = "Changed after sealing.";
  assert.throws(() => s.verifyContractSpec(contract(tampered)), /Seal/);
});
