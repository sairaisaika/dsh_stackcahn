import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import {registerCapabilityTools} from '../src/capability-tools.mjs';

test('native tool registry validates canonical results, retains policy, redacts failures and unregisters with owner',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){return()=>{};}});
 await ctx.plugin(Tools);await ctx.plugin(Native);t.after(()=>ctx.fiber.dispose());
 let calls=0,mode='ok';
 const plugin=ctx.plugin({name:'expression-fixture',inject:['tools'],apply(child){registerCapabilityTools(child,{async expression(agent,expression,signal){
  ++calls;signal.throwIfAborted();
  if(mode==='failure')throw Object.assign(Error('/private/secret'),{code:'capability_session_mismatch'});
  return {version:1,expression,status:'unavailable'};
 }});}});
 await plugin;
 assert.ok(ctx.tools.get('stackchan_set_expression'));
 let id=0;const run=async args=>(await ctx.tools.execute({calls:[{type:'tool-call',id:'expression-'+(++id),name:'stackchan_set_expression',arguments:JSON.stringify(args)}],signal:new AbortController().signal})).results[0].result;
 const result=await run({expression:'happy'});assert.equal(result.isError,false);assert.deepEqual(result.value,{version:1,expression:'happy',status:'unavailable'});
 assert.equal((await run({expression:'invented'})).isError,true);
 assert.equal((await run({expression:'happy',sessionId:'different'})).isError,true);assert.equal(calls,1);
 mode='failure';const failed=await run({expression:'sad'});assert.equal(failed.isError,true);assert.doesNotMatch(JSON.stringify(failed),/private\/secret/);assert.match(JSON.stringify(failed),/capability_session_mismatch/);
 const before=calls;const unguard=ctx.tools.guard(()=> 'Device use disabled by test policy');assert.equal((await run({expression:'happy'})).isError,true);assert.equal(calls,before);unguard();
 await plugin.dispose();assert.equal(ctx.tools.get('stackchan_set_expression'),undefined);
});

test('actual StackChan plugin registers when tools arrive and withdraws on plugin disable',async t=>{
 const Plugin=await import('../src/plugin.mjs');
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());
 const loaded=ctx.plugin(Plugin,{});await loaded;
 assert.equal(ctx.stackchanVoice.snapshot().phase,'stopped');
 ctx.provide('systemPrompt',{tools(){return()=>{};}});await ctx.plugin(Tools);await ctx.plugin(Native);
 for(let i=0;i<20&&!ctx.tools.get('stackchan_set_expression');i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.ok(ctx.tools.get('stackchan_set_expression'));
 const result=(await ctx.tools.execute({calls:[{type:'tool-call',id:'inactive',name:'stackchan_set_expression',arguments:'{"expression":"neutral"}'}],signal:new AbortController().signal})).results[0].result;
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/capability_inactive/);
 await loaded.dispose();assert.equal(ctx.tools.get('stackchan_set_expression'),undefined);
});

test('native ring tool validates RGB and duration and preserves the native permission pipe', async t => {
  const ctx=new Context();
  t.after(()=>ctx.fiber.dispose());
  ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Tools);
  await ctx.plugin(Native);
  const calls=[];
  const plugin=ctx.plugin({name:'ring-fixture',inject:['tools'],apply(child){
    registerCapabilityTools(child,{
      async setRing(agent,args,signal){
        signal.throwIfAborted();
        calls.push(args);
        return {version:1,status:'completed'};
      },
    });
  }});
  await plugin;
  const execute=async args=>(await ctx.tools.execute({
    calls:[{type:'tool-call',id:'ring-test',name:'stackchan_light_ring',arguments:JSON.stringify(args)}],
    signal:new AbortController().signal,
  })).results[0].result;
  const accepted=await execute({color:'#FF2300',durationMs:250});
  assert.equal(accepted.isError,false);
  assert.deepEqual(accepted.value,{version:1,status:'completed'});
  assert.equal((await execute({color:'#FF2300',durationMs:10001})).isError,true);
  assert.equal((await execute({color:'red'})).isError,true);
  assert.equal((await execute({color:'#FF2300',sessionId:'other'})).isError,true);
  const unguard=ctx.tools.guard(()=> 'Device tools disabled by test policy');
  assert.equal((await execute({color:'#FF2300'})).isError,true);
  unguard();
  assert.equal(calls.length,1);
  await plugin.dispose();
  assert.equal(ctx.tools.get('stackchan_light_ring'),undefined);
});

test('native device status exposes a bounded structured report through the normal tool policy',async t=>{
  const ctx=new Context();
  t.after(()=>ctx.fiber.dispose());
  ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Tools);
  await ctx.plugin(Native);
  const {describeDeviceCapabilities}=await import('../src/device-capabilities.mjs');
  let calls=0;
  const registration=ctx.plugin({name:'status-fixture',inject:['tools'],apply(child){
    registerCapabilityTools(child,{deviceStatus(){calls++;return describeDeviceCapabilities(null,{phase:'stopped'});}});
  }});
  await registration;
  const execute=async args=>(await ctx.tools.execute({
    calls:[{type:'tool-call',id:'device-status',name:'stackchan_device_status',arguments:JSON.stringify(args)}],
    signal:new AbortController().signal,
  })).results[0].result;
  const result=await execute({});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.value.version,1);
  assert.deepEqual(result.value.conversation,{replyMode:'inactive',captionChannel:'unknown'});
  assert.deepEqual(result.value.features.camera,{availability:'unknown',permission:'unknown',condition:'not-available'});
  assert.ok(result.value.notExposed.includes('nfc'));
  assert.equal((await execute({sessionId:'override'})).isError,true);
  const unguard=ctx.tools.guard(()=> 'Device tools denied');
  assert.equal((await execute({})).isError,true);
  unguard();
  assert.equal(calls,1);
  await registration.dispose();
  assert.equal(ctx.tools.get('stackchan_device_status'),undefined);
});

