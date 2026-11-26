import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceModeClient} from '../src/device-mode.mjs';
const pairing={version:1,record:{pair_id:'a'.repeat(32)}};
function fixture() {
  const state={enabled:true,protocol_version:2,pair_id:pairing.record.pair_id,boot_id:'b'.repeat(32),
    epoch:'0',phase:'original',selected:'original',original_ready:false,receipts:[]};
  const actions=[];
  const request=async(method,body)=>{
    if(method==='POST') {
      actions.push(body.action);
      const valid=body.epoch===state.epoch;
      state.receipts.push({request_id:body.request_id,result:valid?'applied':'rejected'});
      if(valid&&body.action==='enter'){state.epoch='1';state.phase='local';state.selected='local';}
      if(valid&&body.action==='leave'){state.epoch='2';state.phase='original';state.selected='original';state.original_ready=true;}
      return {accepted:true};
    }
    return structuredClone(state);
  };
  const client=new DeviceModeClient({address:'https://192.168.1.20:8765',pairing,request,pollMs:1,timeoutMs:30,heartbeatMs:10000});
  return {state,actions,client,request};
}
test('mode client owns an epoch, enters once, and waits for original readiness',async()=>{
  const {client,actions}=fixture();try {
    const lease=await client.acquire();assert.equal(lease.identity.epoch,'1');
    await assert.rejects(client.acquire(),/already/);
    assert.equal((await lease.release()).originalReady,true);assert.deepEqual(actions,['enter','leave']);
  }finally{client.close();}
});
test('lost POST acknowledgement resolves receipt without duplicate enter',async()=>{
  const {client,request,actions}=fixture();client.request=async(...args)=>{const result=await request(...args);if(args[0]==='POST')throw Error('lost response');return result;};
  try{await client.acquire();await client.release();assert.deepEqual(actions,['enter','leave']);}finally{client.close();}
});
test('existing local lease is never adopted or released',async()=>{
  const {client,state,actions}=fixture();state.phase='local';state.selected='local';
  try{await assert.rejects(client.acquire(),/not available/);assert.deepEqual(actions,[]);}finally{client.close();}
});
test('reboot and different pairing cannot provide a successful recovery receipt',async()=>{
  const {client,state}=fixture();try{await client.acquire();state.boot_id='c'.repeat(32);
    await assert.rejects(client.release(),/restarted/);assert.ok(client.lease);
    state.pair_id='d'.repeat(32);await assert.rejects(client.status(),/different device/);
  }finally{client.close();}
});
test('abort after accepted enter still returns ownership before rejecting',async()=>{
  const {client,request,actions}=fixture();const abort=new AbortController();
  client.request=async(...args)=>{const result=await request(...args);if(args[1]?.action==='enter')abort.abort();return result;};
  try{await assert.rejects(client.acquire({signal:abort.signal}));assert.deepEqual(actions,['enter','leave']);assert.equal(client.lease,null);}finally{client.close();}
});
test('failed original handshake is reported as failure, not selected-mode success',async()=>{
  const {client,state,request}=fixture();client.request=async(...args)=>{
    const result=await request(...args);if(args[1]?.action==='leave'){state.phase='fault';state.original_ready=false;}return result;
  };
  try{await client.acquire();await assert.rejects(client.release(),/recovery failed/);assert.ok(client.lease);}finally{client.close();}
});
test('explicitly rejected enter does not strand a fictitious owned lease',async()=>{
  const {client,state}=fixture();client.request=async(method,body)=>{
    if(method==='POST')state.receipts.push({request_id:body.request_id,result:'rejected'});
    return structuredClone(state);
  };
  try{await assert.rejects(client.acquire(),/rejected/);assert.equal(client.lease,null);}finally{client.close();}
});
