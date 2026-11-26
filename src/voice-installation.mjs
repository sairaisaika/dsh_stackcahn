import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceEnvironment} from './voice-environment.mjs';

const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const helperInput='scripts/prepare_voice_installation.py';
const legacyInputs=[helperInput,'scripts/prepare_voice.py','scripts/prepare_audio.py',
  'vendor/voice/assets.json','vendor/audio/assets.json','vendor/voice/installer-assets.json',
  'vendor/voice/requirements-macos-arm64.lock','vendor/voice/build-tools.lock'];
const workerInputs=[...legacyInputs,'vendor/voice/whisper-worker/CMakeLists.txt','vendor/voice/whisper-worker/main.cpp'];
const currentInputs=[...workerInputs,'vendor/audio/aec-v12.json'];
const previousHelperSha={
  1:'b26e80f32d09b6f674a6eaeed1b9aa962302cfc9670223ad1d53e0eb78a7a8bf',
  2:'c46d78731438dbc2b9e44808f9ec1f2acbfa321ba33cdfdb8081beabce915b81',
};
const currentVersion=3;
const activePointers=[['active-aec-v12.json',currentVersion],['active-whisper-worker.json',2],['active.json',1]];
const stages=new Set(['python','dependencies','models','audio','whisper']);
export const voiceInstallationErrors=Object.freeze(['voice_installation_storage_invalid','voice_installation_busy','voice_installation_python_required',
  'voice_installation_platform_unsupported','voice_installation_tools_required','voice_installation_source_invalid',
  'voice_installation_outdated','voice_installation_cancelled','voice_installation_failed','voice_installation_selftest_failed','voice_installation_cleanup_unconfirmed','voice_installation_profile_required']);
const codes=new Set(voiceInstallationErrors);
const fault=code=>Object.assign(new Error(code),{code});
const hex=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const environment=()=>Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function privateDirectory(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)throw fault('voice_installation_storage_invalid');}
async function privateFile(path,max=8192){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.size>max)throw Error();return await file.readFile();}
  catch{throw fault('voice_installation_storage_invalid');}finally{await file.close();}
}
async function fingerprint(inputs,version){
  return Object.fromEntries(await Promise.all(inputs.map(async name=>[
    name,name===helperInput&&previousHelperSha[version]?previousHelperSha[version]:sha(await readFile(join(packageRoot,name))),
  ])));
}
function terminate(child){try{process.kill(-child.pid,'SIGTERM');}catch{}return setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);}
function probe(command,args,signal){
  return new Promise(resolve=>{
    if(signal.aborted){resolve(null);return;}
    const child=spawn(command,args,{env:environment(),detached:true,stdio:['ignore','pipe','ignore']});
    let output='',failed=false,escalation;const cancel=()=>{failed=true;escalation??=terminate(child);};
    const timer=setTimeout(cancel,5000);signal.addEventListener('abort',cancel,{once:true});
    child.on('error',()=>{failed=true;});child.stdout.on('data',chunk=>{if(output.length+chunk.length>4096)cancel();else output+=chunk.toString();});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(escalation);signal.removeEventListener('abort',cancel);resolve(!failed&&code===0?output:null);});
    if(signal.aborted)cancel();
  });
}

