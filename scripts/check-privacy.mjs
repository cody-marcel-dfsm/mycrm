import {lstat, readFile, readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {readJson, repositoryRoot} from "./release-utils.mjs";
import {readMetadataFile, pathCustody, contentHash} from "./oracle-inputs.mjs";
import {verifySeries} from "./oracle-series.mjs";

const policyFile = path.join(repositoryRoot, "config/privacy-policy.json");
const ignoredDirectories = new Set([".git", "node_modules", "coverage", ".Trash"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const nativeRunNames = new Set(["inputs.json", "process.json", "response.txt", "response.json", "response.schema.json", "reviewer.json", "reviewer.stdout.log", "reviewer.stderr.log", "timings.json", "outcome.json", "evidence.json", "preparation.json", "authorization.schema.json", "authorization.response.json", "authorization.evidence.json"]);
const nativeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function nativeProvenance(root) {
  const owner = path.join(root, ".git"), series = new Set();
  try {
    const location = path.join(owner, "oracle", "series");
    await pathCustody(owner, location, {scopeRoot: owner, allowFinalLink: false});
    for (const name of await readdir(location)) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await readMetadataFile(path.join(location, name), "utf8", {root: owner}));
        verifySeries(record, name.slice(0, -5));
        if (record.rounds.length && nativeUuid.test(record.series_id)) series.add(record.series_id);
      } catch { /* Unverified native claims supply no privacy allowance. */ }
    }
  } catch { /* A package without owner-local native metadata has no allowance. */ }
  const runFile = async (filename, expectedHash) => {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) return false;
    const relative = path.relative(path.join(owner, "oracle", "runs"), filename);
    const parts = relative.split(path.sep);
    if (parts.length !== 2 || !nativeUuid.test(parts[0]) || !nativeRunNames.has(parts[1]) || filename !== path.join(owner, "oracle", "runs", ...parts)) return false;
    try {
      await pathCustody(owner, filename, {scopeRoot: owner, allowFinalLink: false});
      if (contentHash(await readMetadataFile(filename, {}, {root: owner})) !== expectedHash) return false;
      const run = path.dirname(filename);
      const outcome = JSON.parse(await readMetadataFile(path.join(run, "outcome.json"), "utf8", {root: owner}));
      const reviewer = JSON.parse(await readMetadataFile(path.join(run, "reviewer.json"), "utf8", {root: owner}));
      const execution = JSON.parse(await readMetadataFile(path.join(run, "process.json"), "utf8", {root: owner}));
      return ["review", "proposal", "deployment-authorization"].includes(outcome.kind) && outcome.reviewer_invoked === true && typeof outcome.started_at === "string" && typeof outcome.finished_at === "string" && reviewer.role === "independent-project-oracle" && /^[a-f0-9]{64}$/.test(reviewer.role_instruction_sha256 ?? "") && (Number.isInteger(execution.exit_code) || execution.signal !== null && typeof execution.signal === "string");
    } catch { return false; }
  };
  const runIdentity = async (id) => {
    if (!nativeUuid.test(id)) return false;
    const run = path.join(owner, "oracle", "runs", id);
    try {
      await pathCustody(owner, run, {scopeRoot: owner, allowFinalLink: false});
      const outcome = JSON.parse(await readMetadataFile(path.join(run, "outcome.json"), "utf8", {root: owner}));
      const reviewer = JSON.parse(await readMetadataFile(path.join(run, "reviewer.json"), "utf8", {root: owner}));
      const execution = JSON.parse(await readMetadataFile(path.join(run, "process.json"), "utf8", {root: owner}));
      return ["review", "proposal", "deployment-authorization"].includes(outcome.kind) && outcome.reviewer_invoked === true && typeof outcome.started_at === "string" && typeof outcome.finished_at === "string" && reviewer.role === "independent-project-oracle" && /^[a-f0-9]{64}$/.test(reviewer.role_instruction_sha256 ?? "") && (Number.isInteger(execution.exit_code) || typeof execution.signal === "string");
    } catch { return false; }
  };
  return {series, runFile, runIdentity, runPrefix: `${path.join(owner, "oracle", "runs")}${path.sep}`};
}

