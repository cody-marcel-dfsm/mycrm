// Sealed `oracle-spec/1` implementation specs (owner direction, 2026-11-11).
// The local Oracle reviews a proposal and outputs this self-contained spec; the
// launcher stamps and seals it inside the existing validation contract. The seal
// is a sanity check that the Oracle step ran, not security: there are no keys.
// Node builtins only, so CI and the build host can verify without dependencies.
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

export const KIND = "oracle-spec/1";
export const ORACLE_FILES = Object.freeze([".agents/skills/oracle/SKILL.md", "scripts/oracle-review.mjs", "scripts/oracle-engine.mjs", "scripts/oracle-spec.mjs"]);
export const ENGINES = Object.freeze(["claude", "codex"]);
const SPEC_KEYS = ["acceptance", "base", "design", "findings", "kind", "runtime_paths", "scope", "seal", "stamp", "tests", "title", "verdict"];
const STAMP_KEYS = ["engine", "host", "model", "oracle_sha256", "proposal_sha256", "request_sha256", "time"];
const ANSWER_KEYS = ["acceptance", "findings", "runtime_paths", "tests", "title"];
const TEST_MODULE = /^tests\/[A-Za-z0-9._-]+\.test\.mjs$/;
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const codePoints = (a, b) => { const x = [...a], y = [...b]; for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; } return x.length - y.length; };

export class SpecError extends Error {}

// Byte-identical to Python json.dumps(sort_keys=True, separators=(",", ":"),
// ensure_ascii=False). Only integers are allowed: float spellings differ.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new SpecError("Canonical spec JSON allows only safe integers"); return String(value); }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort(codePoints).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new SpecError("Canonical spec JSON cannot encode this value");
}

export function computeSeal(spec) {
  const {seal: _ignored, ...body} = spec;
  return createHash("sha256").update(Buffer.concat([Buffer.from(`${KIND}\0`, "utf8"), Buffer.from(canonicalJson(body), "utf8")])).digest("hex");
}

export function sealMatches(spec) {
  try { return !!spec && typeof spec === "object" && spec.kind === KIND && typeof spec.seal === "string" && spec.seal === computeSeal(spec); }
  catch { return false; }
}

// Strict JSON for specs read from disk: duplicate object keys are refused
// (JSON.parse silently keeps the last one). Non-finite numbers cannot parse.
export function parseStrict(text) {
  const value = JSON.parse(text), stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (frame.keys.has(key)) throw new SpecError("Spec JSON repeats an object key");
        frame.keys.add(key); frame.expectKey = false;
      }
      index = end;
    } else if (character === "{") stack.push({keys: new Set(), expectKey: true});
    else if (character === "[") stack.push({keys: null});
    else if (character === "}" || character === "]") stack.pop();
    else if (character === "," && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
  return value;
}

export const SECRET_PATTERNS = Object.freeze([
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/i,
  /\b(?:cookie|set-cookie)\s*:\s*\S+/i,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/,
  /\b(?:ghp|gho|ghs|github_pat|xox[baprs]|AIza|sk-ant-|sk-proj-)[A-Za-z0-9_-]{12,}/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\s*(?:=|:)\s*[^\s,;]{8,}/i,
]);
const PRIVATE_PATTERNS = Object.freeze([
  ["e-mail address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["absolute home path", /(?:^|[\s"'`(])(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s]*/],
]);
const strings = (value, where) => typeof value === "string" ? [[where, value]] : Array.isArray(value) ? value.flatMap((item, i) => strings(item, `${where}[${i}]`)) : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => strings(item, `${where}.${key}`)) : [];
const words = text => text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
export const OVERLAP_WORDS = 12;

