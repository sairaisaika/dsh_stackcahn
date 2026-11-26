"""No serial imports or hardware: client framing, identity and unknown-outcome tests."""
import contextlib
import io
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import agent_pairing_usb as client

DEVICE='001122334455'
PAIR='c'*32
def reply(request_id='d'*32, **updates):
    return {'request_id':request_id,'ok':True,'error':'','device_id':DEVICE,'pair_id':'',
            'state':'empty','ready':True,'busy':False,'window':'e'*32,'remaining_ms':1000,'result':'',**updates}

class Port:
    def __init__(self, transform=lambda x:x):
        self.buffer=b'';self.requests=[];self.transform=transform
    def write(self, wire):
        prefix = b'\x00\n'+client.PREFIX
        assert wire.startswith(prefix)
        request=json.loads(wire[len(prefix):]);self.requests.append(request)
        response=self.transform(reply(request['request_id']))
        self.buffer=b'old log line\n'+client.PREFIX+json.dumps(response).encode()+b'\n'
        return len(wire)
    def read(self, _):
        chunk,self.buffer=self.buffer[:7],self.buffer[7:];return chunk

class Tests(unittest.TestCase):
    def test_verified_native_usb_open_skips_modem_updates_but_keeps_data_port_options(self):
        class Serial:
            def __init__(self, **options):
                self.options = options
                self.dtr = self.rts = True
                self.updates = []
            def _update_dtr_state(self):
                self.updates.append(('dtr', self.dtr))
            def _update_rts_state(self):
                self.updates.append(('rts', self.rts))
            def open(self):
                self._update_dtr_state()
                self._update_rts_state()
        with patch.dict('sys.modules', {'serial': SimpleNamespace(Serial=Serial)}):
            normal = client.configure_serial_port('normal', timeout=.1, write_timeout=1)
            native = client.configure_serial_port('verified', preserve_modem_lines=True, timeout=.1, write_timeout=1)
        normal.open()
        native.open()
        self.assertEqual(normal.updates, [('dtr', False), ('rts', False)])
        self.assertEqual(native.updates, [])
        self.assertEqual(native.port, 'verified')
        self.assertEqual(native.options, {'port': None, 'baudrate': 115200, 'exclusive': True,
                                          'timeout': .1, 'write_timeout': 1})

    def test_fragmented_status(self):
        port=Port();result=client.exchange(port,{'action':'status'})
        self.assertEqual(result['device_id'],DEVICE);self.assertEqual(len(port.requests),1)
        self.assertNotIn('window',client.public_status(result))

    def test_relay_mutation_requires_confirmed_revision_and_never_replays(self):
        calls = []
        revision = '4' * 32
        def transport(_port, request):
            calls.append(request['action'])
            if request['action'] == 'relay_status':
                return reply(state='paired', pair_id=PAIR, relay_state='empty', relay_revision='')
            return reply(state='paired', pair_id=PAIR, window='', remaining_ms=0,
                         relay_state='ready', relay_revision='5'*32, result='saved')
        with self.assertRaisesRegex(client.PairingError, '^write_unconfirmed$'):
            client.perform(None, 'relay_install', DEVICE, PAIR,
                           {'pair_id':PAIR, 'revision':revision}, call=transport)
        self.assertEqual(calls, ['relay_status', 'relay_install'])

    def test_old_firmware_stays_read_only_for_relay_requests(self):
        calls = []
        def transport(_port, request):
            calls.append(request['action'])
            return reply(ok=False, error='invalid_request', state='paired', pair_id=PAIR)
        with self.assertRaisesRegex(client.PairingError, '^relay_not_supported$'):
            client.perform(None, 'relay_remove', DEVICE, PAIR, call=transport)
        self.assertEqual(calls, ['relay_status'])

    def test_private_relay_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bundle.json'
            path.write_text(json.dumps({'record':{'ssid':'移动热点', 'password':'fixture-password'}}))
            path.chmod(0o600)
            self.assertEqual(client.read_private_relay_bundle(path)['ssid'], '移动热点')
            alternate = path.with_name('link')
            alternate.symlink_to(path)
            with self.assertRaisesRegex(client.PairingError, '^invalid_private_bundle$'):
                client.read_private_relay_bundle(alternate)
            path.chmod(0o644)
            with self.assertRaisesRegex(client.PairingError, '^invalid_private_bundle$'):
                client.read_private_relay_bundle(path)
    def test_invalid_reply_no_secret(self):
        for update in ({'error':'private-key-material'},{'state':'paired'},{'remaining_ms':True},{'unexpected':'secret'}):
            with self.assertRaisesRegex(client.PairingError,'^invalid_response$'):
                client.exchange(Port(lambda x:{**x,**update}),{'action':'status'})
    def test_unknown_outcome_does_not_retry(self):
        port=Port();port.write=lambda wire:0
        with self.assertRaisesRegex(client.PairingError,'write_unconfirmed'):client.exchange(port,{'action':'remove'})
        ticks=iter([0,0,2]);port=Port(lambda x:{**x,'request_id':'f'*32})
        with self.assertRaisesRegex(client.PairingError,'response_unconfirmed'):
            client.exchange(port,{'action':'status'},timeout=1,clock=lambda:next(ticks))
        self.assertEqual(len(port.requests),1)
    def test_limit_and_duplicate(self):
        port=Port();port.write=lambda wire:len(wire);port.read=lambda _:b'x'*256
        with self.assertRaisesRegex(client.PairingError,'response_limit'):client.exchange(port,{'action':'status'})
        with self.assertRaises(client.PairingError):client.unique_object([('ok',True),('ok',False)])
    def test_preflight_blocks_wrong_or_closed_device(self):
        for status,code in ((reply(device_id='ffeeddccbbaa'),'wrong_device'),
                            (reply(window='',remaining_ms=0),'physical_window_required'),
                            (reply(state='paired',pair_id=PAIR),'identity_conflict')):
            calls=[]
            def call(port,request):calls.append(request);return status
            with self.assertRaisesRegex(client.PairingError,code):client.perform(None,'remove',DEVICE,call=call)
            self.assertEqual(len(calls),1)
    def test_install_confirmation_and_no_replay(self):
        calls=[]
        def call(port,request):
            calls.append(request)
            return reply() if request['action']=='status' else reply(state='paired',pair_id=PAIR,window='',remaining_ms=0,result='saved')
        result=client.perform(None,'install',DEVICE,record={'pair_id':PAIR},call=call)
        self.assertTrue(result['ok']);self.assertEqual(len(calls),2);self.assertEqual(calls[1]['window'],'e'*32)
        self.assertNotIn('window',result)
        def uncertain(port,request):
            if request['action']=='status':return reply()
            raise client.PairingError('response_unconfirmed')
        with self.assertRaisesRegex(client.PairingError,'response_unconfirmed'):
            client.perform(None,'remove',DEVICE,call=uncertain)
    def test_success_must_match_requested_identity(self):
        def call(port,request):return reply() if request['action']=='status' else reply(state='paired',pair_id='f'*32)
        with self.assertRaisesRegex(client.PairingError,'write_unconfirmed'):
            client.perform(None,'install',DEVICE,record={'pair_id':PAIR},call=call)
    def test_dry_run_does_not_import_serial_or_read_bundle(self):
        with patch.dict('sys.modules',{'serial':None}),contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(client.main(['install','--bundle','/not/a/file']),0)
        self.assertFalse(json.loads(output.getvalue())['opensSerial'])
    def test_apply_sets_control_lines_before_open_and_closes(self):
        class Serial:
            def __init__(self, **options):
                self.options=options;self.dtr=self.rts=True;self.closed=False
            def open(self):
                assert self.options['port'] is None and self.options['timeout']==0.1
                assert self.options['write_timeout']==1 and self.options['exclusive']
                assert not self.dtr and not self.rts
            def close(self):self.closed=True
        port=Serial(port=None,timeout=0.1,write_timeout=1,exclusive=True)
        with patch.dict('sys.modules',{'serial':SimpleNamespace(Serial=lambda **kw:port)}), \
             patch.object(client,'perform',side_effect=client.PairingError('response_unconfirmed')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(client.main(['status','--port','fake-test-only','--apply']),1)
        self.assertTrue(port.closed)
        self.assertEqual(json.loads(output.getvalue())['error'],'response_unconfirmed')

def exercise_actual_service(executable):
    record=json.loads(subprocess.check_output([executable,'--record']))
    relay_record=json.loads(subprocess.check_output([executable,'--relay-record']))
    class PipePort:
        def __init__(self, process):self.process=process
        def write(self, data):
            self.process.stdin.write(data);self.process.stdin.flush();return len(data)
        def read(self, size):
            if select.select([self.process.stdout],[],[],0.1)[0]:return os.read(self.process.stdout.fileno(),size)
            return b''
    for mode,action,expected,body in (('--stdio','install','',record),('--stdio-paired','remove',PAIR,None),
                                      ('--stdio-paired','relay_install',PAIR,relay_record),('--stdio-relay','relay_remove',PAIR,None)):
        process=subprocess.Popen([executable,mode],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            port=PipePort(process)
            result=client.perform(port,action,DEVICE,expected,body)
            assert result['ok'] and result['state']==('revoked' if action=='remove' else 'paired')
            relay = action in client.RELAY_ACTIONS
            if relay:
                status=client.perform(port,'relay_status',DEVICE)
                assert status['pair_id']==PAIR and status['relay_state']==('ready' if body else 'empty')
                assert status['relay_revision']==(relay_record['revision'] if body else '')
                assert all(secret not in json.dumps(status) for secret in (relay_record['token'], relay_record['password'], relay_record['ca']))
            try:client.perform(port,'relay_remove' if relay else 'remove',DEVICE,result['pair_id'])
            except client.PairingError as error:assert str(error)=='physical_window_required'
            else:raise AssertionError('replayed a consumed physical window')
        finally:
            process.stdin.close();process.wait(timeout=5);process.stdout.close()
        assert process.returncode==0
    pending_removal = client.PREFIX + json.dumps({
        'action': 'remove', 'request_id': 'd'*32, 'expected_device': DEVICE,
        'expected_pair_id': PAIR, 'window': 'e'*32,
    }).encode('ascii')
    for residue in (b'fragment with no newline', pending_removal, b'x'*8193):
        process = subprocess.Popen([executable, '--stdio-paired'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            port = PipePort(process)
            port.write(residue)
            status = client.exchange(port, {'action': 'status'}, timeout=0.5)
            assert status['state'] == 'paired' and status['pair_id'] == PAIR
            assert status['window'] == 'e'*32, 'the interrupted removal consumed the physical window'
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()
        assert process.returncode == 0
    print('The first status after partial data, overlong data or an unterminated removal succeeds without changing pairing')
    print('Actual C++ SIONA1 endpoint and Python client over pipes: pairing and relay status/install/remove passed; no serial opened')

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--service-executable':exercise_actual_service(sys.argv[2])
    else:unittest.main()
