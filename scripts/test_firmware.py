"""Host contracts using portable controller and actual patched WebsocketProtocol."""
from pathlib import Path
import argparse
import subprocess
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,default=root/'work/firmware-build/firmware')
firmware=parser.parse_args().source.resolve()
out=root/'work/host-tests';out.mkdir(parents=True,exist_ok=True)
source=firmware/'xiaozhi-esp32/main'
cjson=firmware/'managed_components/espressif__cjson/cJSON'
base=['clang++','-std=c++17','-fsanitize=address,undefined','-g','-include','memory']
for name in ['mode_controller','endpoint_policy']:
 exe=out/name
 subprocess.run(base+['-Wall','-Wextra','-Werror','-I'+str(root/'firmware/overlay'),str(root/f'firmware/tests/{name}_test.cc'),'-o',str(exe)],check=True)
 subprocess.run([str(exe)],check=True)
subprocess.run(['clang','-Wno-deprecated-declarations','-fsanitize=address,undefined','-g','-c',str(cjson/'cJSON.c'),'-o',str(out/'cJSON.o')],check=True)
exe=out/'websocket_endpoint'
subprocess.run(base+['-I'+str(root/'firmware/tests/stubs'),'-I'+str(source/'protocols'),'-I'+str(cjson),str(root/'firmware/tests/websocket_endpoint_test.cc'),str(source/'protocols/websocket_protocol.cc'),str(source/'protocols/protocol.cc'),str(out/'cJSON.o'),'-o',str(exe)],check=True)
subprocess.run([str(exe)],check=True)
exe=out/'pairing_store'
subprocess.run(base+['-Wall','-Wextra','-Werror','-I'+str(root/'firmware/tests/stubs'),'-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(root/'firmware/tests/pairing_store_test.cc'),str(root/'firmware/overlay/sion/pairing_store.cc'),str(out/'cJSON.o'),'-o',str(exe)],check=True)
subprocess.run([str(exe)],check=True)
