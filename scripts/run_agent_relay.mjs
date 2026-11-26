#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAgentRelay } from '../src/agent-relay.mjs';

let relay;
try {
  if (process.argv.length !== 3) throw new TypeError('Pass a relay configuration file');
  const location=resolve(process.argv[2]);
  const data=JSON.parse(await readFile(location,'utf8'));
  const {certFile,keyFile,rooms,host='127.0.0.1',port=8443}=data;
  if (typeof host!=='string'||!host||!Number.isInteger(port)||port<0||port>65535)
    throw new TypeError('Invalid relay bind address');
  const [cert,key]=await Promise.all([certFile,keyFile].map(file=>readFile(resolve(dirname(location),file))));
  relay=createAgentRelay({cert,key,rooms});
  for (const event of ['SIGINT','SIGTERM'])process.once(event,()=>{void relay.close();});
  const address=await relay.listen({host,port});
  console.log(`Sion relay listening on ${address.address} port ${address.port}`);
} catch {
  await relay?.close();
  console.error('Sion relay could not start. Check the configuration, TLS identity and listener address.');
  process.exitCode=1;
}
