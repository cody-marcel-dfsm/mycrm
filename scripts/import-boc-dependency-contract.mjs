import {createHash} from "node:crypto";
import {lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {repositoryRoot, stableJson} from "./release-utils.mjs";

const TARGET = path.join(repositoryRoot, "contracts/bos-operations-center/external-product-dependency/v2");
const HEX64 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("BOC contract import arguments must be --name value pairs");
    values[key.slice(2)] = value;
  }
  return values;
}

async function exactFile(file, expectedDigest, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute`);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file`);
  const bytes = await readFile(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) throw new Error(`${label} digest mismatch`);
  return bytes;
}

export async function importBocDependencyContract({
  schema,
  schemaSha256,
  contract,
  contractSha256,
  sourceRevision,
  adapterSha256,
  bocVersion,
  destination = TARGET
}) {
  if (!HEX64.test(schemaSha256 ?? "") || !HEX64.test(contractSha256 ?? "") || !HEX64.test(adapterSha256 ?? "")) throw new Error("BOC contract import requires exact SHA-256 digests");
  if (!COMMIT.test(sourceRevision ?? "")) throw new Error("BOC contract import requires a full source revision");
  if (!/^\d+\.\d+\.\d+$/.test(bocVersion ?? "")) throw new Error("BOC contract import requires a semantic package version");
  const schemaBytes = await exactFile(schema, schemaSha256, "BOC dependency schema");
  const contractBytes = await exactFile(contract, contractSha256, "BOC dependency contract");
  let parsed;
  try { parsed = JSON.parse(schemaBytes); } catch { throw new Error("BOC dependency schema must be JSON"); }
  if (parsed.$schema !== "https://json-schema.org/draft/2020-12/schema" || parsed.$id !== "bos://contracts/external-product-dependency/v2") throw new Error("BOC dependency schema identity is invalid");
  if (!contractBytes.toString("utf8").startsWith("# BOS-owned connection dependency contract v2\n")) throw new Error("BOC dependency contract identity is invalid");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mycrm-boc-contract-"));
  const temporary = path.join(temporaryRoot, "v2");
  try {
    await mkdir(temporary, {recursive: true});
    await writeFile(path.join(temporary, "external-product-dependency.v2.schema.json"), schemaBytes);
    await writeFile(path.join(temporary, "external-product-dependency.v2.md"), contractBytes);
    await writeFile(path.join(temporary, "import-provenance.json"), stableJson({
      schema: "my-crm.boc-contract-import/v1",
      source_revision: sourceRevision,
      boc_version: bocVersion,
      schema_sha256: schemaSha256,
      contract_sha256: contractSha256,
      adapter_source_sha256: adapterSha256
    }));
    await rm(destination, {recursive: true, force: true});
    await mkdir(path.dirname(destination), {recursive: true});
    await rename(temporary, destination);
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
  return {sourceRevision, bocVersion, schemaSha256, contractSha256, adapterSha256};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argumentsFrom(process.argv.slice(2));
  importBocDependencyContract({
    schema: args.schema,
    schemaSha256: args["schema-sha256"],
    contract: args.contract,
    contractSha256: args["contract-sha256"],
    sourceRevision: args["source-revision"],
    adapterSha256: args["adapter-sha256"],
    bocVersion: args["boc-version"]
  }).then((result) => {
    console.log(`BOC_DEPENDENCY_IMPORT=APPROVED version=${result.bocVersion} source=${result.sourceRevision}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
