import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraReception} from '../src/agent-camera.mjs';
import {CAMERA,decodeControl} from '../src/agent-protocol.mjs';
const identity={boot_id:'b'.repeat(32),epoch:'1',request_id:'c'.repeat(32)};
const parsed=value=>decodeControl(Buffer.from(JSON.stringify({...value,...identity})));
function receiver(size=1025){const r=new CameraReception();r.receive(parsed({type:'camera_meta',bytes:String(size),width:'640',height:'480'}));return r;}
test('camera schema enforces bounded metadata, canonical decimal, strict keys and chunk envelope',()=>{
 for(const bytes of ['0','3','262145','01','1e3']){
  const read=()=>new CameraReception().receive(parsed({type:'camera_meta',bytes,width:'640',height:'480'}));assert.throws(read);
 }
 for(const patch of [{width:'641'},{height:'481'},{width:'0'},{extra:true}])assert.throws(()=>parsed({type:'camera_meta',bytes:'4',width:'640',height:'480',...patch}));
 assert.throws(()=>parsed({type:'camera_chunk',offset:'0',data:'A'.repeat(1372)}));
 assert.throws(()=>parsed({type:'camera_chunk',offset:'0',data:'AA A'}));
});
test('camera result requires all exact chunks and final receipt; no incomplete or repeated result',()=>{
 const r=receiver(1025),a=Buffer.alloc(1024,42);a[0]=255;a[1]=216;a[1023]=255;
 assert.deepEqual(r.receive(parsed({type:'camera_chunk',offset:'0',data:a.toString('base64')})),{next:1024});
 assert.throws(()=>r.receive(parsed({type:'camera_complete'})));
 assert.throws(()=>r.receive(parsed({type:'camera_chunk',offset:'0',data:a.toString('base64')})));
 assert.deepEqual(r.receive(parsed({type:'camera_chunk',offset:'1024',data:Buffer.from([217]).toString('base64')})),{next:1025});
 const {result}=r.receive(parsed({type:'camera_complete'}));assert.equal(result.jpeg.length,1025);assert.equal(r.bytes,null);
 assert.throws(()=>r.receive(parsed({type:'camera_complete'})));
});
test('camera rejects wrong order, duplicate metadata, noncanonical base64, truncation and oversized chunks',()=>{
 assert.throws(()=>new CameraReception().receive(parsed({type:'camera_chunk',offset:'0',data:'AAAA'})));
 assert.throws(()=>receiver().receive(parsed({type:'camera_meta',bytes:'4',width:'1',height:'1'})));
 for(const [offset,data] of [['1',Buffer.alloc(1024).toString('base64')],['0','AAAA'],['0',Buffer.alloc(1025).toString('base64')]]){
  assert.throws(()=>receiver().receive(parsed({type:'camera_chunk',offset,data})));
 }
 const r=receiver(4);assert.throws(()=>r.receive(parsed({type:'camera_chunk',offset:'0',data:'/9j/2R=='}))); // nonzero padding bits
 r.clear();assert.equal(r.bytes,null);assert.throws(()=>r.receive(parsed({type:'camera_complete'})));
 assert.equal(CAMERA.chunkBytes,1024);
});
