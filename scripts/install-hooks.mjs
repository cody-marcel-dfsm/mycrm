import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

await execFileAsync("git", ["config", "core.hooksPath", ".githooks"]);
console.log("MYCRM_HOOKS=INSTALLED path=.githooks");