// Deterministic privacy boundary. Patterns always apply; raw-text overlap
// applies where the private inputs exist (at sealing, never in a public CI).
export function privacyProblems(value, {privateTexts = [], where = "spec"} = {}) {
  const problems = [];
  const fields = strings(value, where);
  for (const [field, text] of fields) {
    if (SECRET_PATTERNS.some(pattern => pattern.test(text))) problems.push(`${field} matches a credential pattern`);
    for (const [label, pattern] of PRIVATE_PATTERNS) if (pattern.test(text)) problems.push(`${field} contains an ${label}`);
  }
  const shingles = new Set();
  for (const text of privateTexts.filter(item => typeof item === "string")) { const w = words(text); for (let i = 0; i + OVERLAP_WORDS <= w.length; i++) shingles.add(w.slice(i, i + OVERLAP_WORDS).join(" ")); }
  if (shingles.size) for (const [field, text] of fields) { const w = words(text); for (let i = 0; i + OVERLAP_WORDS <= w.length; i++) if (shingles.has(w.slice(i, i + OVERLAP_WORDS).join(" "))) { problems.push(`${field} copies ${OVERLAP_WORDS} or more consecutive words of private input`); break; } }
  return problems;
}

const safePath = value => typeof value === "string" && value.length > 0 && value.trim() === value && !value.startsWith("/") && !value.startsWith("-") && !value.startsWith("~") && !/[\\\r\n\0]/.test(value) && !value.split("/").includes("..");
const text = value => typeof value === "string" && value.trim().length > 0;
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// Shape of the reviewer's ORACLE_SPEC answer (the parent adds everything else).
// The reviewer names the tests of each criterion; the parent derives the
// spec's acceptance indices, so the mapping cannot drift by an index.
export function answerProblems(answer) {
  if (!exactKeys(answer, ANSWER_KEYS)) return [`Oracle spec answer requires exactly: ${ANSWER_KEYS.join(", ")}`];
  if (!Array.isArray(answer.acceptance) || !answer.acceptance.every(item => exactKeys(item, ["criterion", "tests"]) && text(item.criterion) && Array.isArray(item.tests) && item.tests.length && item.tests.every(text))) return ["acceptance must be [{criterion, tests: [module, ...]}] with at least one test per criterion"];
  if (!Array.isArray(answer.tests) || !answer.tests.every(row => exactKeys(row, ["module", "purpose"]))) return ["tests must be [{module, purpose}]"];
  const modules = answer.tests.map(row => row.module), unknown = [...new Set(answer.acceptance.flatMap(item => item.tests).filter(module => !modules.includes(module)))];
  if (unknown.length) return [`Acceptance names tests absent from tests: ${unknown.join(", ")}`];
  return specProblems(placeholderSpec(answer)).filter(problem => !problem.startsWith("runtime path outside scope"));
}
const placeholderSpec = answer => ({kind: KIND, title: answer.title, design: null, base: "0".repeat(40), scope: ["placeholder"], ...specBody(answer), verdict: "APPROVED", stamp: {engine: "codex", model: "placeholder", oracle_sha256: "0".repeat(64), host: "placeholder", time: "2026-01-01T00:00:00Z", request_sha256: null, proposal_sha256: "0".repeat(64)}, seal: "0".repeat(64)});
// oracle-spec/1 body: acceptance strings and tests [{module, covers, purpose}].
export const specBody = answer => ({runtime_paths: answer.runtime_paths, acceptance: answer.acceptance.map(item => item.criterion), tests: answer.tests.map(row => ({module: row.module, covers: answer.acceptance.flatMap((item, index) => item.tests.includes(row.module) ? [index] : []), purpose: row.purpose})), findings: answer.findings});

