import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,readdir,mkdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceInstallation} from '../src/voice-installation.mjs';
const exec=promisify(execFile);
async function fixture(t){const profile=await mkdtemp(join(tmpdir(),'sion-voice-install-'));t.after(()=>rm(profile,{recursive:true,force:true}));return profile;}
test('Python candidate transaction covers commit barrier, preserved repair, lock and bad metadata',async()=>{
 const {stderr}=await exec(process.env.STACKCHAN_TEST_PYTHON||'python3',['scripts/test_prepare_voice_installation.py']);assert.match(stderr,/Ran 6 tests/);assert.match(stderr,/OK/);
});
test('installation construction is passive and missing Python cannot create an environment',async t=>{
 const profile=await fixture(t),setup=createVoiceInstallation({profileDirectory:profile,pythonCandidates:[]});t.after(()=>setup.dispose());
 assert.equal(setup.snapshot().stage,'idle');assert.deepEqual(await readdir(profile),[]);assert.equal(await setup.active(),null);
 await assert.rejects(setup.prepare(),{code:'voice_installation_python_required'});assert.deepEqual(await readdir(profile),[]);
});
test('active reader rejects arbitrary paths, invalid permissions and missing published generation',async t=>{
 const profile=await fixture(t),root=join(profile,'.stackchan-voice');await mkdir(root,{mode:0o700});
 const setup=createVoiceInstallation({profileDirectory:profile});t.after(()=>setup.dispose());
 for(const generation of ['../outside','a'.repeat(32)]){
  await writeFile(join(root,'active.json'),JSON.stringify({version:1,generation}),{mode:0o600});
  await assert.rejects(setup.active(),{code:'voice_installation_storage_invalid'});
 }
 await chmod(root,0o755);await assert.rejects(setup.active(),{code:'voice_installation_storage_invalid'});
});
// Use the real lock/publication helper with only the heavyweight build substituted.
async function fakeHelper(profile,extra=''){
 const path=join(profile,'helper.py');
 await writeFile(path,`import sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(resolve('scripts'))})\nimport prepare_voice_installation as s\nfrom test_prepare_voice_installation import fake_build\ns.prerequisites=lambda:None\ns.build=fake_build\nroot=Path(sys.argv[sys.argv.index('--root')+1])\n${extra}\ns.serve(root, '--replace' in sys.argv)\n`);return path;
}
const pythonCandidates=[join(process.env.HOME,'.local/bin/python3.11'),'/opt/homebrew/bin/python3.11','python3.11'];
// Fixture execution needs an actual 3.11 bootstrap, like the supported Mac installer.
const python311=await Promise.any(pythonCandidates.map(async path=>{await exec(path,['-I','-c','import sys;assert sys.version_info[:2]==(3,11)']);return path;})).catch(()=>null);
test('prerequisite inventory finds native Python after an incompatible candidate and creates no files',async t=>{
 const profile=await fixture(t),calls=[];
 const setup=createVoiceInstallation({profileDirectory:profile,pythonCandidates:['wrong-arch','native'],factories:{platform:'darwin',arch:'arm64',probe:async(command,args)=>{
  calls.push([command,args]);
  if(command==='wrong-arch'||command==='native')return JSON.stringify({executable:'/private/'+command,system:'Darwin',machine:command==='native'?'arm64':'x86_64'});
  return '/private/developer/tool\n';
 }}});t.after(()=>setup.dispose());
 assert.equal(setup.snapshot().prerequisites,null);assert.deepEqual(calls,[]);
 const result=await setup.inspectPrerequisites();
 assert.equal(result.busy,false);assert.equal(result.stage,'idle');assert.equal(result.available,false);
 assert.equal(result.prerequisites.ready,true);assert.ok(result.prerequisites.checkedAt>0);
 assert.deepEqual(calls.map(([command])=>command),['wrong-arch','native','/usr/bin/xcode-select','/usr/bin/xcrun','/usr/bin/xcrun','/usr/bin/xcrun']);
 assert.deepEqual(calls.slice(3).map(([,args])=>args),[['--find','clang'],['--find','make'],['--find','git']]);
 assert.doesNotMatch(JSON.stringify(result),/\/private/);assert.deepEqual(await readdir(profile),[]);
 result.prerequisites.ready=false;assert.equal(setup.snapshot().prerequisites.ready,true);
});
test('missing tools and Python are reported together without invoking unselected developer shims',async t=>{
 const profile=await fixture(t),calls=[];
 const setup=createVoiceInstallation({profileDirectory:profile,pythonCandidates:[],factories:{platform:'darwin',arch:'arm64',probe:async(command,args)=>{calls.push([command,args]);return null;}}});t.after(()=>setup.dispose());
 const report=(await setup.inspectPrerequisites()).prerequisites;
 assert.deepEqual({...report,checkedAt:0},{checkedAt:0,platform:'available',python:'missing',developerTools:'missing',ready:false});
 assert.deepEqual(calls,[['/usr/bin/xcode-select',['-p']]]);assert.deepEqual(await readdir(profile),[]);
});
test('unsupported platform is reported without probing programs',async t=>{
 const setup=createVoiceInstallation({factories:{platform:'linux',probe:async()=>{assert.fail('unexpected probe');}}});t.after(()=>setup.dispose());
 const report=(await setup.inspectPrerequisites()).prerequisites;
 assert.equal(report.platform,'unsupported');assert.equal(report.python,'not_checked');assert.equal(report.developerTools,'not_checked');assert.equal(report.ready,false);
});
test('cancelled prerequisite inspection waits for its probe, excludes installation and clears old readiness',async t=>{
 const profile=await fixture(t);let block=false,entered=false,finish;
 const setup=createVoiceInstallation({profileDirectory:profile,pythonCandidates:[],factories:{platform:'darwin',arch:'arm64',probe:async(command,args,signal)=>{
  if(!block)return null;entered=true;await new Promise(resolve=>{finish=resolve;});assert.ok(signal.aborted);return null;
 }}});t.after(()=>setup.dispose());
 await setup.inspectPrerequisites();assert.ok(setup.snapshot().prerequisites);
 block=true;const abort=new AbortController(),work=setup.inspectPrerequisites(abort.signal);const rejected=assert.rejects(work,{code:'voice_installation_cancelled'});
 for(let i=0;i<10&&!entered;i++)await delay(0);
 assert.equal(setup.snapshot().prerequisites,null);assert.equal(setup.snapshot().stage,'checking');
 await assert.rejects(setup.prepare(),{code:'voice_installation_busy'});abort.abort();assert.equal(setup.snapshot().busy,true);
 finish();await rejected;assert.equal(setup.snapshot().busy,false);assert.equal(setup.snapshot().stage,'idle');assert.deepEqual(await readdir(profile),[]);
});
test('Host verifies candidate before commit, reuses after restart and rejects failed repair without replacing active', {skip:!python311},async t=>{
 const profile=await fixture(t),helper=await fakeHelper(profile);let pass=true,calls=0;
 const setup=createVoiceInstallation({profileDirectory:profile,helper,pythonCandidates:[python311],factories:{verify:async options=>{
  assert.equal(options.whisperProtocol,1);assert.match(options.whisperBinary,/\/sion-whisper-worker$/);assert.equal(options.aecV12,true);
  calls++;return {filesVerified:true,loadTest:pass?'passed':'failed'};
 }}});t.after(()=>setup.dispose());
 const root=join(profile,'.stackchan-voice'),generation='a'.repeat(32),legacy=join(root,generation);
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const inputs={'scripts/prepare_voice_installation.py':'b26e80f32d09b6f674a6eaeed1b9aa962302cfc9670223ad1d53e0eb78a7a8bf'};
 for(const name of ['scripts/prepare_voice.py','scripts/prepare_audio.py','vendor/voice/assets.json','vendor/audio/assets.json',
  'vendor/voice/installer-assets.json','vendor/voice/requirements-macos-arm64.lock','vendor/voice/build-tools.lock']){
  inputs[name]=digest(await readFile(name));
 }
 await mkdir(join(legacy,'bin'),{recursive:true,mode:0o700});await mkdir(join(legacy,'venv/bin'),{recursive:true,mode:0o700});
 await writeFile(join(legacy,'bin/whisper-cli'),'old binary',{mode:0o700});
 await writeFile(join(legacy,'candidate.json'),JSON.stringify({version:1,generation,inputs,whisperSha256:digest('old binary')}),{mode:0o600});
 const legacyActive=JSON.stringify({version:1,generation});
 const legacyPointer=join(root,'active.json'),workerPointer=join(root,'active-whisper-worker.json'),aecPointer=join(root,'active-aec-v12.json');
 await writeFile(legacyPointer,legacyActive,{mode:0o600});
 assert.equal((await setup.active()).whisperBinary,join(legacy,'bin/whisper-cli'));
 const workerGeneration='b'.repeat(32),worker=join(root,workerGeneration);
 const workerInputs={...inputs,'scripts/prepare_voice_installation.py':'c46d78731438dbc2b9e44808f9ec1f2acbfa321ba33cdfdb8081beabce915b81'};
 for(const name of ['vendor/voice/whisper-worker/CMakeLists.txt','vendor/voice/whisper-worker/main.cpp'])
  workerInputs[name]=digest(await readFile(name));
 await mkdir(join(worker,'bin'),{recursive:true,mode:0o700});await mkdir(join(worker,'venv/bin'),{recursive:true,mode:0o700});
 await writeFile(join(worker,'bin/sion-whisper-worker'),'previous worker',{mode:0o700});
 await writeFile(join(worker,'candidate.json'),JSON.stringify({version:2,generation:workerGeneration,inputs:workerInputs,whisperSha256:digest('previous worker')}),{mode:0o600});
 const workerActive=JSON.stringify({version:2,generation:workerGeneration});
 await writeFile(workerPointer,workerActive,{mode:0o600});
 assert.equal((await setup.active()).whisperBinary,join(worker,'bin/sion-whisper-worker'));
 assert.equal((await setup.active()).aecV12,undefined);
 await setup.prepare();assert.equal(setup.snapshot().stage,'ready');const previous=await readFile(aecPointer,'utf8');
 const next=createVoiceInstallation({profileDirectory:profile,helper,pythonCandidates:[python311],factories:{verify:async()=>({filesVerified:true,loadTest:'passed'})}});t.after(()=>next.dispose());
 assert.deepEqual(await next.active(),await setup.active());await next.prepare();assert.equal(await readFile(aecPointer,'utf8'),previous);
 pass=false;await assert.rejects(setup.prepare({replace:true}),{code:'voice_installation_selftest_failed'});
 assert.equal(await readFile(aecPointer,'utf8'),previous);assert.equal(calls,2);
 assert.equal(await readFile(legacyPointer,'utf8'),legacyActive);
 assert.equal(await readFile(workerPointer,'utf8'),workerActive);
 await writeFile((await next.active()).whisperBinary,'tampered');
 await assert.rejects(next.active(),{code:'voice_installation_storage_invalid'});
});
test('Host cancellation during candidate verification waits cleanup and never publishes', {skip:!python311},async t=>{
 const profile=await fixture(t),helper=await fakeHelper(profile);let entered=false,cleaned=false;
 const setup=createVoiceInstallation({profileDirectory:profile,helper,pythonCandidates:[python311],factories:{verify:async(options,signal)=>{entered=true;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await delay(20);cleaned=true;throw Error('private');}}});t.after(()=>setup.dispose());
 const abort=new AbortController(),pending=setup.prepare({signal:abort.signal});const rejected=assert.rejects(pending,{code:'voice_installation_cancelled'});
 for(let i=0;i<100&&!entered;i++)await delay(10);assert.ok(entered);abort.abort();await rejected;assert.ok(cleaned);assert.equal(await setup.active(),null);
});

test('cancelling installer also reaps a build descendant that ignores TERM after helper exits', {skip:!python311},async t=>{
 const profile=await fixture(t),marker=join(profile,'descendant');
 const childCode=`import signal,time,os;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(${JSON.stringify(marker)}).write_text(str(os.getpid()));time.sleep(60)`;
 const helper=await fakeHelper(profile,`import subprocess\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(childCode)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)`);
 let entered=false;
 const setup=createVoiceInstallation({profileDirectory:profile,helper,pythonCandidates:[python311],factories:{verify:async(options,signal)=>{entered=true;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Error();}}});t.after(()=>setup.dispose());
 const abort=new AbortController(),pending=setup.prepare({signal:abort.signal});const rejected=assert.rejects(pending,{code:'voice_installation_cancelled'});
 // File creation can be visible before write_text has written the PID. Empty
 // content is Number('') === 0, not evidence that the child is ready.
 let pid;for(let i=0;i<100;i++){try{pid=Number(await readFile(marker,'utf8'));if(Number.isSafeInteger(pid)&&pid>0&&entered)break;}catch{}await delay(10);}
 assert.ok(pid&&entered);abort.abort();await rejected;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(await setup.active(),null);
});
