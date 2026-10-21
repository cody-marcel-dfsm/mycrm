import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {prepareSourcePacket, utf8Pages} from "../scripts/oracle-source-packet.mjs";
import {contentHash, withOracleRun} from "../scripts/oracle-inputs.mjs";

test("source pages preserve complete UTF-8 content and exact byte bounds", () => {
  const text = "export function synthetic(){\n" + "  // synthetic ∑😀\n".repeat(1500) + "  return true;\n}\n";
  const pages = utf8Pages(text);
  assert.equal(pages.join(""), text); assert.ok(pages.every(page => Buffer.byteLength(page) <= 8192));
  assert.ok(pages.every(page => !page.includes("\ufffd")));
});

test("native source packet contains actual assigned diff and complete bodies with truthful missing dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-source-packet-")); t.after(() => rm(root, {recursive: true, force: true}));
  await withOracleRun(path.join(root, "oracle"), async ({run}) => {
    const source = "export class Synthetic {\n  async execute(){\n" + "    // nested 😀 source\n".repeat(900) + "    return {complete:true};\n  }\n}\n";
    const names = ["src/flow.mjs", "removed.mjs", "unknown.mjs", ".agents/skills/oracle/SKILL.md"], diff = "@@ -1 +1 @@\n-old\n+new ∑\n";
    const packet = await prepareSourcePacket({directory: run, candidate: {commit: "c",tree:"current",base:"review-base"},diffBase:"previous-attempt",inputs:{authorities:[]},
      evidence:{review_context:{eligible_coverage:[],supporting_coverage:[{path:names[0],input_sha256:"old-bound-input",dependencies:["src/dependency.mjs"]}]}},
      cohort:{id:"implementation-consumers",required_paths:names}, diff,
      sourceForPath:async (name,revision)=>name==="unknown.mjs"?null:name==="removed.mjs"&&revision==="current"?{state:"ABSENT",locator:{name,revision}}
        :{state:"PRESENT",text:source,git_blob:"synthetic-blob",locator:{name,revision}}});
    const bytes=await readFile(packet.reference.path), manifest=JSON.parse(bytes);
    assert.equal(contentHash(bytes),packet.reference.sha256);assert.deepEqual(manifest.required_paths,names);
    assert.equal(manifest.diff_base,"previous-attempt");assert.equal(manifest.review_base,"review-base");
    assert.equal((await Promise.all(manifest.assigned_diff.map(page=>readFile(page.path,"utf8")))).join(""),diff);
    const current=manifest.items[0].versions.find(version=>version.revision==="current");
    assert.equal((await Promise.all(current.pages.map(page=>readFile(page.path,"utf8")))).join(""),source);
    assert.ok(current.pages.every(page=>page.bytes<=8192));assert.equal(current.complete_changed_definitions.completeness,"ALL_ENCLOSING_DEFINITIONS_AND_METHODS_INCLUDED");
    assert.deepEqual(manifest.items[0].dependencies_on_demand,["src/dependency.mjs"]);assert.equal(manifest.items[0].dependency_closure,"UNKNOWN_UNTIL_INDEPENDENT_TRACE");
    assert.equal(manifest.items[1].versions.find(version=>version.revision==="current").state,"ABSENT");
    assert.equal(manifest.items[2].versions[0].state,"UNKNOWN_SOURCE_ON_DEMAND");
    assert.equal(manifest.items[3].state,"TRUSTED_REVIEWER_AUTHORITY_ON_DEMAND");
    assert.match(manifest.dependency_policy,/grant no coverage, validation or approval/);
    for(const file of packet.files)assert.equal(contentHash(await readFile(file.path)),file.sha256);
    await writeFile(current.pages[0].path,"altered packet body");assert.notEqual(contentHash(await readFile(current.pages[0].path)),current.pages[0].sha256);
  },{ownerRoot:root});
});