// Shape problems of a complete spec; the seal is checked separately.
export function specProblems(spec) {
  if (!exactKeys(spec, SPEC_KEYS)) return [`Spec keys must be exactly: ${SPEC_KEYS.join(", ")}`];
  const problems = [];
  if (spec.kind !== KIND) problems.push(`kind must be ${KIND}`);
  if (!text(spec.title)) problems.push("title must be a non-empty string");
  if (spec.design !== null && !(safePath(spec.design) && spec.design.endsWith(".md"))) problems.push("design must be a repository-relative .md path or null");
  if (typeof spec.base !== "string" || !/^[a-f0-9]{40}$/.test(spec.base)) problems.push("base must be a 40-hex commit");
  for (const key of ["scope", "runtime_paths"]) if (!Array.isArray(spec[key]) || !spec[key].every(safePath) || new Set(spec[key]).size !== spec[key].length) problems.push(`${key} must be distinct repository-relative paths or globs`);
  if (!Array.isArray(spec.scope) || !spec.scope.length) problems.push("scope must name at least one path");
  if (Array.isArray(spec.scope) && Array.isArray(spec.runtime_paths)) for (const item of spec.runtime_paths) if (!spec.scope.some(pattern => glob(item, pattern))) problems.push(`runtime path outside scope: ${item}`);
  const acceptance = Array.isArray(spec.acceptance) && spec.acceptance.length && spec.acceptance.every(text) ? spec.acceptance : null;
  if (!acceptance) problems.push("acceptance must be a non-empty list of criteria");
  const covered = new Set(), modules = [];
  if (!Array.isArray(spec.tests) || !spec.tests.length) problems.push("tests must name at least one test");
  for (const row of Array.isArray(spec.tests) ? spec.tests : []) {
    if (!exactKeys(row, ["covers", "module", "purpose"]) || !TEST_MODULE.test(row.module ?? "") || !text(row.purpose) || !Array.isArray(row.covers) || !row.covers.length || !row.covers.every(index => Number.isInteger(index) && index >= 0 && index < (acceptance?.length ?? 0))) { problems.push(`Each test needs an exact tests/*.test.mjs module, purpose and valid acceptance indices: ${JSON.stringify(row)}`); continue; }
    row.covers.forEach(index => covered.add(index)); modules.push(row.module);
  }
  if (new Set(modules).size !== modules.length) problems.push("tests repeat a module");
  if (acceptance) { const missing = acceptance.map((_, index) => index).filter(index => !covered.has(index)); if (missing.length) problems.push(`Acceptance criteria without a test: ${missing.join(", ")}`); }
  if (!Array.isArray(spec.findings) || !spec.findings.every(item => exactKeys(item, ["message", "severity"]) && ["blocking", "warning"].includes(item.severity) && text(item.message))) problems.push("findings must be {severity: blocking|warning, message} objects");
  if (!["APPROVED", "REJECTED"].includes(spec.verdict)) problems.push("verdict must be APPROVED or REJECTED");
  if (spec.verdict === "APPROVED" && Array.isArray(spec.findings) && spec.findings.some(item => item?.severity === "blocking")) problems.push("An APPROVED spec cannot carry blocking findings");
  const stamp = spec.stamp;
  if (!exactKeys(stamp, STAMP_KEYS) || !ENGINES.includes(stamp.engine) || !text(stamp.model) || !text(stamp.host) || !HEX64.test(stamp.oracle_sha256 ?? "") || !HEX64.test(stamp.proposal_sha256 ?? "") || !(stamp.request_sha256 === null || HEX64.test(stamp.request_sha256 ?? "")) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(stamp.time ?? "")) problems.push("stamp must hold engine, model, oracle_sha256, host, UTC Z time, proposal_sha256 and request_sha256 (or null)");
  // Every persisted string, structural paths and stamp provenance included.
  if (!problems.length) { const {seal: _seal, ...persisted} = spec; problems.push(...privacyProblems(persisted)); }
  return problems;
}

export function glob(name, pattern) { return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name); }

export function assertSpec(spec) {
  const problems = specProblems(spec);
  if (!problems.length && !sealMatches(spec)) problems.push("Seal does not recompute from the spec content");
  if (!problems.length && spec.verdict !== "APPROVED") problems.push("Only an APPROVED spec is a valid implementation spec");
  if (problems.length) throw new SpecError(`Sealed Oracle spec is invalid: ${problems.join("; ")}`);
  return spec;
}

const toolRoot = fileURLToPath(new URL("..", import.meta.url));
// The Oracle skill comes from the reviewed checkout; the tool files are the
// launcher's own modules (the same files in a canonical checkout).
export function oracleSha256(root, {tools = toolRoot} = {}) {
  const digest = createHash("sha256");
  for (const name of ORACLE_FILES) digest.update(`${name}\0${sha256(readFileSync(path.join(name.startsWith("scripts/") ? tools : root, name)))}\n`);
  return digest.digest("hex");
}

