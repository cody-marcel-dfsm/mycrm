import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile, mkdir, symlink, open} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {prepareSourcePacket, utf8Pages} from "../scripts/oracle-source-packet.mjs";
import {contentHash, withOracleRun, pathCustody, readBoundAuthority} from "../scripts/oracle-inputs.mjs";

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

test("authority packet admission preserves safe routes and rejects changed custody before target reads", async (t) => {
  const root=await mkdtemp(path.join(os.tmpdir(),"mycrm-authority-packet-")),foreign=await mkdtemp(path.join(os.tmpdir(),"mycrm-foreign-packet-"));
  t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(foreign,{recursive:true,force:true})]));
  const project=path.join(root,"project"),actual=path.join(root,"actual"),other=path.join(root,"other"),alias=path.join(root,"public");
  await Promise.all([mkdir(project),mkdir(actual),mkdir(other)]);
  for(const directory of [actual,other,foreign])await writeFile(path.join(directory,"authority.md"),"Synthetic identical authority content");
  await symlink(actual,alias);const filename=path.join(alias,"authority.md");
  const authority={path:filename,sha256:contentHash(await readFile(filename)),custody:await pathCustody(project,filename,{scopeRoot:root,allowFinalLink:false})};
  assert.equal((await readBoundAuthority(project,authority)).toString(),"Synthetic identical authority content");
  let opens=0,reads=0;
  const openFile=async(...args)=>{opens++;const handle=await open(...args);return {stat:()=>handle.stat(),close:()=>handle.close(),readFile:()=>{reads++;return handle.readFile();}};};
  for(const target of [foreign,other]){
    await rm(alias);await symlink(target,alias);
    await assert.rejects(readBoundAuthority(project,authority,{openFile}),/custody|source scope/);assert.equal(opens,0);assert.equal(reads,0);
  }
  await symlink(actual,path.join(foreign,"return"));await rm(alias);await symlink(path.join(foreign,"return"),alias);
  await assert.rejects(readBoundAuthority(project,authority,{openFile}),/source scope/);assert.equal(opens,0);assert.equal(reads,0);
  await rm(alias);await symlink(actual,alias);
  await assert.rejects(readBoundAuthority(project,authority,{openFile,beforeRead:async()=>{await rm(alias);await symlink(foreign,alias);}}),/source scope/);
  assert.equal(opens,1);assert.equal(reads,0,"No foreign target bytes are read after descriptor admission changes");
});

test("paged navigation preserves complete actual rationale, dependency identities and every invalidation reason", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-native-navigation-")); t.after(() => rm(root, {recursive: true, force: true}));
  await withOracleRun(path.join(root, "oracle"), async ({run}) => {
    const observation = {path: "src/flow.mjs", assessment: "Original reviewed failure behavior.", dependency_rationale: "Every actual consumed input and its authority.",
      criteria: ["Current-source custody", "Failure recovery"], evidence: ["Original native report"],
      origin: {round: 4, original_status: "ERROR", original_sha256: "original-report"},
      dependency_comparisons: [{path: "src/flow.mjs", original: {content: "old", custody_sha256: "a"}, current: {content: "current", custody_sha256: "b"}, equal: false}],
      coverage_eligibility: "NONE"};
    const invalidated = [{kind: "coverage", id: observation.path, reason: "Source and custody changed", changed_dependencies: [observation.path]},
      {kind: "validation", id: "prior-test", reason: "Original output missing"}, {kind: "observed-assessment", id: "raw", reason: "Original custody changed"}];
    const packet = await prepareSourcePacket({directory: run, candidate: {tree: "current", base: "base"}, inputs: {authorities: []}, diff: "",
      cohort: {id: "implementation-consumers", required_paths: [observation.path]},
      evidence: {review_context: {navigation_coverage: [observation], invalidated}}});
    const manifest = JSON.parse(await readFile(packet.reference.path, "utf8"));
    const readPages = async pages => JSON.parse((await Promise.all(pages.map(page => readFile(page.path, "utf8")))).join(""));
    const navigation = manifest.items[0].retained_review_navigation;
    assert.deepEqual((await readPages(navigation.pages)).latest_observation, observation);
    assert.deepEqual(await readPages(manifest.all_invalidation_reasons.pages), invalidated);
    assert.equal(navigation.grants_eligible_coverage, false); assert.equal(navigation.grants_approval, false);
    assert.ok([...navigation.pages, ...manifest.all_invalidation_reasons.pages].every(page => page.bytes <= 8192));
    assert.equal((await readPages(navigation.pages)).current_disposition, null, "Absent native facts stay unknown");
  }, {ownerRoot: root});
});
