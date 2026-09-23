import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {repositoryRoot, stableJson} from "./release-utils.mjs";
import {verifyNativeRuntime} from "./codex-local-install.mjs";
import {validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";

const schemaFile = path.join(repositoryRoot, "contracts/my-crm/v1/live-acceptance-response.schema.json");

const CONTEXT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,127}$/;

export function buildLiveAcceptancePrompt(contextLabel) {
  if (typeof contextLabel !== "string" || !CONTEXT_LABEL.test(contextLabel)) {
    throw new Error("MYCRM_LIVE_CONTEXT_LABEL must be an explicit user-authorized BOS context label");
  }
  return `Use the installed My CRM skills and the installed BOS product's single authenticated connection. The user-authorized target context label is ${JSON.stringify(contextLabel)}; treat that label only as user intent and require BOS to resolve and revalidate the current authority. Perform authenticated BOS application discovery. Invoke the direct read-only plugins.list and service.describe tools with the fresh selected context handle; do not route those discovery calls through bos_execute. Request task-scoped Describe for the current CRM search operation, and invoke only the exact read-only HTTPS search contract it returns. Search for cody.marcel@dfsm.ai. Validate the response against the advertised output contract. Preserve every returned source-native record and its complete source attribution. Assess whether returned records may represent one conceptual customer while retaining every underlying record, conflict, and uncertainty. Present live or cached origin and a human-readable local freshness time. Do not create, update, delete, register, start, step, complete, or fail a journey. Do not call a provider write. Do not infer another selector or request or emit an authority value, credential, token, installation identifier, role identifier, internal identifier, or provider identifier. My CRM must delegate authentication, context resolution, discovery, and transport to installed BOS and must not create a second connection. Return APPROVED only when discovery, task-scoped Describe, the discovered search request, response validation, provenance preservation, freshness presentation, and conceptual reconciliation assessment all succeed. Return HOST_ACTION_REQUIRED when the native host must complete BOS sign-in or authorization. Return REJECTED for any other contract failure.`;
}

export function execFileWithClosedStdin(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({stdout, stderr});
    });
    child.stdin?.end();
  });
}

async function defaultRun(args) {
  const {stdout} = await execFileWithClosedStdin("codex", args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    killSignal: "SIGTERM"
  });
  return stdout;
}

export async function runLiveAcceptance({runCommand = defaultRun, verifyRuntime = verifyNativeRuntime, evidenceFile = process.env.MYCRM_LIVE_EVIDENCE_OUT, authorized = process.env.MYCRM_LIVE_ACCEPTANCE === "1", contextLabel = process.env.MYCRM_LIVE_CONTEXT_LABEL} = {}) {
  if (!authorized) throw new Error("Set MYCRM_LIVE_ACCEPTANCE=1 to run the authorized, read-only native live-contract check");
  const prompt = buildLiveAcceptancePrompt(contextLabel);
  const runtime = await verifyRuntime();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-live-"));
  const responseFile = path.join(temporary, "response.json");
  try {
    await runCommand([
      "exec", "--ephemeral", "--json", "--sandbox", "read-only", "--cd", repositoryRoot,
      "--output-schema", schemaFile, "--output-last-message", responseFile, prompt
    ]);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    validateJsonValueAgainstSchema(response, JSON.parse(await readFile(schemaFile, "utf8")), "native live acceptance response");
    for (const key of ["bos_connection_reused", "application_discovered", "search_described", "search_executed", "result_validated", "source_provenance_preserved", "freshness_presented", "conceptual_reconciliation_assessed", "mutation_performed", "authority_exposed"]) {
      if (typeof response[key] !== "boolean") throw new Error(`Live acceptance response is missing boolean ${key}`);
    }
    if (/(?:access|refresh)[_ -]?token|bearer|context[_ -]?id|organization[_ -]?id|installation[_ -]?id|role[_ -]?id|provider[_ -]?id|internal[_ -]?id/i.test(response.message)) {
      throw new Error("Live acceptance response contains forbidden authority or internal-identity text");
    }
    const approved = response.status === "APPROVED" && response.bos_connection_reused && response.application_discovered && response.search_described && response.search_executed && response.result_validated && response.source_provenance_preserved && response.freshness_presented && response.conceptual_reconciliation_assessed && !response.mutation_performed && !response.authority_exposed;
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
