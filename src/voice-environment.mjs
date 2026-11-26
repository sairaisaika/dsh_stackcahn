import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,stat,open,readFile} from 'node:fs/promises';
import {isAbsolute,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalAudioFrontend} from './local-audio.mjs';
import {WhisperBackend,KokoroBackend,pcmToWav} from './local-speech.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const fail=code=>Object.assign(new Error(code),{code});
const ids=['platform','python','packages','whisper','speechAssets','audioAssets','nativeLibraries','temporaryDirectory'];
const usable=status=>['verified','available'].includes(status);
const configured=value=>typeof value==='string'&&isAbsolute(value);
const absent=error=>error?.code==='ENOENT'?'missing':'invalid';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function privateDirectory(path,{allowAbsent=false}={}){
  if(!configured(path))return 'unconfigured';
  try{const s=await lstat(path);return s.isDirectory()&&!s.isSymbolicLink()&&!(s.mode&0o077)&&s.uid===process.getuid()?'available':'invalid';}
  catch(e){
    if(e.code==='ENOENT'&&allowAbsent){
      // No creation during inspection; inference will make its own private root.
      let parent=dirname(path);
      while(parent!==dirname(parent)){
        try{const s=await lstat(parent);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())return 'invalid';await access(parent,constants.W_OK);return 'available';}
        catch(error){if(error.code!=='ENOENT')return 'invalid';parent=dirname(parent);}
      }
      return 'invalid';
    }
    return absent(e);
  }
}
async function fileHash(base,path,signal,expectedBytes){
  signal?.throwIfAborted();
  const local=relative(base,path);if(local.startsWith('..')||isAbsolute(local))throw fail('invalid-file');
  let current=base;
  for(const part of local.split('/').slice(0,-1)){
    current=join(current,part);const s=await lstat(current);
    if(!s.isDirectory()||s.isSymbolicLink())throw fail('invalid-file');
  }
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await h.stat();if(!stat.isFile()||stat.size>600_000_000||expectedBytes!==undefined&&stat.size!==expectedBytes)throw fail('invalid-file');
    const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0;
    while(true){signal?.throwIfAborted();const {bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>stat.size)throw fail('invalid-file');hash.update(buffer.subarray(0,bytesRead));}
    if(total!==stat.size)throw fail('invalid-file');return hash.digest('hex');
  }finally{await h.close();}
}
async function verifyAssets(directory,spec,signal){
  const status=await privateDirectory(directory);if(status!=='available')return status;
  try{for(const item of spec.files)if(await fileHash(directory,join(directory,item.path),signal,item.bytes)!==item.sha256)return 'invalid';return 'verified';}
  catch(error){signal?.throwIfAborted();return absent(error);}
}
async function executable(path){
  if(!configured(path))return 'unconfigured';
  try{if(!(await stat(path)).isFile())return 'invalid';await access(path,constants.X_OK);return 'available';}catch(error){return absent(error);}
}
function probePython(python,signal){
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const child=spawn(python,['-I',join(root,'scripts/voice_environment.py')],{env,stdio:['ignore','pipe','ignore'],detached:true});
    let output='',invalid=false,escalation;
    const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}escalation??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},500);};
    const abort=()=>kill();const timer=setTimeout(()=>{invalid=true;kill();},10000);
    child.on('error',()=>{invalid=true;});
    child.stdout.on('data',chunk=>{if(Buffer.byteLength(output)+chunk.length>1024){invalid=true;kill();}else output+=chunk.toString('utf8');});
    child.on('close',code=>{
      clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',abort);
      if(signal?.aborted){reject(fail('voice_cancelled'));return;}
      try{
        const value=JSON.parse(output);
        if(invalid||code!==0||Object.keys(value).sort().join(',')!=='packages,python,version'||value.version!==1
          ||!['available','unsupported'].includes(value.python)||!['verified','missing','invalid','not_checked'].includes(value.packages))throw Error();
        resolve(value);
      }catch{resolve({python:'invalid',packages:'not_checked'});}
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

/** Host-only configuration. All operations are explicit; construction performs no I/O. */
export function createVoiceEnvironment({installation,factories={}}){
  const make={audio:o=>new LocalAudioFrontend(o),recognition:o=>new WhisperBackend(o),synthesis:o=>new KokoroBackend(o),...factories};
  async function inspect(signal){
    signal?.throwIfAborted();
    const speech=JSON.parse(await readFile(join(root,'vendor/voice/assets.json'),'utf8'));
    const audioBytes=await readFile(join(root,'vendor/audio/assets.json'));const audio=JSON.parse(audioBytes);
    const aec=installation.aecV12?JSON.parse(await readFile(join(root,'vendor/audio/aec-v12.json'),'utf8')):null;
    const status=Object.fromEntries(ids.map(id=>[id,'not_checked']));
    status.platform=process.platform==='darwin'&&process.arch==='arm64'?'available':'unsupported';
    status.python=await executable(installation.python);
    if(status.python==='available')Object.assign(status,await (factories.probePython??probePython)(installation.python,signal));
    status.whisper=await executable(installation.whisperBinary);
    status.speechAssets=await verifyAssets(installation.assetsDirectory,speech,signal);
    const audioRoot=await privateDirectory(installation.audioDirectory);
    status.audioAssets=audioRoot==='available'?await verifyAssets(join(installation.audioDirectory,'assets'),audio,signal):audioRoot;
    if(aec&&status.audioAssets==='verified')
      status.audioAssets=await verifyAssets(join(installation.audioDirectory,'aec-v12'),aec,signal);
    status.nativeLibraries=audioRoot;
    if(audioRoot==='available'){
      try{
        const receipt=join(installation.audioDirectory,'native.json');
        const stat=await lstat(receipt);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16384)throw Error();
        const record=JSON.parse(await readFile(receipt,'utf8'));const names=['liblocalvqe.dylib','libspeexdsp.dylib'];
        if(record.version!==2||record.system!=='Darwin'||record.machine!=='arm64'||record.manifestSha256!==sha(audioBytes)
          ||record.builderSha256!==sha(await readFile(join(root,'scripts/prepare_audio.py')))
          ||Object.keys(record.libraries??{}).sort().join(',')!==names.join(','))throw Error();
        for(const name of names)if(await fileHash(installation.audioDirectory,join(installation.audioDirectory,name),signal)!==record.libraries[name])throw Error();
        status.nativeLibraries='verified';
      }catch(error){signal?.throwIfAborted();status.nativeLibraries=absent(error);}
    }
    status.temporaryDirectory=await privateDirectory(installation.temporaryDirectory,{allowAbsent:true});
    signal?.throwIfAborted();
    return {checkedAt:Date.now(),checks:ids.map(id=>({id,status:status[id]})),filesVerified:ids.every(id=>usable(status[id])),
      loadTest:'not_run',failedStage:'',assetBytes:speech.files.concat(audio.files,aec?.files??[]).reduce((sum,f)=>sum+f.bytes,0)};
  }
  async function verify(signal){
    const report=await (factories.inspect??inspect)(signal);if(!report.filesVerified)return report;
    let frontend,recognition,synthesis;let stage='audio';let error;
    try{
      frontend=make.audio({python:installation.python,directory:installation.audioDirectory,aecV12:installation.aecV12});
      await frontend.start({signal});for(let i=0;i<4;i++)await frontend.process(Buffer.alloc(960),{signal});
      await frontend.dispose();frontend=null;
      stage='synthesis';
      synthesis=make.synthesis({python:installation.python,assets:installation.assetsDirectory,timeoutMs:60000});
      let chinese,englishPcm;
      for(const [language,text,voice] of [['zh','语音检查。','zf_001'],['en','Voice check.','af_maple']]){
        const parts=[];let size=0;
        for await(const pcm of synthesis.synthesize(text,{language,voice,speechRate:1,signal})){
          size+=pcm.length;if(size>24000*2*30)throw Error();parts.push(pcm);
        }
        if(!size)throw Error();
        if(language==='zh')chinese=Buffer.concat(parts);
        else if(installation.whisperProtocol===1)englishPcm=Buffer.concat(parts);
      }
      stage='recognition';
      recognition=make.recognition({binary:installation.whisperBinary,model:join(installation.assetsDirectory,'whisper/ggml-small-q5_1.bin'),
        temporaryDirectory:installation.temporaryDirectory,protocol:installation.whisperProtocol,timeoutMs:60000});
      const result=await recognition.transcribe(chinese,{language:'zh',signal});
      if(!result.text.trim())throw Error();
      if(installation.whisperProtocol===1){
        const english=await recognition.transcribe(englishPcm,{language:'en',signal});
        if(!english.text.trim()||english.language!=='en'||result.language!=='zh')throw Error();
      }
    }catch(e){error=e;}
    finally{
      // Attempt every owner even if one unexpectedly rejects disposal.
      for(const owner of [frontend,recognition,synthesis])if(owner)try{await owner.dispose();}catch(e){error??=e;stage='cleanup';}
    }
    if(signal?.aborted)throw fail('voice_cancelled');
    return {...report,checkedAt:Date.now(),loadTest:error?'failed':'passed',failedStage:error?stage:''};
  }
  async function preview({language,voice,speechRate},signal){
    if(!['auto','zh','en'].includes(language)||!['','zf_001','zf_038','af_maple'].includes(voice)||
        !Number.isFinite(speechRate)||speechRate<0.5||speechRate>2)throw fail('voice_preview_preferences');
    const report=await (factories.inspect??inspect)(signal);
    if(!report.filesVerified)throw fail('voice_environment_required');
    signal?.throwIfAborted();
    if(language==='auto')language=voice==='af_maple'?'en':'zh';
    const text=language==='zh'?'你好，这是音色试听。':'Hello, this is a voice preview.';
    const synthesis=make.synthesis({python:installation.python,assets:installation.assetsDirectory,timeoutMs:25000});
    const parts=[];let size=0;
    try{
      for await(const pcm of synthesis.synthesize(text,{language,voice,speechRate,signal})){
        signal?.throwIfAborted();
        size+=pcm.length;
        if(size>24000*2*8)throw fail('voice_preview_failed');
        parts.push(pcm);
      }
    }finally{await synthesis.dispose();}
    signal?.throwIfAborted();
    return {language,wav:pcmToWav(Buffer.concat(parts,size),24000).toString('base64')};
  }
  return {inspect,verify,preview};
}
