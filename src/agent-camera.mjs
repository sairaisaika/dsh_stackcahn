import {CAMERA} from './agent-protocol.mjs';

/** One validated transport result. JPEG decode/attachment import remains the consumer's job. */
export class CameraReception {
  constructor(){this.bytes=null;this.offset=0;this.finished=false;}
  receive(message){
    if(this.finished)throw new Error('Camera result already finished');
    if(message.type==='camera_meta'){
      if(this.bytes)throw new Error('Duplicate camera metadata');
      const size=Number(message.bytes),width=Number(message.width),height=Number(message.height);
      if(!Number.isSafeInteger(size)||size<4||size>CAMERA.maxBytes||
          !Number.isSafeInteger(width)||width<1||width>CAMERA.width||
          !Number.isSafeInteger(height)||height<1||height>CAMERA.height)throw new Error('Camera bounds');
      this.bytes=Buffer.alloc(size);this.width=width;this.height=height;
      return {next:0};
    }
    if(!this.bytes)throw new Error('Camera metadata missing');
    if(message.type==='camera_chunk'){
      if(BigInt(message.offset)!==BigInt(this.offset)||this.offset===this.bytes.length)throw new Error('Camera offset');
      const chunk=Buffer.from(message.data,'base64');
      if(chunk.toString('base64')!==message.data||chunk.length!==Math.min(CAMERA.chunkBytes,this.bytes.length-this.offset))throw new Error('Camera chunk shape');
      chunk.copy(this.bytes,this.offset);this.offset+=chunk.length;return {next:this.offset};
    }
    if(message.type!=='camera_complete'||this.offset!==this.bytes.length||
        this.bytes.readUInt16BE(0)!==0xffd8||this.bytes.readUInt16BE(this.bytes.length-2)!==0xffd9)throw new Error('Camera incomplete');
    const jpeg=this.bytes;this.bytes=null;this.finished=true;
    return {result:{mediaType:'image/jpeg',width:this.width,height:this.height,jpeg}};
  }
  clear(){this.bytes=null;this.finished=true;}
}
