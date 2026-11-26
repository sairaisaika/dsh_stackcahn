"""Unit and opt-in native audio checks. Synthetic input only; no device access."""
import base64
import io
import json
import math
import os
from pathlib import Path
import random
import struct
import subprocess
import sys
import unittest

from local_audio import BLOCK, Frontend, Segmenter, StereoResampler, AudioDsp, verify

ZERO = bytes(BLOCK * 2)
RUNTIME = os.environ.get('STACKCHAN_LOCAL_AUDIO_RUNTIME')


class Segments(unittest.TestCase):
    def test_silence_and_impulses_do_not_create_speech(self):
        s = Segmenter()
        for _ in range(1000):
            self.assertIsNone(s.push(ZERO, 0.01))
        for probability in [0.99, 0.99] + [0.01] * 20:
            self.assertIsNone(s.push(ZERO, probability))
        self.assertLessEqual(len(s.pre), 8)
        self.assertIsNone(s.frames)

    def test_after_gap_requires_a_new_quiet_boundary(self):
        s = Segmenter(wait_for_silence=True)
        for p in [0.99]*20 + [0.01]*15 + [0.99]*20:
            self.assertIsNone(s.push(ZERO, p))
        self.assertTrue(s.wait_for_silence)
        self.assertEqual(len(s.pre), 0)
        for p in [0.01]*16:
            self.assertIsNone(s.push(ZERO, p))
        self.assertFalse(s.wait_for_silence)
        result = None
        for p in [0.99]*8 + [0.01]*16:
            result = s.push(ZERO, p)
        self.assertIsNotNone(result)
        self.assertGreaterEqual(result['sample_start'], 71 * BLOCK)

    def test_onset_preroll_and_offset_hysteresis(self):
        s = Segmenter()
        chunks = []
        probabilities = [0.0]*10 + [0.9]*3 + [0.45]*8 + [0.0]*16
        for index, probability in enumerate(probabilities):
            block = struct.pack('<512h', *([index]*512))
            chunks.append(block)
            result = s.push(block, probability)
            if index != len(probabilities)-1:
                self.assertIsNone(result)
        self.assertEqual(result['pcm'], b''.join(chunks[5:]))
        self.assertEqual(result['sample_start'],5*512)
        self.assertEqual(result['sample_end'],37*512)
        self.assertEqual(result['reason'],'silence')
        self.assertFalse(result['continuation'])

    def test_too_short_activation_is_dropped(self):
        s = Segmenter()
        for p in [0.9]*3 + [0.0]*16:
            self.assertIsNone(s.push(ZERO,p))
        self.assertIsNone(s.frames)

    def test_long_speech_has_bounded_contiguous_nonoverlapping_slices(self):
        s=Segmenter(max_blocks=40)
        results=[]
        for i in range(101):
            r=s.push(struct.pack('<512h', *([i]*512)), 0.99 if i<85 else 0.0)
            if r:
                results.append(r)
            self.assertLessEqual(len(s.frames or []),40)
        self.assertEqual([r['reason'] for r in results],['limit','limit','silence'])
        self.assertEqual([r['continuation'] for r in results],[False,True,True])
        self.assertEqual(results[0]['sample_end'],results[1]['sample_start'])
        self.assertEqual(results[1]['sample_end'],results[2]['sample_start'])
        self.assertEqual(b''.join(r['pcm'] for r in results),b''.join(struct.pack('<512h',*([i]*512)) for i in range(101)))

    def test_invalid_configuration_and_inputs(self):
        for options in ({'onset':float('nan')},{'offset':0.7},{'max_blocks':938},{'start_blocks':9},{'silence_blocks':625},{'min_blocks':1000},{'pre_blocks':False}):
            with self.assertRaises(ValueError): Segmenter(**options)
        s=Segmenter()
        for pcm,p in ((b'',0.5),(ZERO,float('nan')),(ZERO,float('inf')),(ZERO,-0.1),(ZERO,1.1)):
            with self.assertRaises(ValueError): s.push(pcm,p)
        self.assertEqual(s.samples,0)


@unittest.skipUnless(RUNTIME,'requires explicitly prepared native library and model')
class Native(unittest.TestCase):
    def test_frame_order_model_and_close(self):
        f=Frontend(Path(RUNTIME))
        try:
            with self.assertRaises(ValueError): f.process(1,bytes(960))
            with self.assertRaises(ValueError): f.process(False,bytes(960))
            with self.assertRaises(ValueError): f.process(0,bytes(958))
            for i in range(100):
                result=f.process(i,bytes(960))
                self.assertIsNone(result['segment'])
                if result['probability'] is not None:
                    self.assertLess(result['probability'],0.1)
            self.assertLess(len(f.pending),1024)
            self.assertEqual(f.sequence,100)
        finally:
            f.close()
        with self.assertRaises(ValueError): f.process(100,bytes(960))
        f.close()

    def test_native_hop_clock_is_bounded_and_state_persists(self):
        resampler, aec, model, _ = verify(Path(RUNTIME))
        dsp = AudioDsp(resampler, aec, model)
        produced = 0
        try:
            for index in range(250):
                pcm = dsp.process(bytes(960))
                self.assertIn(len(pcm), (0, 512))
                produced += len(pcm) // 2
                self.assertEqual(produced, ((index + 1) * 160 // 256) * 256)
                self.assertEqual(len(dsp.pending[0]), (index + 1) * 160 % 256)
                self.assertEqual(len(dsp.pending[1]), len(dsp.pending[0]))
        finally:
            dsp.close()
        with self.assertRaises(ValueError): dsp.process(bytes(960))
        dsp.close()

    def test_resampler_rejects_above_nyquist(self):
        library,_,_,_=verify(Path(RUNTIME))
        energies=[]
        for frequency in (1000,10000):
            dsp=StereoResampler(library);out=[]
            try:
                for offset in range(0,24000,240):
                    raw=struct.pack('<480h',*[v for i in range(offset,offset+240) for v in (int(7000*math.sin(2*math.pi*frequency*i/24000)),0)])
                    channels=dsp.process(raw);out.extend(channels[0]);self.assertTrue(all(x==0 for x in channels[1]))
            finally:dsp.close()
            energies.append(sum(x*x for x in out[1600:])/len(out[1600:]))
        self.assertLess(energies[1]/energies[0],0.001)

    def test_worker_protocol_failure_no_payload_leak(self):
        command=[sys.executable,str(Path(__file__).with_name('local_audio.py')),'--directory',RUNTIME]
        for request in ('x'*2049+'\n',json.dumps({'sequence':1,'data':base64.b64encode(bytes(960)).decode()})+'\n',json.dumps({'sequence':0,'data':'PRIVATE-INPUT'})+'\n'):
            p=subprocess.run(command,input=request,text=True,capture_output=True,timeout=20)
            self.assertNotEqual(p.returncode,0)
            messages=[json.loads(line) for line in p.stdout.splitlines()]
            self.assertEqual(messages[0]['type'],'ready')
            self.assertEqual(messages[-1],{'type':'error','code':'audio-frontend-failed'})
            self.assertNotIn('PRIVATE-INPUT',p.stdout+p.stderr)


if __name__=='__main__': unittest.main()
