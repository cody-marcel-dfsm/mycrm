import {execFile} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {admitDeployment} from "./oracle-deployment.mjs";
import {installLocal} from "./codex-local-install.mjs";
import {checkRelease} from "./check-release.mjs";
import {repositoryRoot} from "./release-utils.mjs";

const execute = promisify(execFile);
const nativeRun = async (args) => (await execute("codex", args, {cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024})).stdout;
const mutation = (args) => args[0] === "plugin" && (args[1] === "add" || args[1] === "marketplace" && args[2] === "add");

// Maintainer release admission stays outside the public install:local helper.
// Published consumers need only the supported host controls and BOS dependency.
export async function installReviewed({admit = admitDeployment, install = installLocal, runCommand = nativeRun, ...options} = {}) {
  const original = await admit({root: repositoryRoot});
  let artifactDigest = null;
  const guardedRun = async (args) => {
    if (mutation(args)) {
      const release = await checkRelease();
      const current = await admit({root: repositoryRoot});
      if (["target_tree", "technical_receipt_sha256", "plan_sha256"].some((key) => current[key] !== original[key])) throw new Error("Maintainer installation source/effect admission changed before native mutation");
      const checked = await checkRelease();
      if (checked.content_sha256 !== release.content_sha256 || artifactDigest !== null && artifactDigest !== checked.content_sha256) throw new Error("Maintainer installation artifact changed before native mutation");
      artifactDigest = checked.content_sha256;
    }
    return runCommand(args);
  };
  const result = await install({...options, runCommand: guardedRun});
  if (artifactDigest !== null && result.release.content_sha256 !== artifactDigest) throw new Error("Installed artifact differs from the admitted maintainer artifact");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) installReviewed().then((result) => {
  console.log(`MYCRM_REVIEWED_INSTALL=APPROVED plugin=${result.pluginId} release=${result.release.content_sha256}`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
