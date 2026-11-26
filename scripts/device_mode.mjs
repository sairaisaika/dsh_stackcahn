import {readFileSync,statSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {DeviceModeClient} from '../src/device-mode.mjs';
const {positionals,values}=parseArgs({allowPositionals:true,options:{pairing:{type:'string'},address:{type:'string'},apply:{type:'boolean',default:false}}});
const action=positionals[0];
if(!['status','hold'].includes(action)||!values.pairing||!values.address) {
  console.error('Usage: node scripts/device_mode.mjs status|hold --pairing PRIVATE_BUNDLE --address https://DEVICE_IP:8765 [--apply]');
  process.exitCode=2;
} else {
  let client;
  try {
    if(statSync(values.pairing).mode&0o077)throw new Error('Pairing bundle must be private');
    const pairing=JSON.parse(readFileSync(values.pairing,'utf8'));
    client=new DeviceModeClient({address:values.address,pairing});
    if(!values.apply)console.log(JSON.stringify({dryRun:true,action,deviceAccess:false,pairId:pairing.record.pair_id}));
    else if(action==='status')console.log(JSON.stringify(await client.status(),null,2));
    else {
      // This CLI holds mode ownership only. It neither captures host audio nor
      // creates an ASR/TTS backend or a replacement DSH session.
      let end;
      const done=new Promise(resolve=>{end=resolve;});
      const abort=new AbortController();
      const stop=()=>{abort.abort();end();};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try {
        await client.acquire({signal:abort.signal,onDisconnect:end});
        console.log('Local mode connected. Ctrl-C returns to the original assistant.');
        // Timers in the library are unrefed; the CLI deliberately stays alive.
        const keepAlive=setInterval(()=>{},1000);
        try{await done;}finally{clearInterval(keepAlive);}
      } finally {
        process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
        if(client.lease)console.log(JSON.stringify(await client.release()));
      }
    }
  } catch(error){console.error(error.message);process.exitCode=1;}
  finally{client?.close();}
}
