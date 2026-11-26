import {CAMERA} from './agent-protocol.mjs';

const fail=code=>Object.assign(new Error(code),{code});

/** Decode under the device's raster budget before handing bytes to DSH's
 * mounted attachment provider. The provider owns normalization and retention.
 * assertCurrent is checked across every await, including non-cancellable saves.
 */
export async function saveCameraAttachment(picture,attachments,assertCurrent){
  assertCurrent();
  if(!attachments?.saveImage)throw fail('camera_attachments_unavailable');
  if(picture?.mediaType!=='image/jpeg'||!Buffer.isBuffer(picture.jpeg)||
      picture.jpeg.length<4||picture.jpeg.length>CAMERA.maxBytes||
      !Number.isInteger(picture.width)||!Number.isInteger(picture.height)||
      picture.width<1||picture.width>CAMERA.width||picture.height<1||picture.height>CAMERA.height)
    throw fail('camera_image_invalid');
  const {default:sharp}=await import('sharp');
  assertCurrent();
  const image=sharp(picture.jpeg,{failOn:'warning',limitInputPixels:CAMERA.width*CAMERA.height});
  try{
    const meta=await image.metadata();
    assertCurrent();
    if(meta.format!=='jpeg'||meta.width!==picture.width||meta.height!==picture.height||
        (meta.pages??1)!==1||(meta.orientation??1)!==1)throw fail('camera_image_invalid');
    // Header parsing alone accepts truncated JPEGs. Force a complete raster decode.
    await image.raw().toBuffer();
  }catch(error){
    assertCurrent();
    throw fail('camera_image_invalid');
  }finally{image.destroy();}
  assertCurrent();
  let attachment;
  try{
    attachment=await attachments.saveImage({data:picture.jpeg,mediaType:'image/jpeg',name:'stackchan-camera.jpg'});
  }catch{
    assertCurrent();
    throw fail('camera_attachment_failed');
  }
  // DSH saveImage has no AbortSignal / delete API. An interrupted save may leave
  // an unreferenced immutable object; never delete a shared digest or publish it.
  assertCurrent();
  return attachment;
}
