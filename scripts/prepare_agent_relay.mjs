#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rmdir, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { checkServerIdentity, connect, createSecureContext, TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { relayOrigin, relayTokenDigest } from '../src/agent-relay.mjs';
import { relayConfigName } from '../src/agent-relay-config.mjs';

const messages = {
  usage: 'Usage: node scripts/prepare_agent_relay.mjs <private-input.json> <new-output-directory>',
  input: 'Check the input fields, endpoint, pairing ID, hotspot settings and private file permissions.',
  tls: 'Check the relay certificate, matching private key, hostname and trusted CA chain.',
  output: 'Use a new output directory under an existing writable parent.',
};
const fail = code => Object.assign(new Error(messages[code]), { code });
const dnsName = host => host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const randomHex = length => randomBytes(length).toString('hex');

async function readBounded(path, limit, privateInput = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (privateInput ? constants.O_NOFOLLOW : 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit ||
        (privateInput && (info.uid !== process.getuid() || info.mode & 0o077))) throw fail('input');
    const bytes = Buffer.alloc(info.size + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw fail('input');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

function inputOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('input');
  const { endpoint, pairId, certFile, keyFile, caFile, ssid = '', password = '', bindHost = '127.0.0.1', bindPort = 8443, ...unknown } = input;
  if (Object.keys(unknown).length || typeof pairId !== 'string' || !/^[0-9a-f]{32}$/.test(pairId) ||
      ![certFile, keyFile, caFile].every(item => typeof item === 'string' && item.length > 0 && !item.includes('\0')) ||
      typeof ssid !== 'string' || !ssid.isWellFormed() || ssid.includes('\0') || Buffer.byteLength(ssid) > 32 ||
      typeof password !== 'string' || (password !== '' && (!ssid || !/^[\x20-\x7e]{8,63}$/.test(password))) ||
      typeof bindHost !== 'string' || bindHost.length > 253 || (!isIP(bindHost) && !dnsName(bindHost)) ||
      !Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) throw fail('input');
  const match = typeof endpoint === 'string' && /^wss:\/\/([a-z\d.-]+)(?::\d+)?\/?$/i.exec(endpoint);
  if (!match || !endpoint.startsWith('wss://') || !dnsName(match[1].toLowerCase())) throw fail('input');
  const url = relayOrigin(endpoint);
  if (url.hostname !== match[1].toLowerCase() || url.origin.length > 180 || url.port === '0') throw fail('input');
  return { url, pairId, certFile, keyFile, caFile, ssid, password, bindHost, bindPort };
}

function certificatePem(value) {
  const pem = value.trim().replaceAll('\r\n', '\n') + '\n';
  if (!/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\s*)+$/.test(pem)) throw fail('tls');
  return pem;
}

// Exercise Node's actual server certificate verification without listening on
// an interface or resolving the operator's endpoint.
async function verifyTls({ cert, key, ca, hostname }) {
  const secureContext = createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
  const toServer = new PassThrough(), toClient = new PassThrough();
  const serverBytes = Duplex.from({ readable: toServer, writable: toClient });
  const clientBytes = Duplex.from({ readable: toClient, writable: toServer });
  const server = new TLSSocket(serverBytes, { isServer: true, secureContext });
  const client = connect({ socket: clientBytes, ca, minVersion: 'TLSv1.2', rejectUnauthorized: true,
    ...(isIP(hostname) ? {} : { servername: hostname }),
    checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('tls')), 3000);
      const error = () => { clearTimeout(timer); reject(fail('tls')); };
      server.on('error', error);
      client.on('error', error);
      client.once('secureConnect', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    client.destroy(); server.destroy(); clientBytes.destroy(); serverBytes.destroy();
  }
}

const jsonFile = value => `${JSON.stringify(value, null, 2)}\n`;

async function publish(output, files) {
  const directories = [], created = [];
  try {
    for (const directory of [output, join(output, 'profile'), join(output, 'relay')]) {
      await mkdir(directory, { mode: 0o700 });
      directories.push(directory);
    }
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(output, name);
      const file = await open(path, 'wx', 0o600);
      created.push(path);
      try { await file.writeFile(bytes); } finally { await file.close(); }
    }
  } catch {
    for (const path of created.reverse()) await unlink(path).catch(() => {});
    for (const path of directories.reverse()) await rmdir(path).catch(() => {});
    throw fail('output');
  }
}

export async function prepareAgentRelay(inputFile, destination) {
  let options;
  const source = resolve(inputFile);
  try { options = inputOptions(JSON.parse(await readBounded(source, 16384, true))); }
  catch { throw fail('input'); }

  let cert, key, ca;
  try {
    const material = await Promise.all([options.certFile, options.keyFile, options.caFile].map(file =>
      readBounded(resolve(dirname(source), file), 65536)));
    cert = certificatePem(material[0]);
    key = material[1].trim().replaceAll('\r\n', '\n') + '\n';
    ca = certificatePem(material[2]);
    if (!/^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\n[A-Za-z0-9+/=\n]+-----END \1-----\n$/.test(key) || Buffer.byteLength(ca) > 3072)
      throw fail('tls');
    await verifyTls({ cert, key, ca, hostname: options.url.hostname });
  } catch { throw fail('tls'); }

  const roomId = randomHex(16), revision = randomHex(16);
  const hostToken = randomHex(32), deviceToken = randomHex(32);
  const mac = { version: 1, endpoint: options.url.href, roomId, pairId: options.pairId, token: hostToken, ca };
  const record = { version: 1, pair_id: options.pairId, revision, origin: options.url.origin, room_id: roomId,
    token: deviceToken, ca, ssid: options.ssid, password: options.password };
  if (Buffer.byteLength(JSON.stringify(record)) > 4096 || hostToken === deviceToken) throw fail('input');
  const relay = { certFile: 'certificate.pem', keyFile: 'private-key.pem', host: options.bindHost, port: options.bindPort,
    rooms: [{ roomId, hostTokenSha256: relayTokenDigest(hostToken).toString('hex'), deviceTokenSha256: relayTokenDigest(deviceToken).toString('hex') }] };
  await publish(resolve(destination), {
    [`profile/${relayConfigName}`]: jsonFile(mac),
    'profile/.stackchan-relay-device.json': jsonFile({ record }),
    'relay/relay.json': jsonFile(relay),
    'relay/certificate.pem': cert,
    'relay/private-key.pem': key,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw fail('usage');
    await prepareAgentRelay(process.argv[2], process.argv[3]);
    console.log('Prepared the private profile and relay directories. No service was started.');
  } catch (error) {
    console.error(messages[error?.code] ?? messages.input);
    process.exitCode = 1;
  }
}