async function uuidAuditContent(content, relative, provenance) {
  if (!relative.startsWith(`Vault${path.sep}tmp${path.sep}`) || !relative.endsWith(".json")) return content;
  let record;
  try { record = JSON.parse(content); } catch { return content; }
  // Keep original token positions: JSON.parse alone discards duplicate members.
  const tokens = []; let cursor = 0, duplicate = false;
  const whitespace = () => { while (/\s/u.test(content[cursor] ?? "") && cursor < content.length) cursor++; };
  const string = (location, key = false) => {
    whitespace(); const begin = cursor++;
    while (cursor < content.length) { const character = content[cursor++]; if (character === "\\") cursor++; else if (character === '"') break; }
    const token = {begin, end: cursor, location, key, value: JSON.parse(content.slice(begin, cursor))}; tokens.push(token); return token.value;
  };
  const value = (location) => {
    whitespace();
    if (content[cursor] === '"') { string(location); return; }
    if (content[cursor] === "{") {
      cursor++; whitespace(); const keys = new Set();
      while (content[cursor] !== "}") {
        const key = string(location, true); if (keys.has(key)) duplicate = true; keys.add(key);
        whitespace(); cursor++; value([...location, key]); whitespace(); if (content[cursor] !== ",") break; cursor++;
      }
      cursor++; return;
    }
    if (content[cursor] === "[") {
      cursor++; whitespace(); let index = 0;
      while (content[cursor] !== "]") { value([...location, index++]); whitespace(); if (content[cursor] !== ",") break; cursor++; }
      cursor++; return;
    }
    while (cursor < content.length && !/[\s,\]}]/u.test(content[cursor])) cursor++;
  };
  value([]);
  const allowed = new Set();
  if (!duplicate) for (const token of tokens) {
    if (token.key) continue;
    if (record?.schema === "my-crm.shipment-completion/v1" && JSON.stringify(token.location) === '["oracle","series_id"]' && provenance.series.has(token.value)) allowed.add(token);
    if (record?.schema === "my-crm.proposal-evidence-custody/v1" && token.location.length === 3 && token.location[0] === "files" && Number.isInteger(token.location[1]) && token.location[2] === "original" && await provenance.runFile(token.value, record.files?.[token.location[1]]?.sha256)) allowed.add(token);
    // Private copied diagnostics retain exact native provenance. These are
    // generated reviewer/series identities, distinct from customer or BOS
    // authority handles. Every occurrence must be proven in owner-local
    // metadata and used as a native reference; public/customer fields keep
    // the original identity prohibition. Originals remain byte-for-byte intact.
    if (record?.schema !== "my-crm.proposal-evidence-custody/v1") {
      const matches = [...token.value.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g)];
      const leaf = token.location.at(-1), parent = token.location.slice(0, -1).reduce((value, key) => value?.[key], record);
      const seriesField = leaf === "series_id" || leaf === "id" && token.location.at(-2) === "series";
      const runField = leaf === "id" && ["review", "proposal", "deployment-authorization"].includes(parent?.kind)
        || leaf === "existing_other_scope_proposal" || token.location.at(-2) === "original_error_outcomes_preserved";
      if (matches.length && (await Promise.all(matches.map(async (match) => {
        if (seriesField && token.value === match[0] && provenance.series.has(match[0])) return true;
        const nativePath = token.value.slice(0, match.index).endsWith(provenance.runPrefix)
          && [undefined, path.sep].includes(token.value[match.index + match[0].length]);
        return (nativePath || runField && token.value === match[0]) && await provenance.runIdentity(match[0]);
      }))).every(Boolean)) allowed.add(token);
    }
  }
  let audited = content;
  for (const token of [...allowed].sort((left, right) => right.begin - left.begin)) audited = `${audited.slice(0, token.begin)}"verified-native-provenance"${audited.slice(token.end)}`;
  return `${audited}\n${tokens.filter((token) => !allowed.has(token)).map(({value: decoded}) => decoded).join("\n")}`;
}

async function walk(directory, {includeDist}, files = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (ignoredDirectories.has(entry.name) || (!includeDist && entry.name === "dist")) continue;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`${path.relative(repositoryRoot, absolute)} is a symbolic link and cannot be privacy-audited`);
    if (entry.isDirectory()) await walk(absolute, {includeDist}, files);
    else if (textExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

async function externalDenylist(environmentName) {
  const configured = process.env[environmentName];
  if (!configured) return [];
  const absolute = path.resolve(configured);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error(`${environmentName} must resolve outside the MyCRM repository`);
  }
  const content = await readFile(absolute, "utf8");
  return content.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value && !value.startsWith("#"));
}

export async function checkPrivacy({root = repositoryRoot, includeDist = false, denylistValues} = {}) {
  const policy = await readJson(policyFile);
  const allowedDomains = new Set(policy.allowed_email_domains.map((value) => value.toLowerCase()));
  const patterns = policy.forbidden_value_patterns.map(({id, pattern}) => ({id, regex: new RegExp(pattern, "gu")}));
  const evidencePatterns = policy.forbidden_evidence_patterns.map(({id, pattern}) => ({id, regex: new RegExp(pattern, "gu")}));
  const denylist = denylistValues ?? await externalDenylist(policy.external_denylist_environment);
  const failures = [];
  const provenance = await nativeProvenance(root);
  const files = await walk(root, {includeDist});
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relative = path.relative(root, file);
    const uuidContent = await uuidAuditContent(content, relative, provenance);
    for (const match of content.matchAll(emailPattern)) {
      if (!allowedDomains.has(match[1].toLowerCase())) failures.push(`${relative} contains a non-synthetic email address`);
    }
    for (const {id, regex} of patterns) {
      regex.lastIndex = 0;
      if (regex.test(id === "uuid-value" ? uuidContent : content)) failures.push(`${relative} contains forbidden identity pattern ${id}`);
    }
    if (relative.startsWith(`Vault${path.sep}evidence${path.sep}`) || relative.startsWith(`Vault${path.sep}reviews${path.sep}`)) {
      for (const {id, regex} of evidencePatterns) {
        regex.lastIndex = 0;
        if (regex.test(content)) failures.push(`${relative} contains forbidden evidence identity pattern ${id}`);
      }
    }
    const folded = content.toLocaleLowerCase("en-US");
    for (const value of denylist) {
      if (folded.includes(value.toLocaleLowerCase("en-US"))) failures.push(`${relative} contains an externally denied customer identifier`);
    }
  }
  if (failures.length) throw new Error([...new Set(failures)].join("\n"));
  return {files_scanned: files.length, external_denylist_entries: denylist.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPrivacy({includeDist: process.argv.includes("--include-dist")}).then(({files_scanned, external_denylist_entries}) => {
    console.log(`MYCRM_PRIVACY_CHECK=APPROVED files=${files_scanned} external_denylist_entries=${external_denylist_entries}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
