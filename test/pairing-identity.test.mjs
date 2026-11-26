import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPairingHost} from '../src/pairing-host.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'sion-identity-'));const directory=join(root,'private');
  const host=createPairingHost({directory,python:process.env.STACKCHAN_TEST_PYTHON||'python3'});
  t.after(async()=>{await host.dispose();await rm(root,{recursive:true,force:true});});
  const result=await host.call({action:'prepare',revision:0,deviceId:'123456abcdef',localUrl:'wss://192.168.1.2:9080/audio'});
  assert.equal(result.ok,true);
  const path=join(directory,'state.json');const state=JSON.parse(await readFile(path,'utf8'));
  const activate=async()=>{state.active=state.candidate;state.candidate=null;await writeFile(path,JSON.stringify(state),{mode:0o600});};
  return {host,directory,path,state,activate};
}
test('only confirmed active identity can be leased; candidate and unknown commits are refused',async t=>{
  const f=await fixture(t);await assert.rejects(f.host.acquireIdentity(),{code:'active_identity_required'});
  await f.activate();const first=await f.host.acquireIdentity();assert.equal(first.deviceId,'123456abcdef');
  const pairId=first.pairing.record.pair_id;await first.release();
  f.state.pending={action:'remove',previous:pairId,target:''};await writeFile(f.path,JSON.stringify(f.state));
  await assert.rejects(f.host.acquireIdentity(),{code:'reconcile_required'});
});
test('held identity blocks independent journal processes and releases on actual helper exit',async t=>{
  const f=await fixture(t);await f.activate();const before=await readFile(f.path);
  const lease=await f.host.acquireIdentity();
  assert.equal((await f.host.call({action:'snapshot'})).error,'host_busy');
  const other=createPairingHost({directory:f.directory});t.after(()=>other.dispose());
  assert.equal((await other.call({action:'snapshot'})).error,'host_busy');
  await lease.release();assert.equal((await other.call({action:'snapshot'})).ok,true);
  assert.deepEqual(await readFile(f.path),before);
});
test('identity cancellation and Host disposal release OS lock without presenting normal release',async t=>{
  const f=await fixture(t);await f.activate();const abort=new AbortController();
  const lease=await f.host.acquireIdentity(abort.signal);abort.abort();assert.equal((await lease.closed).expected,false);
  await assert.rejects(lease.release(),{code:'identity_release_unconfirmed'});
  const next=await f.host.acquireIdentity();await f.host.dispose();assert.equal((await next.closed).expected,false);
  const other=createPairingHost({directory:f.directory});t.after(()=>other.dispose());
  assert.equal((await other.call({action:'snapshot'})).ok,true);
});
test('identity failures never return private bundle data or raw filesystem paths',async t=>{
  const f=await fixture(t);await f.activate();await writeFile(f.path,'PRIVATE malformed');
  try{await f.host.acquireIdentity();assert.fail('must reject');}catch(error){assert.equal(error.code,'private_storage_invalid');assert.equal(error.message,error.code);}
});
