import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPublishedPackage,readPublishedFile,assertPackageOwnedBinding} from '../scripts/marketplace-published-package.mjs';
const run=promisify(execFile);
test('publication evidence rejects ignored additions, altered bytes and untracked package roots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'marketplace-publication-'));
 try{
  await run('git',['init','-q'],{cwd:dir});
  await mkdir(join(dir,'pkg/skills/example'),{recursive:true});
  await writeFile(join(dir,'.gitignore'),'pkg/ignored/\nlocal-package/\n');
  await writeFile(join(dir,'pkg/skills/example/SKILL.md'),'Published skill\n');
  await run('git',['add','.'],{cwd:dir});
  await run('git',['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','Published fixture'],{cwd:dir});
  const commit=(await run('git',['rev-parse','HEAD'],{cwd:dir})).stdout.trim(),pkg=join(dir,'pkg');
  assert.match(await verifyPublishedPackage(pkg,commit),/^[a-f0-9]{64}$/);
  await mkdir(join(pkg,'ignored'),{recursive:true});await writeFile(join(pkg,'ignored/SKILL.md'),'Unpublished addition');
  assert.equal((await run('git',['status','--porcelain'],{cwd:dir})).stdout.trim(),'');
  await assert.rejects(verifyPublishedPackage(pkg,commit),error=>error.acceptance_reason==='installed_package_not_published');
  await rm(join(pkg,'ignored'),{recursive:true});
  await writeFile(join(pkg,'skills/example/SKILL.md'),'Changed skill');
  await assert.rejects(readPublishedFile(pkg,commit,'skills/example/SKILL.md'),/Unpublished package bytes/);
  await mkdir(join(dir,'local-package'),{recursive:true});await writeFile(join(dir,'local-package/SKILL.md'),'Ignored package');
  await assert.rejects(verifyPublishedPackage(join(dir,'local-package'),commit),error=>error.acceptance_reason==='installed_package_not_published');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('equivalent manual BOS bindings and competing package owners fail provenance',()=>{
 const binding={url:'https://example.test/mcp'},owner='bos@fixture';
 assert.doesNotThrow(()=>assertPackageOwnedBinding({},[owner],owner,binding));
 assert.throws(()=>assertPackageOwnedBinding({'BOS-Platform':binding},[owner],owner,binding));
 assert.throws(()=>assertPackageOwnedBinding({manual:binding},[owner],owner,binding));
 assert.throws(()=>assertPackageOwnedBinding({},[owner,'other@fixture'],owner,binding));
 assert.throws(()=>assertPackageOwnedBinding({},['other@fixture'],owner,binding));
});

test('generated My CRM release proves its documented copy mapping against published source bytes',async()=>{
 const {createHash}=await import('node:crypto');
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const dir=await mkdtemp(join(tmpdir(),'marketplace-generated-release-'));
 try{
  await run('git',['init','-q'],{cwd:dir});
  await writeFile(join(dir,'.gitignore'),'dist/\n');
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'my-crm',version:'1.0.0'}));
  await mkdir(join(dir,'plugins/my-crm/skills/example'),{recursive:true});
  await writeFile(join(dir,'plugins/my-crm/skills/example/SKILL.md'),'Published skill\n');
  await mkdir(join(dir,'plugins/my-crm/skills/example-activity'),{recursive:true});
  await writeFile(join(dir,'plugins/my-crm/skills/example-activity/SKILL.md'),'Published activity\n');
  await run('git',['add','.'],{cwd:dir});
  await run('git',['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','Published generated source'],{cwd:dir});
  const commit=(await run('git',['rev-parse','HEAD'],{cwd:dir})).stdout.trim();
  const pkg=join(dir,'dist/my-crm');await mkdir(join(pkg,'skills/example'),{recursive:true});
  await writeFile(join(pkg,'skills/example/SKILL.md'),'Published skill\n');
  await mkdir(join(pkg,'skills/example-activity'),{recursive:true});
  await writeFile(join(pkg,'skills/example-activity/SKILL.md'),'Published activity\n');
  const inventory=[{path:'skills/example/SKILL.md',sha256:hash('Published skill\n')},{path:'skills/example-activity/SKILL.md',sha256:hash('Published activity\n')}];
  const content=hash(inventory.map(row=>row.path+'\0'+row.sha256+'\n').join(''));
  const manifest={schema:'my-crm.release/v1',name:'my-crm',version:'1.0.0',files:inventory,content_sha256:content};
  await writeFile(join(pkg,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  assert.equal((await run('git',['status','--porcelain'],{cwd:dir})).stdout.trim(),'');
  assert.equal(await verifyPublishedPackage(pkg,commit),content);
  assert.equal((await readPublishedFile(pkg,commit,'skills/example/SKILL.md')).toString(),'Published skill\n');
  await writeFile(join(pkg,'skills/example/extra.md'),'Unpublished');
  await assert.rejects(verifyPublishedPackage(pkg,commit),error=>error.acceptance_reason==='installed_package_not_published');
  await rm(join(pkg,'skills/example/extra.md'));
  await writeFile(join(pkg,'skills/example/SKILL.md'),'Unpublished mutation');
  await assert.rejects(verifyPublishedPackage(pkg,commit),error=>error.acceptance_reason==='installed_package_not_published');
 }finally{await rm(dir,{recursive:true,force:true});}
});
