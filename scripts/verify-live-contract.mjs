import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {repositoryRoot, stableJson} from "./release-utils.mjs";
import {verifyNativeRuntime} from "./codex-local-install.mjs";
import {validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";

const exec = promisify(execFile);
const schemaFile = path.join(repositoryRoot, "contracts/my-crm/v1/live-acceptance-response.schema.json");

export const LIVE_ACCEPTANCE_PROMPT = `Use the installed My CRM skills and the installed BOS product's single authenticated connection. Perform only read-only BOS application discovery and a task-scoped Describe request for the Lead Director search operation. Do not create, update, delete, register, start, step, complete, or fail a journey. Do not call a provider write. Do not request, infer, or emit an organization selector, authority value, credential, token, installation identifier, role identifier, internal identifier, or provider identifier. My CRM must delegate authentication and discovery to installed BOS and must not create a second connection. Return APPROVED only when authenticated BOS discovery found the current application and Describe returned the search contract. Return HOST_ACTION_REQUIRED when the native host must complete BOS sign-in or authorization. Return REJECTED for any other contract failure.`;

async function defaultRun(args) {
  const {stdout} = await exec("codex", args, {cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024});
  return stdout;
}

export async function runLiveAcceptance({runCommand = defaultRun, verifyRuntime = verifyNativeRuntime, evidenceFile = process.env.MYCRM_LIVE_EVIDENCE_OUT, authorized = process.env.MYCRM_LIVE_ACCEPTANCE === "1"} = {}) {
  if (!authorized) throw new Error("Set MYCRM_LIVE_ACCEPTANCE=1 to run the authorized, read-only native live-contract check");
  const runtime = await verifyRuntime();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-live-"));
  const responseFile = path.join(temporary, "response.json");
  try {
    await runCommand([
      "exec", "--ephemeral", "--json", "--sandbox", "read-only", "--cd", repositoryRoot,
      "--output-schema", schemaFile, "--output-last-message", responseFile, LIVE_ACCEPTANCE_PROMPT
    ]);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    validateJsonValueAgainstSchema(response, JSON.parse(await readFile(schemaFile, "utf8")), "native live acceptance response");
    for (const key of ["bos_connection_reused", "application_discovered", "search_described", "mutation_performed", "authority_exposed"]) {
      if (typeof response[key] !== "boolean") throw new Error(`Live acceptance response is missing boolean ${key}`);
    }
    if (/(?:access|refresh)[_ -]?token|bearer|context[_ -]?id|organization[_ -]?id|installation[_ -]?id|role[_ -]?id|provider[_ -]?id|internal[_ -]?id/i.test(response.message)) {
      throw new Error("Live acceptance response contains forbidden authority or internal-identity text");
    }
    const approved = response.status === "APPROVED" && response.bos_connection_reused && response.application_discovered && response.search_described && !response.mutation_performed && !response.authority_exposed;
    const hostAction = response.status === "HOST_ACTION_REQUIRED" && !response.mutation_performed && !response.authority_exposed;
    const evidence = {
      schema: "my-crm.live-acceptance-evidence/v1",
      plugin_id: runtime.pluginId,
      bos_plugin_id: runtime.bosPluginId,
      release_sha256: runtime.release.content_sha256,
      result: response
    };
    if (evidenceFile) await writeFile(path.resolve(evidenceFile), stableJson(evidence), {flag: "wx"});
    if (approved) return evidence;
    if (hostAction) throw new Error(`MYCRM_LIVE_CONTRACT=HOST_ACTION_REQUIRED ${response.message}`);
    throw new Error(`MYCRM_LIVE_CONTRACT=REJECTED ${response.message}`);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveAcceptance().then((evidence) => {
    console.log(`MYCRM_LIVE_CONTRACT=APPROVED release=${evidence.release_sha256}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
