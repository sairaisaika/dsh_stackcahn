import { createPairing } from '../src/pairing.mjs';
const [command,directory,url]=process.argv.slice(2);
if(command!=='prepare'||!directory||url===undefined) {
  console.error('Usage: node scripts/pairing.mjs prepare PRIVATE_DIRECTORY wss://MAC_PRIVATE_IP:PORT/path (or an explicit empty string for no LAN)');
  process.exitCode=2;
} else {
  try {console.log(JSON.stringify(createPairing(directory,url),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
