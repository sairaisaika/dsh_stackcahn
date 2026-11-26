"""Inspect a previously saved raw Flash backup offline. Never accesses devices."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

def inspect_partitions(data):
    if len(data)<0x9000:raise ValueError('Backup is too small for the expected ESP-IDF table location')
    entries=[];table=data[0x8000:0x9000];digest_seen=False
    for offset in range(0,len(table),32):
        row=table[offset:offset+32]
        if row[:2]==b'\xff\xff':break
        if row[:2]==b'\xeb\xeb':
            if hashlib.md5(table[:offset]).digest()!=row[16:32]:raise ValueError('Partition table MD5 mismatch')
            digest_seen=True;break
        if row[:2]!=b'\xaa\x50':raise ValueError('Unrecognized partition table; do not infer flash offsets')
        _,kind,subtype,address,size,label,flags=struct.unpack('<HBBII16sI',row)
        if not size or address<0x9000 or address+size>len(data):raise ValueError('Partition outside supplied full backup')
        entries.append({'label':label.split(b'\0')[0].decode('ascii'),'type':kind,'subtype':subtype,
            'offset':hex(address),'bytes':size,'flags':flags,
            'sha256':hashlib.sha256(data[address:address+size]).hexdigest()})
    if not entries or not digest_seen:raise ValueError('Missing partition entries or table digest')
    spans=sorted((int(e['offset'],16),int(e['offset'],16)+e['bytes']) for e in entries)
    if any(a[1]>b[0] for a,b in zip(spans,spans[1:])):raise ValueError('Overlapping partitions')
    return entries

def inspect(image):
    data=image.read_bytes()
    entries=inspect_partitions(data)
    return {'backup':str(image.resolve()),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),
        'partitions':entries,'activeOtaSlot':'not inferred; inspect OTA metadata before any write',
        'secureBootOrEncryption':'not inferred; obtain device security information separately',
        'deviceAccess':False,'flashAuthorized':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('backup',type=Path)
    args=parser.parse_args()
    print(json.dumps(inspect(args.backup),indent=2))
