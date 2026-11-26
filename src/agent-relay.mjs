import { createHash, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

const protocol = 'sion-rendezvous-v1';
const readyMessage = 'SION-RELAY-READY 1';
const maxFrame = 16384;
const maxBuffered = 65536;
const roomPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const pathPattern = /^\/v1\/rooms\/([0-9a-f]{32})\/(host|device)$/;
const fault = code => Object.assign(new Error(`Sion relay: ${code}`), { code });
export const relayTokenDigest = token => createHash('sha256').update(token,'ascii').digest();
export function relayOrigin(endpoint) {
  let url;
  try { if(typeof endpoint==='string')url=new URL(endpoint); } catch {}
  if (url?.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw fault('relay-config-invalid');
  return url;
}

/** A fixed-size rendezvous. Its sole data plane connects the two ends of one room. */
export function createAgentRelay({ cert, key, rooms, waitMs = 30000 } = {}) {
  if (!Array.isArray(rooms) || !rooms.length || rooms.length > 64 ||
      !Number.isInteger(waitMs) || waitMs < 50 || waitMs > 120000)
    throw new TypeError('Invalid relay limits');
  const allowed = new Map();
  for (const { roomId, hostTokenSha256, deviceTokenSha256 } of rooms) {
    if (!roomPattern.test(roomId ?? '') || allowed.has(roomId) ||
        !tokenPattern.test(hostTokenSha256 ?? '') || !tokenPattern.test(deviceTokenSha256 ?? '') ||
        hostTokenSha256 === deviceTokenSha256)
      throw new TypeError('Invalid relay room credentials');
    allowed.set(roomId, {
      host: Buffer.from(hostTokenSha256,'hex'), device: Buffer.from(deviceTokenSha256,'hex'), session: null,
    });
  }
  if (!cert || !key) throw new TypeError('Relay TLS identity is required');
  const server = https.createServer({ cert,key,minVersion:'TLSv1.2',handshakeTimeout:5000,
    maxHeaderSize:4096,headersTimeout:5000,requestTimeout:5000 }, (_request,response) => {
    response.writeHead(404,{Connection:'close'});response.end();
  });
  const wss = new WebSocketServer({ noServer:true,maxPayload:maxFrame,maxFragments:32,
    maxBufferedChunks:64,perMessageDeflate:false,handleProtocols: () => protocol });
  const sockets = new Set();
  const peers = new Map();
  let starting, stopping, ping;
  server.maxConnections = Math.min(160,2 * allowed.size + 16);
  server.on('connection', socket => {
    sockets.add(socket);socket.setTimeout(10000,()=>socket.destroy());
    socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('tlsClientError',()=>{});
  server.on('error',()=>{});
  const endSession = (room,session) => {
    if (room.session !== session) return;
    room.session = null;
    clearTimeout(session.timer);
    session.host?.terminate();
    session.device?.terminate();
  };
  const join = (room,role,ws) => {
    const session = room.session ??= {};
    session[role] = ws;
    peers.set(ws,true);
    const end = () => endSession(room,session);
    ws.on('error',end);
    ws.once('close',()=>{peers.delete(ws);end();});
    ws.on('pong',()=>{if(peers.has(ws))peers.set(ws,true);});
    const other = role === 'host' ? 'device' : 'host';
    ws.on('message',(bytes,binary)=>{
      const partner = session[other];
      if (!session.ready || !binary || !bytes.length || partner?.readyState !== WebSocket.OPEN ||
          partner.bufferedAmount + bytes.length > maxBuffered) return end();
      partner.send(bytes,{binary:true,compress:false},error=>{if(error)end();});
    });
    if (!session[other]) { session.timer=setTimeout(end,waitMs);return; }
    clearTimeout(session.timer);
    session.ready=true;
    for (const peer of [session.host,session.device])
      peer.send(readyMessage,{binary:false},error=>{if(error)end();});
  };
  server.on('upgrade',(request,socket,head)=>{
    const [,id,role] = pathPattern.exec(request.url ?? '') ?? [];
    const room = allowed.get(id);
    const auth = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
    let status;
    if (stopping || !room || !auth || request.method !== 'GET' || request.headers.origin !== undefined ||
        request.headers['sec-websocket-protocol'] !== protocol || !timingSafeEqual(room[role],relayTokenDigest(auth[1])))
      status = '401 Unauthorized';
    else if (room.session?.[role]) status = '409 Conflict';
    if (status) { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);return; }
    socket.setTimeout(0);
    wss.handleUpgrade(request,socket,head,ws=>join(room,role,ws));
  });
  return {
    listen({ host = '127.0.0.1', port = 0 } = {}) {
      if (starting || stopping) throw fault('relay-already-started');
      starting = new Promise((resolve,reject)=>{
        const failed = error => { server.off('listening',ready);reject(error); };
        const ready = () => { server.off('error',failed);resolve(server.address()); };
        server.once('error',failed);server.once('listening',ready);server.listen({host,port});
      });
      ping=setInterval(()=>{
        for(const [peer,alive] of peers) {
          if(!alive) { peer.terminate();continue; }
          peers.set(peer,false);peer.ping();
        }
      },15000);
      return starting;
    },
    close() {
      return stopping ??= (async ()=>{
        clearInterval(ping);
        await starting?.catch(()=>{});
        for(const room of allowed.values())if(room.session)endSession(room,room.session);
        for(const socket of sockets)socket.destroy();
        await Promise.all([new Promise(resolve=>wss.close(resolve)),new Promise(resolve=>server.close(resolve))]);
      })();
    },
  };
}

/** TLS-protected rendezvous as a bounded byte stream. Agent authentication is a separate layer. */
export function openAgentRelayStream({ endpoint, roomId, role, token, ca, signal, timeoutMs = 35000 }) {
  signal?.throwIfAborted();
  const url=relayOrigin(endpoint);
  if (!roomPattern.test(roomId ?? '') || !['host','device'].includes(role) || !tokenPattern.test(token ?? '') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000)
    throw fault('relay-config-invalid');
  url.pathname = `/v1/rooms/${roomId}/${role}`;
  const ws = new WebSocket(url,protocol,{ ca,minVersion:'TLSv1.2',handshakeTimeout:Math.min(5000,timeoutMs),
    maxPayload:maxFrame,maxFragments:32,maxBufferedChunks:64,perMessageDeflate:false,
    headers:{Authorization:`Bearer ${token}`},rejectUnauthorized:true,followRedirects:false });
  let enrolled = false;
  const stream = new Duplex({
    highWaterMark: maxFrame,
    read() { if(ws.readyState===WebSocket.OPEN)ws.resume(); },
    write(bytes,_encoding,done) {
      if (!enrolled || ws.readyState !== WebSocket.OPEN) return done(fault('relay-closed'));
      // Node TLS can hand the carrier multiple records at once.
      function write(offset) {
        if(offset===bytes.length) return done();
        const frame=bytes.subarray(offset,offset+maxFrame);
        ws.send(frame,{binary:true,compress:false},error=>error?done(error):write(offset+frame.length));
      }
      write(0);
    },
    destroy(error,done) {
      if(ws.readyState===WebSocket.CLOSED)return done(error);
      ws.once('close',()=>done(error));ws.terminate();
    },
  });
  stream.on('error',()=>{});
  return new Promise((resolve,reject)=>{
    const cancel=()=>stream.destroy(fault(signal?.aborted?'relay-cancelled':'relay-timeout'));
    const timer=setTimeout(cancel,timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    ws.on('error',()=>stream.destroy(fault('relay-connection-failed')));
    ws.once('close',()=>stream.destroy());
    ws.on('message',(bytes,binary)=>{
      if(!enrolled) {
        if(binary||bytes.toString()!==readyMessage)return stream.destroy(fault('relay-protocol'));
        enrolled=true;clearTimeout(timer);resolve(stream);return;
      }
      if(!binary||!bytes.length||stream.readableLength+bytes.length>maxBuffered)
        return stream.destroy(fault('relay-protocol'));
      if(!stream.push(bytes))ws.pause();
    });
    stream.once('close',()=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',cancel);
      if(!enrolled)reject(stream.errored ?? fault('relay-closed'));
    });
  });
}
