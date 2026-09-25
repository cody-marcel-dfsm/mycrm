import {lstat, readFile, readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {readJson, repositoryRoot} from "./release-utils.mjs";

const policyFile = path.join(repositoryRoot, "config/privacy-policy.json");
const ignoredDirectories = new Set([".git", "node_modules", "coverage", ".Trash"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;

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
  const files = await walk(root, {includeDist});
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relative = path.relative(repositoryRoot, file);
    for (const match of content.matchAll(emailPattern)) {
      if (!allowedDomains.has(match[1].toLowerCase())) failures.push(`${relative} contains a non-synthetic email address`);
    }
    for (const {id, regex} of patterns) {
      regex.lastIndex = 0;
      if (regex.test(content)) failures.push(`${relative} contains forbidden identity pattern ${id}`);
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
