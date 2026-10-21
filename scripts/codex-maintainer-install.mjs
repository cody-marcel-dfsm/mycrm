import {execFile} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {admitDeployment} from "./oracle-deployment.mjs";
import {installLocal} from "./codex-local-install.mjs";
import {checkRelease} from "./check-release.mjs";
import {shipmentPlan, recordDeliveredCommit} from "./shipment-state.mjs";
import {repositoryRoot} from "./release-utils.mjs";

const execute = promisify(execFile);
const nativeRun = async (args) => (await execute("codex", args, {cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024})).stdout;
const mutation = (args) => args[0] === "plugin" && (args[1] === "add" || args[1] === "marketplace" && args[2] === "add");
function applicableSelection(selection, admission) {
  const validated = ["DELIVER", "NO_CHANGES"].includes(selection.action) && selection.approval_state === "APPROVED";
  const historical = ["VALIDATE", "NO_CHANGES"].includes(selection.action) && admission?.technical_mode === "HISTORICAL_STAMPED";
  if (admission?.status !== "ADMITTED" || (!validated && !historical) || selection.candidate_commit !== admission.source_commit) throw new Error("Maintainer installation requires applicable exact-candidate technical approval before installation");
}

// Maintainer release admission stays outside the public install:local helper.
// Published consumers need only the supported host controls and BOS dependency.
export async function installReviewed({admit = admitDeployment, install = installLocal, runCommand = nativeRun, plan = shipmentPlan, recordDelivery = recordDeliveredCommit, ...options} = {}) {
  const selection = await plan({root: repositoryRoot});
  if (selection.action === "NO_CHANGES" && selection.approval_state === "APPROVED") return {action: "NO_CHANGES", candidate_commit: selection.candidate_commit};
  if (selection.action === "PREPARE") throw new Error("Maintainer installation requires complete clean canonical source before installation");
  const original = await admit({root: repositoryRoot});
  applicableSelection(selection, original);
  let artifactDigest = null;
  const guardedRun = async (args) => {
    if (mutation(args)) {
      const selected = await plan({root: repositoryRoot});
      applicableSelection(selected, original);
      const release = await checkRelease();
      const checked = await checkRelease();
      if (checked.content_sha256 !== release.content_sha256 || artifactDigest !== null && artifactDigest !== checked.content_sha256) throw new Error("Maintainer installation artifact changed before native mutation");
      const current = await admit({root: repositoryRoot});
      applicableSelection(selected, current);
      if (["target_tree", "technical_receipt_sha256", "plan_sha256", "source_commit", "reviewed_source_commit", "technical_mode"].some((key) => current[key] !== original[key])) throw new Error("Maintainer installation source/effect admission changed before native mutation");
      artifactDigest = checked.content_sha256;
    }
    return runCommand(args);
  };
  const result = await install({...options, runCommand: guardedRun});
  if (artifactDigest !== null && result.release.content_sha256 !== artifactDigest) throw new Error("Installed artifact differs from the admitted maintainer artifact");
  if (selection.action === "DELIVER") await recordDelivery({root: repositoryRoot, admission: await admit({root: repositoryRoot}), installation: result});
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) installReviewed().then((result) => {
  if (result.action === "NO_CHANGES") console.log(`MYCRM_REVIEWED_INSTALL=NO_CHANGES commit=${result.candidate_commit}`);
  else console.log(`MYCRM_REVIEWED_INSTALL=APPROVED plugin=${result.pluginId} release=${result.release.content_sha256}`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
