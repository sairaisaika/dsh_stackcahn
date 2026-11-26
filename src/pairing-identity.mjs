import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/agent_pairing_identity.py', import.meta.url));
const fault = code => Object.assign(new Error(code), { code });
const errors = new Set(['reconcile_required', 'active_identity_required', 'host_busy',
  'private_storage_required', 'private_storage_invalid', 'invalid_request']);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

/** Internal only. Return credentials over a private inherited pipe, never log them.
 * Caller must close listener before releasing this lease. */
export function acquirePairingIdentity({ directory, python = 'python3', signal }) {
  if (!directory || !isAbsolute(directory)) return Promise.reject(fault('host_unconfigured'));
  if (signal?.aborted) return Promise.reject(fault('identity_cancelled'));
  const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','SYSTEMROOT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const child = spawn(python, [helper, '--root', directory], {
    detached: true, env: { ...env, PYTHONNOUSERSITE: '1' }, stdio: ['pipe','pipe','ignore'],
  });
  let buffer = Buffer.alloc(0), ready = false, ended = false, stopping = false, failure, escalation;
  let resolveReady, rejectReady, resolveClosed;
  const response = new Promise((yes,no)=>{resolveReady=yes;rejectReady=no;});
  const closed = new Promise(resolve=>{resolveClosed=resolve;});
  const kill = () => {
    try { process.kill(-child.pid,'SIGTERM'); } catch {}
    escalation ??= setTimeout(()=>{try { process.kill(-child.pid,'SIGKILL'); } catch {}},500);
  };
  const fail = code => { failure ??= code; kill(); };
  const cancel = () => fail('identity_cancelled');
  const timer = setTimeout(()=>fail('identity_unavailable'),15000);
  signal?.addEventListener('abort',cancel,{once:true});
  child.stdin.on('error',()=>fail('identity_unavailable'));
  child.on('error',()=>fail('identity_unavailable'));
  child.on('close',code=>{
    ended=true;
    clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',cancel);
    buffer.fill(0);buffer=Buffer.alloc(0);
    if(!ready)rejectReady(fault(failure??'identity_unavailable'));
    resolveClosed({ expected: stopping && !failure && code===0 });
  });
  child.stdout.on('data',chunk=>{
    if(ready || buffer.length+chunk.length>49152){fail('identity_protocol_invalid');return;}
    buffer=Buffer.concat([buffer,chunk]);
    const end=buffer.indexOf(10);if(end<0)return;
    try {
      if(end!==buffer.length-1)throw new Error();
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,end)));
      if(exact(value,['ok','error'])&&value.ok===false&&errors.has(value.error)){fail(value.error);return;}
      if(!exact(value,['ok','deviceId','pairing'])||value.ok!==true||
          !/^[0-9a-f]{12}$/.test(value.deviceId)||value.pairing?.version!==1||
          !/^[0-9a-f]{32}$/.test(value.pairing.record?.pair_id)||
          !/^[0-9a-f]{64}$/.test(value.pairing.record?.local_token)||
          typeof value.pairing.host?.key!=='string'||typeof value.pairing.host?.cert!=='string')throw new Error();
      if(failure||signal?.aborted){fail('identity_cancelled');return;}
      ready=true;clearTimeout(timer);buffer.fill(0);buffer=Buffer.alloc(0);
      resolveReady({ deviceId:value.deviceId,pairing:value.pairing,closed,
        async release(){
          if(!stopping&&!ended){stopping=true;child.stdin.end();escalation=setTimeout(()=>{escalation=null;kill();},500);}
          const result=await closed;
          if(!result.expected)throw fault('identity_release_unconfirmed');
        },
      });
    }catch{fail('identity_protocol_invalid');}
  });
  if(signal?.aborted)cancel();
  return response;
}
