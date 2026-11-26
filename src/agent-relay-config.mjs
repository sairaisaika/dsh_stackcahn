import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { relayOrigin } from './agent-relay.mjs';

export const relayConfigName = '.stackchan-relay.json';
const maxBytes = 16384;
const invalid = () => Object.assign(new Error('voice_relay_config_invalid'),{code:'voice_relay_config_invalid'});

/** Local Host-only descriptor. The endpoint and material never travel via Remote. */
export async function readRelayConfiguration(profileDirectory) {
  if (typeof profileDirectory!=='string'||!isAbsolute(profileDirectory)) throw invalid();
  let file;
  try {
    file=await open(join(profileDirectory,relayConfigName),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  } catch(error) {
    if(error?.code==='ENOENT')throw Object.assign(new Error('voice_relay_config_missing'),{code:'voice_relay_config_missing'});
    throw invalid();
  }
  try {
    const info=await file.stat();
    if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)!==0||info.size<1||info.size>maxBytes)throw invalid();
    const bytes=Buffer.alloc(maxBytes+1);
    let offset=0;
    try {
      while(offset<bytes.length) {
        const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);
        if(!bytesRead)break;
        offset+=bytesRead;
      }
      if(offset!==info.size)throw invalid();
      const {version,endpoint,roomId,pairId,token,ca,...extra}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,offset)));
      if(version!==1||Object.keys(extra).length!==0||
          ![roomId,pairId,token].every(value=>typeof value==='string')||
          !/^[0-9a-f]{32}$/.test(roomId)||!/^[0-9a-f]{32}$/.test(pairId)||!/^[0-9a-f]{64}$/.test(token)||
          typeof endpoint!=='string'||endpoint.length>512||
          (ca!==undefined&&(typeof ca!=='string'||!ca.includes('-----BEGIN CERTIFICATE-----'))))throw invalid();
      if(ca!==undefined)createSecureContext({ca});
      return {endpoint:relayOrigin(endpoint).href,roomId,pairId,token,...(ca===undefined?{}:{ca})};
    } finally { bytes.fill(0); }
  } catch { throw invalid(); }
  finally { await file.close(); }
}
