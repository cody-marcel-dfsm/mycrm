import {cp, mkdir, rm, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {readJson, repositoryRoot, sha256, sha256File, stableJson, walkFiles} from "./release-utils.mjs";
import {checkPrivacy} from "./check-privacy.mjs";

export const releaseDirectory = path.join(repositoryRoot, "dist/my-crm");
const COPY_ENTRIES = ["contracts", "examples", "src", "LICENSE", "NOTICE", "README.md"];

export async function buildRelease({destination = releaseDirectory} = {}) {
  await checkPrivacy({root: repositoryRoot, includeDist: false});
  const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
  await rm(destination, {recursive: true, force: true});
  await mkdir(destination, {recursive: true});
  await cp(path.join(repositoryRoot, "plugins/my-crm"), destination, {recursive: true, force: true});
  for (const entry of COPY_ENTRIES) {
    await cp(path.join(repositoryRoot, entry), path.join(destination, entry), {recursive: true, force: true});
  }
  const files = await walkFiles(destination);
  const inventory = [];
  for (const relative of files) inventory.push({path: relative, sha256: await sha256File(path.join(destination, relative))});
  const release = {
    schema: "my-crm.release/v1",
    name: packageJson.name,
    version: packageJson.version,
    bos_contract_bundle_sha256: (await readJson(path.join(repositoryRoot, "contracts/bos/lead-director/v1/manifest.json"))).bundle_sha256,
    bos_service_consumer_archive_sha256: (await readJson(path.join(repositoryRoot, "contracts/bos/service-journey/import-provenance.json"))).archive_sha256,
    boc_client_dependency_bundle_sha256: (await readJson(path.join(repositoryRoot, "contracts/bos-operations-center/bos-client-dependency/v1/manifest.json"))).bundle_sha256,
    files: inventory,
    content_sha256: sha256(inventory.map(({path: relative, sha256: digest}) => `${relative}\0${digest}\n`).join(""))
  };
  await writeFile(path.join(destination, "release-manifest.json"), stableJson(release));
  await checkPrivacy({root: destination, includeDist: true});
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = await buildRelease();
    console.log(`MYCRM_RELEASE_BUILD=APPROVED version=${release.version} sha256=${release.content_sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