/** Profile-owned installation transaction. Does not mutate profile configuration or hardware. */
export function createVoiceInstallation({profileDirectory,pythonCandidates,helper=join(packageRoot,'scripts/prepare_voice_installation.py'),factories={}}){
  const root=typeof profileDirectory==='string'&&isAbsolute(profileDirectory)?join(profileDirectory,'.stackchan-voice'):null;
  const candidates=pythonCandidates??[join(homedir(),'.local/bin/python3.11'),'/opt/homebrew/bin/python3.11','/usr/local/bin/python3.11','python3.11'];
  const lifetime=new AbortController();let pending;
  const runProbe=factories.probe??probe;
  let state={stage:'idle',busy:false,available:false,error:'',prerequisites:null};
  const snapshot=()=>structuredClone(state);
  async function findPython(signal){
    for(const candidate of [...new Set(candidates)]){
      const output=await runProbe(candidate,['-I','-c','import sys,venv,json,platform;print(json.dumps({"executable":sys.executable,"system":platform.system(),"machine":platform.machine()})) if sys.version_info[:2] == (3,11) else sys.exit(1)'],signal);
      if(signal.aborted)throw fault('voice_installation_cancelled');
      let value;try{value=JSON.parse(output);}catch{}
      if(value&&typeof value.executable==='string'&&isAbsolute(value.executable)&&value.system==='Darwin'&&value.machine==='arm64')return value.executable;
    }
    return null;
  }
  async function checkPrerequisites(signal){
    const report={checkedAt:Date.now(),platform:'unsupported',python:'not_checked',developerTools:'not_checked',ready:false};
    if((factories.platform??process.platform)!=='darwin'||(factories.arch??process.arch)!=='arm64')return report;
    report.platform='available';
    report.python=await findPython(signal)?'available':'missing';
    // A missing selection must not invoke a tool shim that offers installation.
    const selected=await runProbe('/usr/bin/xcode-select',['-p'],signal);
    report.developerTools='missing';
    if(selected?.trim()){
      let found=true;
      for(const tool of ['clang','make','git']){
        if(signal.aborted)throw fault('voice_installation_cancelled');
        if(!(await runProbe('/usr/bin/xcrun',['--find',tool],signal))?.trim())found=false;
      }
      if(found)report.developerTools='available';
    }
    if(signal.aborted)throw fault('voice_installation_cancelled');
    report.ready=report.python==='available'&&report.developerTools==='available';
    return report;
  }
  async function installation(generation,version){
    if(!root||!hex(generation))throw fault('voice_installation_storage_invalid');
    await privateDirectory(root);const directory=join(root,generation);await privateDirectory(directory);
    await privateDirectory(join(directory,'venv'));await privateDirectory(join(directory,'venv/bin'));
    const legacy=version===1;
    const inputs=legacy?legacyInputs:version===2?workerInputs:currentInputs;
    const record=JSON.parse(await privateFile(join(directory,'candidate.json')));const expected=await fingerprint(inputs,version);
    if(!exact(record,['version','generation','inputs','whisperSha256'])||record.version!==version||record.generation!==generation
      ||!exact(record.inputs,inputs)||inputs.some(name=>record.inputs[name]!==expected[name])
      ||typeof record.whisperSha256!=='string'||!/^[0-9a-f]{64}$/.test(record.whisperSha256))throw fault('voice_installation_outdated');
    await privateDirectory(join(directory,'bin'));
    const whisperBinary=join(directory,legacy?'bin/whisper-cli':'bin/sion-whisper-worker');
    if(sha(await privateFile(whisperBinary,100_000_000))!==record.whisperSha256)throw fault('voice_installation_storage_invalid');
    return {python:join(directory,'venv/bin/python3'),assetsDirectory:join(directory,'assets'),audioDirectory:join(directory,'audio'),
      whisperBinary,temporaryDirectory:join(directory,'temporary'),...(legacy?{}:{whisperProtocol:1}),
      ...(version===currentVersion?{aecV12:true}:{})};
  }
  async function active(){
    if(!root)return null;
    try{
      await privateDirectory(root);
    }catch(error){
      state.available=false;
      if(error.code==='ENOENT')return null;
      throw fault('voice_installation_storage_invalid');
    }
    for(const [name,version] of activePointers){
      try{
        let bytes;
        try{bytes=await privateFile(join(root,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}
        const pointer=JSON.parse(bytes);
        if(!exact(pointer,['version','generation'])||pointer.version!==version||!hex(pointer.generation))throw fault('voice_installation_storage_invalid');
        const value=await installation(pointer.generation,version);state.available=true;return value;
      }catch(error){
        state.available=false;throw fault(codes.has(error.code)?error.code:'voice_installation_storage_invalid');
      }
    }
    state.available=false;return null;
  }
  async function build(replace,signal){
    if(!root)throw fault('voice_installation_profile_required');
    state.stage='prerequisites';
    const python=await findPython(signal);
    if(!python)throw fault('voice_installation_python_required');
    const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]);
    const child=spawn(python,['-I',helper,'--root',root,...(replace?['--replace']:[])],{env:environment(),detached:true,stdio:['pipe','pipe','ignore']});
    let buffer='',messages=0,chain=Promise.resolve(),failure,stoppingGroup,candidateId,committed=false,doneId,report;
    const stop=code=>{
      failure??=code;abort.abort();
      stoppingGroup??=(async()=>{
        if(!child.pid)return;
        const exists=()=>{try{process.kill(-child.pid,0);return true;}catch{return false;}};
        if(!exists())return;
        try{process.kill(-child.pid,'SIGTERM');}catch{}
        for(let i=0;i<10&&exists();i++)await delay(100);
        if(!exists())return;
        try{process.kill(-child.pid,'SIGKILL');}catch{}
        for(let i=0;i<30&&exists();i++)await delay(100);
        if(exists())failure='voice_installation_cleanup_unconfirmed';
      })();
    };
    const cancel=()=>stop('voice_installation_cancelled');signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>stop('voice_installation_failed'),1800000);
    child.stdin.on('error',()=>stop('voice_installation_failed'));child.on('error',()=>stop('voice_installation_failed'));
    const handle=async value=>{
      if(failure)return;
      if(exact(value,['type','stage'])&&value.type==='progress'&&stages.has(value.stage)&&!candidateId){state.stage=value.stage;return;}
      if(exact(value,['type','code'])&&value.type==='error'&&codes.has(value.code)){stop(value.code);return;}
      if(exact(value,['type','generation'])&&value.type==='candidate'&&hex(value.generation)&&!candidateId){
        candidateId=value.generation;state.stage='verifying';const options=await installation(candidateId,currentVersion);
        report=await (factories.verify??(options=>createVoiceEnvironment({installation:options}).verify(combined)))(options,combined);
        if(combined.aborted)throw fault('voice_installation_cancelled');
        if(!report.filesVerified||report.loadTest!=='passed')throw fault('voice_installation_selftest_failed');
        committed=true;state.stage='publishing';child.stdin.end('commit\n');return;
      }
      if(exact(value,['type','generation'])&&value.type==='done'&&committed&&value.generation===candidateId&&!doneId){doneId=value.generation;return;}
      throw fault('voice_installation_failed');
    };
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>8192){stop('voice_installation_failed');return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(++messages>32){stop('voice_installation_failed');return;}
        chain=chain.then(()=>handle(JSON.parse(line))).catch(error=>stop(codes.has(error.code)?error.code:'voice_installation_failed'));
      }
    });
    if(signal.aborted)cancel();
    const exit=await new Promise(resolve=>child.once('close',code=>{if(code!==0||!committed)abort.abort();resolve(code);}));
    clearTimeout(timer);signal.removeEventListener('abort',cancel);
    await chain;
    if(exit!==0||!doneId)stop(failure??'voice_installation_failed');
    await stoppingGroup;
    if(failure==='voice_installation_cleanup_unconfirmed')throw fault(failure);
    if(signal.aborted)throw fault('voice_installation_cancelled');
    if(failure||exit!==0||buffer||!doneId)throw fault(failure??'voice_installation_failed');
    const result=await active();if(!result||result.python!==join(root,doneId,'venv/bin/python3'))throw fault('voice_installation_failed');
    return {installation:result,report};
  }
  return {
    active,snapshot,
    async inspectPrerequisites(signal){
      if(lifetime.signal.aborted)throw fault('voice_installation_cancelled');
      if(pending)throw fault('voice_installation_busy');
      const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
      if(combined.aborted)throw fault('voice_installation_cancelled');
      const previousStage=state.stage;
      state={...state,stage:'checking',busy:true,prerequisites:null};
      const work=checkPrerequisites(combined);pending=work;
      try{state.prerequisites=await work;}
      finally{state.busy=false;state.stage=previousStage;if(pending===work)pending=null;}
      return snapshot();
    },
    async prepare({replace=false,signal}={}){
      if(lifetime.signal.aborted)throw fault('voice_installation_cancelled');
      if(pending)throw fault('voice_installation_busy');
      const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
      state={...state,busy:true,error:'',stage:'prerequisites'};
      const work=build(replace,combined);pending=work;
      try{const result=await work;state={...state,stage:'ready',available:true,busy:false,error:''};return result;}
      catch(error){const code=codes.has(error.code)||error.code==='voice_installation_profile_required'?error.code:'voice_installation_failed';state={...state,busy:false,stage:'failed',error:code};throw fault(code);}
      finally{if(pending===work)pending=null;}
    },
    async dispose(){lifetime.abort();await pending?.catch(()=>{});},
  };
}
