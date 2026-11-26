import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Context} from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {projectImagesForTextModel} from '@deepseek-ai/dsh-llm';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import {saveCameraAttachment} from '../src/camera-attachment.mjs';
import {registerCapabilityTools} from '../src/capability-tools.mjs';

const jpeg=async(width=64,height=48)=>({mediaType:'image/jpeg',width,height,
  jpeg:await sharp({create:{width,height,channels:3,background:{r:12,g:140,b:240}}}).jpeg().toBuffer()});
async function storeFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'sion-camera-attachments-'));
  const ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});});
  await ctx.plugin(LocalAttachmentStore,{dshHome:directory});
  return {ctx,directory,store:ctx.attachments};
}
test('real DSH store decodes, persists and derives model request image; text-only projection is explicit',async t=>{
  const {store}=await storeFixture(t),picture=await jpeg();
  const ref=await saveCameraAttachment(picture,store,()=>{});
  assert.match(ref.attachmentId,/^sha256:[a-f0-9]{64}$/);
  assert.equal(ref.width,64);assert.equal(ref.height,48);
  const stored=await store.readImage(ref);
  assert.equal(stored.data.byteLength,ref.bytes);
  assert.equal((await sharp(stored.data).raw().toBuffer()).length,64*48*3);
  const request=await store.readImageRequest(ref,{width:32,height:24,maxBytes:65536});
  assert.equal(request.width,32);assert.equal(request.height,24);
  assert.equal((await sharp(request.data).metadata()).width,32);
  const messages=[{role:'user',content:[{type:'image',attachment:ref}]}];
  const projected=projectImagesForTextModel(messages);
  assert.equal(projected[0].content[0].type,'text');
  assert.match(projected[0].content[0].text,/image omitted because this model accepts text only/);
  assert.equal(messages[0].content[0].type,'image');
});
test('corrupt JPEG bodies, dimension lies, non-JPEG and over-budget rasters never enter storage',async t=>{
  const {store,directory}=await storeFixture(t),good=await jpeg();
  let saves=0;const original=store.saveImage.bind(store);store.saveImage=async x=>{saves++;return original(x);};
  const truncated=Buffer.concat([good.jpeg.subarray(0,good.jpeg.length-25),Buffer.from([255,217])]);
  const cases=[{...good,jpeg:Buffer.from([255,216,0,0,255,217])},
    {...good,jpeg:truncated},{...good,width:63},await jpeg(641,10),
    {...good,jpeg:await sharp(good.jpeg).png().toBuffer()},
    {...good,jpeg:Buffer.alloc(256*1024+1)},
    {...good,jpeg:await sharp(good.jpeg).withMetadata({orientation:6}).jpeg().toBuffer()}];
  for(const picture of cases)await assert.rejects(saveCameraAttachment(picture,store,()=>{}),{code:'camera_image_invalid'});
  assert.equal(saves,0);assert.deepEqual(await readdir(directory),[]);
});
test('cancel during a native save withholds reference without deleting shared immutable data',async t=>{
  const {store}=await storeFixture(t),picture=await jpeg();
  const abort=new AbortController();let retained;
  const pending=saveCameraAttachment(picture,{async saveImage(input){retained=await store.saveImage(input);abort.abort();return retained;}},()=>abort.signal.throwIfAborted());
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal((await store.readImage(retained)).ref.attachmentId,retained.attachmentId);
});
test('native photo tool emits real image blocks, preserves guard decisions, rejects input and unregisters',async t=>{
  const {ctx,store}=await storeFixture(t),picture=await jpeg();
  ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Tools);await ctx.plugin(Native);
  let calls=0;
  const plugin=ctx.plugin({name:'camera-fixture',inject:['tools'],apply(child){registerCapabilityTools(child,{
    async photograph(_agent,signal){calls++;return {version:1,attachment:await saveCameraAttachment(picture,store,()=>signal.throwIfAborted())};},
  });}});await plugin;
  let id=0;
  const run=async args=>(await ctx.tools.execute({calls:[{type:'tool-call',id:'photo-'+(++id),name:'stackchan_take_photo',arguments:JSON.stringify(args)}],signal:new AbortController().signal})).results[0].result;
  const result=await run({});assert.equal(result.isError,false);
  assert.deepEqual(result.content,[{type:'image',attachment:result.value.attachment}]);
  assert.equal((await store.readImage(result.content[0].attachment)).ref.width,64);
  assert.equal((await run({sessionId:'other'})).isError,true);assert.equal(calls,1);
  const unguard=ctx.tools.guard(()=> 'Camera disabled by session policy');
  assert.equal((await run({})).isError,true);assert.equal(calls,1);unguard();
  await plugin.dispose();assert.equal(ctx.tools.get('stackchan_take_photo'),undefined);
});
