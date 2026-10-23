import {access} from "node:fs/promises";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = args => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), {cwd: root, stdio: "inherit"});
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Required release validation failed: ${args.join(" ")} (${signal ?? code})`)));
});
export async function validateRelease({execute = run, nativeEvidence} = {}) {
  if (nativeEvidence === undefined) {
    try { await access(path.join(root, "Vault/docs/CONSTITUTION.md")); nativeEvidence = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; nativeEvidence = false; }
  }
  for (const command of [["npm", "run", "build"], ["npm", "test"], ["npm", "run", "check:release"]]) {
    // A fresh public CI runner has no private native originals. Its required
    // checks execute honestly; no owner-local review/validation is fabricated.
    const args = nativeEvidence ? [process.execPath, path.join(root, "scripts/oracle-review.mjs"), "validate", "--", ...command] : command;
    await execute(args);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validateRelease().catch(error => {console.error(error.message); process.exitCode = 1;});
