import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import {once} from 'node:events';
import {createPairing,localAddress} from '../src/pairing.mjs';
import {DeviceModeClient} from '../src/device-mode.mjs';
import {createAgentTransport} from '../src/agent-transport.mjs';

test('pairing files are private; TLS authenticates device and rejects host impersonation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sion-pair-test-'));
  try {
    const dir=join(root,'pair');const output=createPairing(dir,'wss://192.168.1.4:8766/audio');
    assert.equal(statSync(join(dir,'pairing.json')).mode&0o777,0o600);
    assert.equal(statSync(dir).mode&0o777,0o700);
    assert.equal('control_key' in output,false);
    const bundle=JSON.parse(readFileSync(join(dir,'pairing.json')));
    assert.notEqual(bundle.record.control_key,bundle.record.local_token);
    assert.throws(()=>createPairing(dir,bundle.record.local_url));
    for(const validDevice of [true,false]) {
      let requests=0;
      const server=https.createServer(validDevice?{cert:bundle.record.cert,key:bundle.record.key}:bundle.host,(req,res)=>{
        requests++;assert.equal(req.headers.authorization,`Bearer ${bundle.record.control_key}`);res.end('{"ok":true}');
      });
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const client=new DeviceModeClient({address:'https://192.168.1.20:8765',pairing:bundle});
      // Test transport uses an ephemeral loopback listener; public constructor rejects it.
      client.url=new URL(`https://127.0.0.1:${server.address().port}`);
      try {
        if(validDevice)assert.deepEqual(await client.httpsRequest('GET'),{ok:true});
        else {await assert.rejects(client.httpsRequest('GET'));assert.equal(requests,0);}
      }finally{client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('pairing endpoints exclude insecure, public and credential-bearing URLs',()=>{
  for(const url of ['ws://192.168.1.2/x','wss://8.8.8.8/x','wss://127.0.0.1/x','wss://u:p@192.168.1.2/x','wss://192.168.1.2/x?t=s'])assert.throws(()=>localAddress(url,'wss:'));
});
test('a no-LAN pairing retains transport credentials but cannot open a LAN listener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sion-no-lan-test-'));
  try {
    const directory = join(root, 'pair');
    createPairing(directory, '');
    const pairing = JSON.parse(readFileSync(join(directory, 'pairing.json')));
    assert.equal(pairing.record.local_url, '');
    const transport = createAgentTransport({ pairing, deviceId: '0123456789ab' });
    try {
      await assert.rejects(transport.listen({ host: '127.0.0.1', port: 0 }), { code: 'lan-address-required' });
    } finally {
      await transport.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
