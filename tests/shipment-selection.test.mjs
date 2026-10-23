import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {captureInputs} from "../scripts/oracle-inputs.mjs";
import {checkpointSelectionApplicable} from "../scripts/shipment-state.mjs";

test("unchanged recorded source selection reads governing hashes and no original review/history/output closure", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-fast-selection-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "Vault/docs"), {recursive: true}); await mkdir(path.join(root, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(root, "AGENTS.md"), "Synthetic selection policy.\n"); await writeFile(path.join(root, "Vault/docs/CONSTITUTION.md"), "Synthetic constitution.\n");
  await writeFile(path.join(root, ".agents/skills/oracle/SKILL.md"), "Synthetic isolated reviewer fixture.\n");
  const inputs = await captureInputs({root, base: "a".repeat(40), tree: "b".repeat(40), complete: true});
  // No .git directory, original receipt, output, series or history exists.
  // Invoking any former heavy checkpoint path would fail this real selection.
  const checkpoint = {receipt: {input_binding: inputs}};
  const started = performance.now(); assert.equal(await checkpointSelectionApplicable(root, checkpoint), true);
  const elapsed = performance.now() - started; assert.ok(elapsed < 1000, `Unchanged status selection exceeded one second: ${elapsed}ms`);
  console.log(`MYCRM_UNCHANGED_SELECTION_MS=${Math.round(elapsed)}`);
  await writeFile(path.join(root, "Vault/docs/new-criteria.md"), "Synthetic newly consumed criteria.\n");
  await assert.rejects(checkpointSelectionApplicable(root, checkpoint), /membership changed/);
  await rm(path.join(root, "Vault/docs/new-criteria.md"));
  await writeFile(path.join(root, "AGENTS.md"), `${await readFile(path.join(root, "AGENTS.md"), "utf8")}Synthetic new owner criterion.\n`);
  await assert.rejects(checkpointSelectionApplicable(root, checkpoint), /Governing authority changed/);
});
