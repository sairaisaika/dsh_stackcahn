import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localAddress } from './pairing.mjs';

export class DeviceModeClient {
  constructor({address,pairing,request,timeoutMs=25000,pollMs=200,heartbeatMs=4000}) {
    const url=localAddress(address,'https:');
    if(url.pathname!=='/') throw new Error('Device address must not contain a path');
    if(pairing?.version!==1 || !/^[0-9a-f]{32}$/.test(pairing.record?.pair_id??'')) throw new Error('Invalid pairing');
    this.record=pairing.record;this.url=url;this.timeoutMs=timeoutMs;this.pollMs=pollMs;this.heartbeatMs=heartbeatMs;
    this.request=request??this.httpsRequest.bind(this);this.lease=null;this.busy=false;
    this.agent=new https.Agent({keepAlive:true,maxSockets:1});
  }
  httpsRequest(method,body) {
    return new Promise((resolve,reject)=>{
      const encoded=body?JSON.stringify(body):undefined;
      const req=https.request(new URL('/v1/backend',this.url),{method,agent:this.agent,
        ca:this.record.ca,servername:'sion-device',rejectUnauthorized:true,
        headers:{Authorization:`Bearer ${this.record.control_key}`,...(encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{})}},res=>{
        let text='';res.on('data',chunk=>{text+=chunk;if(text.length>32768)req.destroy(new Error('Oversized device response'));});
        res.on('error',reject);res.on('end',()=>{try {
          if(res.statusCode<200||res.statusCode>=300)throw new Error(`Device HTTP ${res.statusCode}`);
          resolve(JSON.parse(text));
        }catch(error){reject(error);}});
      });
      const timer=setTimeout(()=>req.destroy(new Error('Device request timed out')),5000);
      req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(encoded);
    });
  }
  async status() {
    const s=await this.request('GET');
    if(s.protocol_version!==2||s.pair_id!==this.record.pair_id||!s.enabled||
       !/^[0-9a-f]{32}$/.test(s.boot_id??'')||!/^\d+$/.test(s.epoch??''))throw new Error('Incompatible or different device pairing');
    return s;
  }
  async command(action,snapshot) {
    const body={action,boot_id:snapshot.boot_id,epoch:snapshot.epoch,request_id:randomBytes(16).toString('hex')};
    // A lost POST response does not justify submitting a new logical command.
    try {await this.request('POST',body);}catch { /* resolve from device receipts */ }
    const until=Date.now()+this.timeoutMs;
    while(Date.now()<until) {
      const s=await this.status();
      if(s.boot_id!==body.boot_id)throw new Error('Device restarted during command');
      const receipt=s.receipts?.find(r=>r.request_id===body.request_id);
      if(receipt?.result==='rejected')throw Object.assign(new Error('Device rejected mode command'),{code:'command-rejected'});
      if(receipt?.result==='applied')return s;
      await delay(this.pollMs);
    }
    throw new Error('Mode command outcome unconfirmed');
  }
  async acquire({signal,onDisconnect=()=>{}}={}) {
    if(this.busy||this.lease)throw new Error('This client already has a mode operation');
    this.busy=true;
    try {
      signal?.throwIfAborted();const before=await this.status();
      if(before.phase!=='original'||before.restart_required)throw new Error('Device is not available in original mode');
      const identity={boot_id:before.boot_id,epoch:(BigInt(before.epoch)+1n).toString()};
      // Keep expected identity before POST, so even a lost receipt can be released.
      this.lease={...identity,active:false,timer:null};
      await this.command('enter',before);
      const until=Date.now()+this.timeoutMs;
      while(Date.now()<until) {
        signal?.throwIfAborted();const s=await this.status();this.assertOwner(s,identity);
        if(s.phase==='local') {
          this.lease.active=true;
          const renew=async()=>{
            if(!this.lease?.active)return;
            try {const current=await this.status();this.assertOwner(current,identity);await this.command('renew',current);}
            catch(error){if(this.lease?.active){this.lease.active=false;onDisconnect(error);}return;}
            if(this.lease?.active){this.lease.timer=setTimeout(renew,this.heartbeatMs);this.lease.timer.unref?.();}
          };
          this.lease.timer=setTimeout(renew,this.heartbeatMs);this.lease.timer.unref?.();
          return {identity,release:()=>this.release()};
        }
        await delay(this.pollMs);
      }
      throw new Error('Local backend did not become ready');
    } catch(error) {
      if(error.code==='command-rejected' && !this.lease?.active)this.lease=null;
      // Cleanup is independent of an aborted acquisition signal.
      if(this.lease)try{await this.release();}catch{/* keep lease for explicit recovery */}
      throw error;
    } finally {this.busy=false;}
  }
  assertOwner(s,identity) {
    if(s.boot_id!==identity.boot_id||s.epoch!==identity.epoch||s.selected!=='local')throw new Error('Voice lease lost');
  }
  async release() {
    const lease=this.lease;
    if(!lease)return {originalReady:false,reason:'no-owned-lease'};
    lease.active=false;clearTimeout(lease.timer);
    let s=await this.status();
    if(s.boot_id!==lease.boot_id)throw new Error('Device restarted; recovery must be checked separately');
    if(s.epoch===lease.epoch&&s.selected==='local')s=await this.command('leave',s);
    const until=Date.now()+this.timeoutMs;
    while(Date.now()<until) {
      s=await this.status();
      if(s.boot_id!==lease.boot_id)throw new Error('Device restarted during recovery');
      const epoch=BigInt(s.epoch),owned=BigInt(lease.epoch);
      if(epoch>owned+2n||epoch<owned||s.selected==='local')throw new Error('Recovery ownership changed');
      if(s.phase==='original'&&s.original_ready===true) {
        this.lease=null;return {originalReady:true,bootId:s.boot_id,epoch:s.epoch};
      }
      if(s.phase==='fault')throw new Error('Original backend recovery failed; physical return can retry');
      await delay(this.pollMs);
    }
    throw new Error('Original assistant recovery unconfirmed');
  }
  close() {clearTimeout(this.lease?.timer);if(this.lease)this.lease.active=false;this.agent.destroy();}
}