export function proposalSpecAnswer(output) {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("ORACLE_SPEC="));
  if (lines.length !== 1) throw new SpecError("Independent proposal omitted or duplicated its ORACLE_SPEC line");
  let answer; try { answer = parseStrict(lines[0].slice("ORACLE_SPEC=".length)); } catch (error) { throw new SpecError(`ORACLE_SPEC is not strict JSON: ${error.message}`); }
  const problems = answerProblems(answer);
  if (problems.length) throw new SpecError(`Oracle spec answer is invalid: ${problems.join("; ")}`);
  return answer;
}

const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// The parent owns kind, base, scope, design, verdict, stamp and seal; the child
// supplies only its publishable answer.
export function buildSpec({answer, selection, base, engine, model, oracle, host, time = utcNow(), proposal, request = null, privateTexts = []}) {
  const shape = answerProblems(answer);
  if (shape.length) throw new SpecError(`Oracle spec answer is invalid: ${shape.join("; ")}`);
  if (!ENGINES.includes(engine)) throw new SpecError(`Unknown Oracle engine: ${engine}`);
  if (!text(model)) throw new SpecError("The Oracle engine reported no model identity");
  if (typeof proposal !== "string" || !proposal.trim()) throw new SpecError("The proposal is empty");
  const spec = {kind: KIND, title: answer.title, design: selection.design ?? null, base, scope: [...selection.scope_paths], ...specBody(answer), verdict: "APPROVED",
    stamp: {engine, model, oracle_sha256: oracle, host, time, request_sha256: request === null || request === undefined ? null : sha256(request), proposal_sha256: sha256(proposal)}};
  spec.seal = computeSeal(spec);
  const problems = [...specProblems(spec), ...privacyProblems({...Object.fromEntries(Object.entries(spec).filter(([key]) => key !== "seal")), reason: selection.reason}, {privateTexts: [proposal, request, ...privateTexts]})];
  if (problems.length) throw new SpecError(`Oracle spec is not publishable: ${[...new Set(problems)].join("; ")}`);
  return assertSpec(spec);
}

const selectedTests = selection => [...new Set(selection.categories.filter(row => ["focused", "interactions", "acceptance"].includes(row.name)).flatMap(row => row.tests))].sort();

// The spec and the selection are one executable contract.
export function verifyContractSpec(contract) {
  const selection = contract?.selection;
  if (selection?.change_class === "docs_only") { if (contract.spec !== undefined) throw new SpecError("A docs_only contract carries no spec"); return null; }
  if (contract?.spec === undefined) throw new SpecError("Sealed Oracle spec is missing from the validation contract; run the native proposal");
  const spec = assertSpec(contract.spec);
  if (spec.base !== contract.base_commit) throw new SpecError("Spec base differs from the contract base");
  if (JSON.stringify([...spec.scope].sort()) !== JSON.stringify([...selection.scope_paths].sort())) throw new SpecError("Spec scope differs from the selected scope");
  if (spec.design !== (selection.design ?? null)) throw new SpecError("Spec design differs from the selected design");
  if (JSON.stringify(spec.tests.map(row => row.module).sort()) !== JSON.stringify(selectedTests(selection))) throw new SpecError("Spec tests differ from the selected test categories");
  if (spec.stamp.proposal_sha256 !== contract.proposal_sha256) throw new SpecError("Spec stamp names a different proposal");
  const reason = privacyProblems({reason: selection.reason}, {where: "selection"});
  if (reason.length) throw new SpecError(`Selection is not publishable: ${reason.join("; ")}`);
  return spec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, file = "scripts/validation-selection.json"] = process.argv.slice(2);
    if (action !== "verify") throw new SpecError("Usage: oracle-spec.mjs verify [contract-file]");
    const contract = parseStrict(readFileSync(file, "utf8")), spec = verifyContractSpec(contract);
    console.log(JSON.stringify(spec ? {result: "VALID", seal: spec.seal, base: spec.base, tests: spec.tests.map(row => row.module)} : {result: "DOCS_ONLY"}));
  } catch (error) { console.error(`oracle-spec: ${error.message}`); process.exitCode = 2; }
}
