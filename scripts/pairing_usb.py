"""USB pairing client. Default is a local plan; --apply explicitly opens a device.

No bootloader, reset, flash-image or partition-erase commands exist in this tool.
Opening a serial port can still affect hardware; run only at the agreed device step.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import time

def exchange(port, action, **fields):
    request_id=secrets.token_hex(16)
    message={'request_id':request_id,'action':action,**fields}
    encoded=b'SION1 '+json.dumps(message,separators=(',',':')).encode()+b'\n'
    if len(encoded)>8192: raise ValueError('USB request too large')
    port.write(encoded);port.flush()
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        line=port.read_until(b'\n',size=16384)
        start=line.find(b'SION1 ')
        if start<0: continue
        try: reply=json.loads(line[start+6:])
        except (ValueError,UnicodeError): continue
        if reply.get('request_id')==request_id:return reply
    raise RuntimeError('USB outcome unconfirmed; query status before any retry')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['status','install','remove','confirm_firmware'])
    parser.add_argument('--bundle',type=Path)
    parser.add_argument('--port')
    parser.add_argument('--expected-device',help='Exact 12-digit device ID from a prior status check')
    parser.add_argument('--expected-pair',default='',help='Current pair ID; empty means unpaired')
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--expected-boot',help='Trial boot_nonce from status')
    parser.add_argument('--expected-image',help='Image validation SHA-256 from reviewed build, not whole-file SHA')
    parser.add_argument('--voice-and-app-verified',action='store_true',help='Operator has actually checked original voice and App on this trial boot')
    args=parser.parse_args()
    record=None
    if args.action=='install':
        if not args.bundle:parser.error('install requires --bundle')
        stat=args.bundle.stat()
        if stat.st_mode&0o077 or stat.st_uid!=os.getuid():parser.error('pairing bundle must be private and owned by this user')
        record=json.loads(args.bundle.read_text())['record']
    if not args.apply:
        print(json.dumps({'dry_run':True,'action':args.action,'device_access':False,
            'pair_id':record['pair_id'] if record else args.expected_pair,
            'storage':'OTA trial confirmation' if args.action=='confirm_firmware' else 'sion_pair namespace only',
            'activation':'explicit trial acceptance; pairing remains restricted until reboot' if args.action=='confirm_firmware' else 'next deliberate device restart'}))
        return
    if not args.port:parser.error('--apply requires an explicit --port')
    if args.action!='status' and not args.expected_device:parser.error('writes require --expected-device from a prior status check')
    if args.action=='confirm_firmware' and not (args.expected_boot and args.expected_image and args.voice_and_app_verified):
        parser.error('confirmation requires --expected-boot, --expected-image and --voice-and-app-verified')
    import serial
    # Set control line intent BEFORE opening; never run esptool reset sequences.
    port=serial.Serial(port=None,baudrate=115200,timeout=0.5,write_timeout=5)
    port.dtr=False;port.rts=False;port.port=args.port
    try:
        port.open()
        status=exchange(port,'status')
        if args.action=='status':print(json.dumps(status));return
        if status.get('device_id')!=args.expected_device:raise RuntimeError('Device ID mismatch; no write sent')
        if args.action=='confirm_firmware':
            trial=status.get('firmware_trial',{})
            if trial.get('state')!='pending' or trial.get('boot_nonce')!=args.expected_boot or trial.get('image_sha256')!=args.expected_image:
                raise RuntimeError('Trial boot/image mismatch; no confirmation sent')
            result=exchange(port,'confirm_firmware',boot_nonce=args.expected_boot,image_sha256=args.expected_image,voice_and_app_verified=True)
            print(json.dumps(result))
            if not result.get('ok'):raise RuntimeError('Trial confirmation rejected or unconfirmed; retain USB recovery materials')
            return
        if status.get('pair_id')!=args.expected_pair:raise RuntimeError('Pair ID mismatch; no write sent')
        result=exchange(port,args.action,expected_pair_id=args.expected_pair,**({'record':record} if record else {}))
        print(json.dumps(result))
        if not result.get('ok'):raise RuntimeError('Pairing not confirmed; retain the private bundle and query status')
    finally:
        port.close()

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
