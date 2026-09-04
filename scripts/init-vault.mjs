import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const target = path.resolve(process.argv[2] ?? new URL("../Vault", import.meta.url).pathname);
const directories = ["decisions", "docs", "evidence", "index/manifests", "reviews", "specs", "tmp"];
for (const directory of directories) await mkdir(path.join(target, directory), { recursive: true });
const readme = `# My CRM Vault\n\nThis private local Vault is the canonical home for requirements, architecture, decisions, specifications, evidence, and implementation reviews. It is excluded from Git and release packages.\n\n## Areas\n\n- \`docs/\`: requirements, architecture, status, and platform gaps.\n- \`decisions/\`: durable architectural decisions.\n- \`specs/\`: implementation specifications.\n- \`evidence/\`: validation evidence.\n- \`reviews/\`: readiness and implementation reviews.\n- \`index/manifests/\`: generated content manifests.\n- \`tmp/\`: disposable working material.\n\nRun \`npm run vault:sync\` after durable changes.\n`;
try {
  await writeFile(path.join(target, "README.md"), readme, { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
console.log(`Vault initialized at ${target}`);
