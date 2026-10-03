import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeCatalog} from './marketplace-native.mjs';
import {installedRelease} from './marketplace-installed-release.mjs';
import {loadPromptCatalog,submissionCases} from './marketplace-prompt-catalog.mjs';
import {selectedModel} from './codex-child-model.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
async function main(){
 const [command,configPath,...selected]=process.argv.slice(2);const load=()=>loadPromptCatalog(root);
 if(command==='--list'){console.log(JSON.stringify(await load(),null,2));return;}
 if(command==='--submission-cases'){console.log(JSON.stringify(submissionCases(await load()),null,2));return;}
 if(command!=='--run'||!configPath)throw new Error('Usage: --list | --submission-cases | --run <external-private-reviewer-config.json> [case IDs]');
 const location=relative(root,resolve(configPath));if(!location.startsWith('..')&&!isAbsolute(location))throw new Error('Reviewer configuration must stay outside the repository');
 const config=JSON.parse(await readFile(resolve(configPath),'utf8'));
 const report=await nativeCatalog(load,config,installedRelease,await selectedModel(),selected);
 console.log(JSON.stringify(report,null,2));if(report.status!=='PASS')process.exitCode=1;
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Marketplace integration failed: configuration or native prerequisite unavailable');process.exitCode=1;});
