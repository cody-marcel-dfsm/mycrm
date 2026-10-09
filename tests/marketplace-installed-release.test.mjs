import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyLocalInstall} from '../scripts/marketplace-installed-release.mjs';

const run=promisify(execFile);

test('installed release verification uses the active Node runtime when node is absent from PATH',async()=>{
  const calls=[];
  const result=await verifyLocalInstall(async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});
    return run(command,['-e','process.stdout.write("active-runtime-ran")'],{
      ...options,
      env:{...process.env,PATH:'/usr/bin:/bin'}
    });
  });
  assert.deepEqual(calls,[{
    command:process.execPath,
    args:['scripts/codex-local-install.mjs','verify'],
    cwd:new URL('..',import.meta.url)
  }]);
  assert.equal(result.stdout,'active-runtime-ran');
});
