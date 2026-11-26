import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';

export function localAddress(value, protocol) {
  const url = new URL(value);
  const parts = url.hostname.split('.');
  if (url.protocol !== protocol || parts.length !== 4 ||
      parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) ||
      url.username || url.password || url.hash || url.search) throw new Error('Expected a private IPv4 URL without credentials/query');
  const [a,b] = parts.map(Number);
  if (!(a===10 || a===192&&b===168 || a===172&&b>=16&&b<=31)) throw new Error('Expected an RFC1918 address');
  return url;
}
export function createPairing(directory, localUrl) {
  if(localUrl!=='')localUrl=localAddress(localUrl, 'wss:').href;
  const destination=resolve(directory);
  // Exclusive directory: never rotate an existing pairing accidentally.
  mkdirSync(destination,{mode:0o700});
  const ssl=(...args)=>execFileSync('openssl',args,{cwd:destination,stdio:['ignore','ignore','pipe']});
  const key=name=>{ssl('genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-pkeyopt','ec_param_enc:named_curve','-out',`${name}.key`);chmodSync(join(destination,`${name}.key`),0o600);};
  try {
    key('ca');
    ssl('req','-sha256','-new','-x509','-key','ca.key','-out','ca.pem','-days','3650','-subj','/CN=Sion private pairing CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign');
    for (const role of ['device','host']) {
      key(role);
      ssl('req','-new','-key',`${role}.key`,'-out',`${role}.csr`,'-subj',`/CN=sion-${role}`);
      writeFileSync(join(destination,`${role}.ext`),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:sion-${role}\n`,{mode:0o600});
      ssl('x509','-sha256','-req','-in',`${role}.csr`,'-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',`${role}.pem`,'-days','3650','-extfile',`${role}.ext`);
    }
    const read=name=>readFileSync(join(destination,name),'utf8');
    const record={version:1,role:'sion-device',pair_id:randomBytes(16).toString('hex'),
      control_key:randomBytes(32).toString('hex'),local_url:localUrl,local_token:randomBytes(32).toString('hex'),
      ca:read('ca.pem'),cert:read('device.pem'),key:read('device.key')};
    if(Buffer.byteLength(JSON.stringify(record))>4096) throw new Error('Pairing record exceeds device storage limit');
    const bundle={version:1,record,host:{cert:read('host.pem'),key:read('host.key')},
      deviceFingerprint:new X509Certificate(record.cert).fingerprint256};
    writeFileSync(join(destination,'pairing.json'),JSON.stringify(bundle,null,2)+'\n',{mode:0o600,flag:'wx'});
    // No ongoing CA signing capability is needed after issuing this pair.
    for(const name of ['ca.key','ca.srl','device.csr','host.csr','device.ext','host.ext','device.key','host.key']) rmSync(join(destination,name),{force:true});
    return {directory:destination,pairId:record.pair_id,deviceFingerprint:bundle.deviceFingerprint};
  } catch(error) {
    // Preserve evidence but do not dump OpenSSL inputs/keys to the terminal.
    throw new Error(`Pairing preparation failed in ${destination}; inspect private files before retrying`,{cause:error});
  }
}
