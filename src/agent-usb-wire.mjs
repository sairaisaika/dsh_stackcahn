import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { AUDIO } from './agent-protocol.mjs';

export const USB_AGENT_ALPN = 'sion-usb-v1';
export const USB_AGENT_CIPHER = 'ECDHE-PSK-CHACHA20-POLY1305';
export const USB_AGENT_PREAMBLE = '\nSIONU1\n';
export const USB_STANDBY_PROBE = '\nSIONU0\n';
export const USB_STANDBY_READY = '\nSIONU0 READY\n';
export const RELAY_AGENT_ALPN = 'sion-relay-v1';
export const RELAY_AGENT_PREAMBLE = '\nSIONR1\n';
const version = 'TLSv1.2';
const headerSize = 3;
const text = 1;
const binary = 2;

export function usbTlsIdentity(deviceId, pairId, token) {
  return tlsIdentity(USB_AGENT_ALPN,deviceId,pairId,token);
}
export function relayTlsIdentity(deviceId, pairId, token) {
  return tlsIdentity(RELAY_AGENT_ALPN,deviceId,pairId,token);
}
function tlsIdentity(alpn,deviceId,pairId,token) {
  const identity = `${alpn}:${deviceId}:${pairId}`;
  const psk = createHmac('sha256', Buffer.from(token, 'hex')).update(identity, 'ascii').digest();
  return { identity, psk };
}

/** Wait on the already checked port, before starting TLS or admitting audio. */
export function waitForUsbReady(stream, signal) {
  signal.throwIfAborted();
  const line=Buffer.from(USB_STANDBY_READY.slice(1),'ascii');
  const ready=Promise.withResolvers();
  let position=0, done=false, timer;
  function finish(error) {
    if(done)return;
    done=true;
    clearTimeout(timer);
    stream.removeListener('readable',read);
    for(const event of ['error','end','close'])stream.removeListener(event,disconnected);
    signal.removeEventListener('abort',cancel);
    if(error)ready.reject(error);else ready.resolve();
  }
  const disconnected=()=>finish(Object.assign(new Error('USB standby port closed'),{code:'voice_usb_port_unavailable'}));
  const cancel=()=>finish(signal.reason);
  function read() {
    let chunk;
    while((chunk=stream.read())!==null)for(const byte of chunk){
      if(position>=0&&byte===line[position]){
        if(++position===line.length){finish();return;}
      }else position=byte===10?0:-1;
    }
  }
  function probe() {
    stream.write(USB_STANDBY_PROBE,'ascii',error=>{
      if(error){disconnected();return;}
      if(!done)timer=setTimeout(probe,500);
    });
  }
  for(const event of ['error','end','close'])stream.once(event,disconnected);
  stream.on('readable',read);
  signal.addEventListener('abort',cancel,{once:true});
  if(stream.destroyed||stream.readableEnded)disconnected();
  else probe();
  return ready.promise;
}

/** Adapts one open USB byte stream that emits close after releasing its handle. */
export function createUsbAgentWire(stream, credentials) {
  return createAgentByteWire(stream,credentials,USB_AGENT_ALPN,USB_AGENT_PREAMBLE);
}
export function createRelayAgentWire(stream, credentials) {
  return createAgentByteWire(stream,credentials,RELAY_AGENT_ALPN,RELAY_AGENT_PREAMBLE);
}
function createAgentByteWire(stream, { deviceId, pairId, localToken }, alpn, preamble) {
  if (!(stream instanceof Duplex) || !stream.readable || !stream.writable)
    throw new TypeError('An open duplex stream is required');
  const { identity, psk } = tlsIdentity(alpn,deviceId,pairId,localToken);
  const secureContext = createSecureContext({ minVersion: version, maxVersion: version, ciphers: USB_AGENT_CIPHER });
  const tls = new TLSSocket(stream, {
    secureContext, isServer: true, ALPNProtocols: [alpn],
    pskCallback: (_socket, offeredIdentity) => offeredIdentity === identity ? psk : null,
  });
  const wire = new EventEmitter();
  const header = Buffer.alloc(headerSize);
  let headerUsed = 0;
  let body = null;
  let bodyUsed = 0;
  let isBinary = false;
  let secure = false;
  let closed = false;
  let heartbeat, closeTimer;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(closeTimer);
    psk.fill(0);
    body = null;
    tls.destroy();
    stream.destroy();
    wire.emit('close');
  }

  // The message wire uses the same state values as ws for AgentConnection.
  Object.defineProperties(wire, {
    readyState: { get: () => closed ? WebSocket.CLOSED : secure ? WebSocket.OPEN : WebSocket.CONNECTING },
    bufferedAmount: { get: () => tls.writableLength + stream.writableLength },
  });
  // The byte-stream owner releases its handle before emitting close.
  wire.closed = new Promise(resolve => stream.once('close', resolve));
  wire.terminate = close;
  if(alpn===USB_AGENT_ALPN)wire.finish=()=>{
    if(closed||closeTimer)return;
    if(!secure){close();return;}
    clearInterval(heartbeat);
    closeTimer=setTimeout(close,750);
    tls.end(); // Give the ESP peer a TLS close notification while its CDC cable remains connected.
  };
  wire.send = (value, options, callback) => {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (wire.readyState !== WebSocket.OPEN || !payload.length || payload.length > AUDIO.maxMessageBytes) {
      callback(new Error('Agent byte wire cannot send this message'));
      return;
    }
    const frame = Buffer.allocUnsafe(headerSize + payload.length);
    frame[0] = options.binary ? binary : text;
    frame.writeUInt16BE(payload.length, 1);
    payload.copy(frame, headerSize);
    tls.write(frame, callback);
  };

  tls.once('secure', () => {
    if (closed) return;
    if (tls.getProtocol() !== version || tls.getCipher().name !== USB_AGENT_CIPHER || tls.alpnProtocol !== alpn) {
      close();
      return;
    }
    tls.disableRenegotiation();
    secure = true;
    psk.fill(0);
    // Serial/JTAG sees the USB bus even if Mac closed its serial handle.
    // Keep the device's idle-link lease separate from the capture lease.
    const heartbeatFrame = Buffer.from([3, 0, 1, 0]);
    heartbeat = setInterval(() => {
      if (wire.bufferedAmount + heartbeatFrame.length > 32768) { close(); return; }
      tls.write(heartbeatFrame, error => { if (error) close(); });
    }, 4000);
  });
  tls.on('data', chunk => {
    if (!secure) { close(); return; }
    let offset = 0;
    while (offset < chunk.length && !closed) {
      if (!body) {
        const copied = chunk.copy(header, headerUsed, offset, offset + headerSize - headerUsed);
        headerUsed += copied;
        offset += copied;
        if (headerUsed < headerSize) return;
        const length = header.readUInt16BE(1);
        if ((header[0] !== text && header[0] !== binary) || !length || length > AUDIO.maxMessageBytes) {
          close();
          return;
        }
        isBinary = header[0] === binary;
        body = Buffer.allocUnsafe(length);
        headerUsed = 0;
      }
      const copied = chunk.copy(body, bodyUsed, offset, offset + body.length - bodyUsed);
      bodyUsed += copied;
      offset += copied;
      if (bodyUsed === body.length) {
        const message = body;
        body = null;
        bodyUsed = 0;
        wire.emit('message', message, isBinary);
      }
    }
  });
  for (const resource of [tls, stream]) {
    resource.on('error', close);
    resource.once('end', close);
    resource.once('close', close);
  }
  stream.write(preamble, 'ascii', error => { if (error) close(); });
  return wire;
}