test('servo tools pass keyframes, torque and reads through, and reject anything else', async t => {
  const ctx=new Context();
  t.after(()=>ctx.fiber.dispose());
  ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Tools);
  await ctx.plugin(Native);
  const calls=[];
  const axis={angle:0,position:460,speed:0,load:-12,voltage:74,temperature:33,current:3,moving:false,torque:true,inRange:true};
  const plugin=ctx.plugin({name:'servo-fixture',inject:['tools'],apply(child){
    registerCapabilityTools(child,{
      async moveFrames(_agent,request){calls.push(['move',request]);return {version:1,status:'reached',holding:request.holdMs>0,observed:{yaw:0,pitch:300}};},
      async setTorque(_agent,request){calls.push(['torque',request]);return {version:1,status:'reached',holding:request.torque!=='release'};},
      async rotateYaw(_agent,request){
        calls.push(['rotate',request]);
        if(request.velocity===999)throw Object.assign(new Error('stall'),{code:'motion-stall',observed:{yaw:-120,pitch:610}});
        return {version:1,status:'reached',holding:false};},
      async recordSensors(_agent,request){calls.push(['record',request]);
        return {version:1,durationMs:request.durationMs,intervalMs:{imu:20},truncated:false,samples:[{t:0,sensor:'imu',value:{raw:[1,2,3,4,5,6]}}]};},
      async readServos(){calls.push(['read']);return {version:1,status:'read',holding:false,yaw:axis,pitch:{...axis,position:700}};},
    });
  }});
  await plugin;
  const execute=async(name,args)=>(await ctx.tools.execute({
    calls:[{type:'tool-call',id:name,name,arguments:JSON.stringify(args)}],signal:new AbortController().signal,
  })).results[0].result;
  const moved=await execute('stackchan_servo_move',{frames:[{yaw:200,pitch:450,durationMs:300},{yaw:0,pitch:300}],holdMs:5000,torque:'limp'});
  assert.equal(moved.isError,false);
  assert.deepEqual(calls[0],['move',{frames:[{yaw:200,pitch:450,durationMs:300},{yaw:0,pitch:300}],holdMs:5000,torque:'limp'}]);
  assert.equal((await execute('stackchan_servo_move',{frames:[{yaw:0,pitch:300}]})).value.holding,false);
  assert.deepEqual(calls[1][1],{frames:[{yaw:0,pitch:300}],holdMs:0,torque:'hold'});
  assert.equal((await execute('stackchan_servo_move',{frames:[{yaw:0,pitch:300,speed:9}]})).isError,true);
  assert.equal((await execute('stackchan_servo_move',{frames:[{yaw:0,pitch:300}],sessionId:'x'})).isError,true);
  assert.equal((await execute('stackchan_servo_torque',{torque:'limp',holdMs:10000})).isError,false);
  assert.equal((await execute('stackchan_servo_torque',{torque:'loose'})).isError,true);
  const read=await execute('stackchan_servo_read',{});
  assert.equal(read.isError,false);assert.equal(read.value.pitch.position,700);
  assert.equal((await execute('stackchan_servo_read',{yaw:1})).isError,true);
  assert.equal((await execute('stackchan_servo_rotate',{velocity:-400,durationMs:1500})).isError,false);
  assert.deepEqual(calls.at(-1),['rotate',{velocity:-400,durationMs:1500,holdMs:0,torque:'hold'}]);
  assert.equal((await execute('stackchan_servo_rotate',{velocity:-400})).isError,true);
  const stalled=await execute('stackchan_servo_rotate',{velocity:999,durationMs:500});
  assert.equal(stalled.isError,true);
  assert.match(JSON.stringify(stalled),/met resistance.*stopped at yaw -120, pitch 610/);
  const record=await execute('stackchan_sensor_record',{sensors:['imu'],intervalMs:20,durationMs:1000});
  assert.equal(record.isError,false);assert.equal(record.value.samples[0].value.raw[5],6);
  assert.equal((await execute('stackchan_sensor_record',{sensors:['camera'],intervalMs:20,durationMs:1000})).isError,true);
  assert.deepEqual(calls.map(c=>c[0]),['move','move','torque','read','rotate','rotate','record']);
  await plugin.dispose();
  for(const name of ['stackchan_servo_move','stackchan_servo_torque','stackchan_servo_read','stackchan_servo_rotate','stackchan_sensor_record'])assert.equal(ctx.tools.get(name),undefined);
});

test('the photo burst takes the requested number of captures in order', async t => {
  const ctx=new Context();
  t.after(()=>ctx.fiber.dispose());
  ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Tools);
  await ctx.plugin(Native);
  let shots=0;
  const plugin=ctx.plugin({name:'burst-fixture',inject:['tools'],apply(child){
    registerCapabilityTools(child,{async photograph(){shots++;return {version:1,attachment:{attachmentId:`a${shots}`,mediaType:'image/jpeg',bytes:10,width:640,height:480}};}});
  }});
  await plugin;
  const execute=async args=>(await ctx.tools.execute({calls:[{type:'tool-call',id:'burst',name:'stackchan_take_photos',arguments:JSON.stringify(args)}],
    signal:new AbortController().signal})).results[0].result;
  const result=await execute({count:3,intervalMs:300});
  assert.equal(result.isError,false);
  assert.deepEqual(result.value.photos.map(p=>p.attachment.attachmentId),['a1','a2','a3']);
  assert.ok(result.value.photos[2].atMs>=550);
  assert.equal((await execute({count:6})).isError,true);
  assert.equal(shots,3);
});
