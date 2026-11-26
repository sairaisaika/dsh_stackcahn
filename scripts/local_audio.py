"""Offline mic/reference frontend. No audio device access, sockets or dialogue state."""
import argparse
import base64
from collections import deque
import ctypes as C
import json
import math
from pathlib import Path
import platform
import struct
import sys

from prepare_voice import digest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'vendor/audio/assets.json'
AEC_V12_MANIFEST = ROOT / 'vendor/audio/aec-v12.json'
FRAME = 240
BLOCK = 512
RATE = 16000
MAX_SEQUENCE = 2**53 - 1


def verify(directory, aec_v12=False):
    record = json.loads((directory / 'native.json').read_text())
    names = {'libspeexdsp.dylib', 'liblocalvqe.dylib'}
    if (record.get('version') != 2 or record.get('system') != platform.system() or
            record.get('machine') != platform.machine() or
            record.get('manifestSha256') != digest(MANIFEST) or
            set(record.get('libraries', {})) != names):
        raise ValueError('audio-install-invalid')
    for name in names:
        library = directory / name
        if library.is_symlink() or digest(library) != record['libraries'][name]:
            raise ValueError('audio-install-invalid')
    for item in json.loads(MANIFEST.read_text())['files']:
        path = directory / 'assets' / item['path']
        if path.is_symlink() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise ValueError('audio-asset-invalid')
    model = directory / 'assets/localvqe-v1.3-4.8M-f32.gguf'
    if aec_v12:
        model_directory = directory / 'aec-v12'
        item, = json.loads(AEC_V12_MANIFEST.read_text())['files']
        model = model_directory / item['path']
        if (model_directory.is_symlink() or model.is_symlink() or not model.is_file()
                or model.stat().st_size != item['bytes'] or digest(model) != item['sha256']):
            raise ValueError('audio-asset-invalid')
    return (directory / 'libspeexdsp.dylib', directory / 'liblocalvqe.dylib',
            model, directory / 'assets/silero_vad.jit')


class StereoResampler:
    """Two ADC channels, same stateful 24→16 kHz conversion; no AEC cascade."""
    def __init__(self, library):
        self.state = None
        self.lib = C.CDLL(str(library))
        ptr, integer, samples = C.c_void_p, C.c_int, C.POINTER(C.c_int16)
        api = {
            'speex_resampler_init': (ptr, [C.c_uint32, C.c_uint32, C.c_uint32, integer, C.POINTER(integer)]),
            'speex_resampler_process_int': (integer, [ptr, C.c_uint32, samples, C.POINTER(C.c_uint32), samples, C.POINTER(C.c_uint32)]),
            'speex_resampler_destroy': (None, [ptr]),
            'speex_resampler_reset_mem': (integer, [ptr]),
            'speex_resampler_get_output_latency': (integer, [ptr]),
        }
        for name, (result, arguments) in api.items():
            fn = getattr(self.lib, name)
            fn.restype, fn.argtypes = result, arguments
        error = integer()
        self.state = self.lib.speex_resampler_init(2, 24000, RATE, 8, C.byref(error))
        if not self.state or error.value:
            self.close()
            raise ValueError('audio-resampler-failed')
        self.latency_samples = self.lib.speex_resampler_get_output_latency(self.state)

    def process(self, interleaved):
        if self.state is None:
            raise ValueError('audio-closed')
        if type(interleaved) is not bytes or len(interleaved) != FRAME * 4:
            raise ValueError('audio-frame-invalid')
        values = struct.unpack('<480h', interleaved)
        channels = []
        for channel in range(2):
            source = (C.c_int16 * FRAME)(*values[channel::2])
            output = (C.c_int16 * 320)()
            used, count = C.c_uint32(FRAME), C.c_uint32(320)
            error = self.lib.speex_resampler_process_int(self.state, channel, source, C.byref(used), output, C.byref(count))
            if error or used.value != FRAME or count.value != 160:
                raise ValueError('audio-resampler-failed')
            channels.append(list(output[:count.value]))
        return channels

    def reset(self):
        if self.lib.speex_resampler_reset_mem(self.state):
            raise ValueError('audio-resampler-failed')

    def close(self):
        if self.state:
            self.lib.speex_resampler_destroy(self.state)
        self.state = None


class LocalVqe:
    """Pinned upstream streaming C ABI. Every call consumes exactly one 16 ms hop."""
    def __init__(self, library, model):
        self.ctx = 0
        self.lib = C.CDLL(str(library))
        handle, integer, samples = C.c_size_t, C.c_int, C.POINTER(C.c_int16)
        api = {
            'localvqe_options_new': (handle, []),
            'localvqe_options_free': (None, [handle]),
            'localvqe_options_set_model_path': (integer, [handle, C.c_char_p]),
            'localvqe_options_set_backend': (integer, [handle, C.c_char_p]),
            'localvqe_options_set_threads': (integer, [handle, integer]),
            'localvqe_new_with_options': (handle, [handle]),
            'localvqe_free': (None, [handle]),
            'localvqe_reset': (None, [handle]),
            'localvqe_sample_rate': (integer, [handle]),
            'localvqe_hop_length': (integer, [handle]),
            'localvqe_fft_size': (integer, [handle]),
            'localvqe_set_noise_gate': (integer, [handle, integer, C.c_float]),
            'localvqe_process_frame_s16': (integer, [handle, samples, samples, integer, samples]),
        }
        for name, (result, arguments) in api.items():
            fn = getattr(self.lib, name)
            fn.restype, fn.argtypes = result, arguments
        options = self.lib.localvqe_options_new()
        if not options:
            raise ValueError('audio-allocation-failed')
        try:
            if (self.lib.localvqe_options_set_model_path(options, str(model).encode()) or
                    self.lib.localvqe_options_set_backend(options, b'CPU') or
                    self.lib.localvqe_options_set_threads(options, 1)):
                raise ValueError('audio-config-failed')
            self.ctx = self.lib.localvqe_new_with_options(options)
            if not self.ctx:
                raise ValueError('audio-model-failed')
            if (self.lib.localvqe_sample_rate(self.ctx) != RATE or
                    self.lib.localvqe_hop_length(self.ctx) != 256 or
                    self.lib.localvqe_fft_size(self.ctx) != 512 or
                    self.lib.localvqe_set_noise_gate(self.ctx, 0, -45.0)):
                raise ValueError('audio-config-failed')
            self.process([0] * 256, [0] * 256)
            self.lib.localvqe_reset(self.ctx)
        except BaseException:
            self.close()
            raise
        finally:
            self.lib.localvqe_options_free(options)

    def process(self, mic, reference):
        if not self.ctx:
            raise ValueError('audio-closed')
        if len(mic) != 256 or len(reference) != 256:
            raise ValueError('audio-hop-invalid')
        near = (C.c_int16 * 256)(*mic)
        far = (C.c_int16 * 256)(*reference)
        output = (C.c_int16 * 256)()
        if self.lib.localvqe_process_frame_s16(self.ctx, near, far, 256, output):
            raise ValueError('audio-processing-failed')
        return struct.pack('<256h', *output)

    def reset(self):
        self.lib.localvqe_reset(self.ctx)

    def close(self):
        if self.ctx:
            self.lib.localvqe_free(self.ctx)
        self.ctx = 0


class AudioDsp:
    def __init__(self, resampler_library, aec_library, model):
        self.resampler = self.aec = None
        self.pending = [[], []]
        try:
            self.resampler = StereoResampler(resampler_library)
            self.latency_samples = self.resampler.latency_samples
            self.aec = LocalVqe(aec_library, model)
        except BaseException:
            self.close()
            raise

    def process(self, interleaved):
        if self.resampler is None or self.aec is None:
            raise ValueError('audio-closed')
        for pending, values in zip(self.pending, self.resampler.process(interleaved)):
            pending.extend(values)
        # Each request adds 160 samples/channel; retained samples are <256.
        # Therefore at most one hop is ready and memory is independent of time.
        if len(self.pending[0]) < 256:
            return b''
        output = self.aec.process(self.pending[0][:256], self.pending[1][:256])
        for pending in self.pending:
            del pending[:256]
        return output

    def reset(self):
        self.resampler.reset()
        self.aec.reset()
        for pending in self.pending:
            pending.clear()

    def close(self):
        if self.aec:
            self.aec.close()
        if self.resampler:
            self.resampler.close()
        self.resampler = self.aec = None
        for pending in self.pending:
            pending.clear()


class Silero:
    def __init__(self, model):
        import torch
        self.torch = torch
        torch.set_num_threads(1)
        self.model = torch.jit.load(str(model), map_location='cpu').eval()
        # Warm model before the caller starts device capture. Do not keep this state.
        self.probability(bytes(BLOCK * 2))
        self.reset()

    def reset(self):
        self.model.reset_states()

    def probability(self, pcm):
        if type(pcm) is not bytes or len(pcm) != BLOCK * 2:
            raise ValueError('audio-vad-block-invalid')
        samples = self.torch.tensor(struct.unpack('<512h', pcm), dtype=self.torch.float32) / 32768.0
        with self.torch.inference_mode():
            value = float(self.model(samples, RATE).item())
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('audio-vad-result-invalid')
        return value


class Segmenter:
    """512-sample blocks. Clock is cleaned PCM, including resampler startup delay.

    No implicit flush: disconnect/cancel must discard unfinished speech. Long
    speech is cut without overlap so downstream ASR cannot replay old words.
    """
    def __init__(self, *, onset=0.6, offset=0.35, start_blocks=3, pre_blocks=8,
                 silence_blocks=16, min_blocks=5, max_blocks=625, wait_for_silence=False):
        if not (isinstance(onset, (int, float)) and isinstance(offset, (int, float)) and
                math.isfinite(onset) and math.isfinite(offset) and 0 <= offset < onset <= 1):
            raise ValueError('audio-vad-threshold-invalid')
        counts = (start_blocks, pre_blocks, silence_blocks, min_blocks, max_blocks)
        if any(type(n) is not int or n < 1 for n in counts) or not start_blocks <= pre_blocks < max_blocks <= 937 or min_blocks > max_blocks or silence_blocks >= max_blocks:
            raise ValueError('audio-segment-limit-invalid')
        self.onset, self.offset = onset, offset
        self.start_blocks, self.silence_blocks = start_blocks, silence_blocks
        self.min_blocks, self.max_blocks = min_blocks, max_blocks
        self.pre = deque(maxlen=pre_blocks)
        self.frames = None
        self.samples = self.run = self.voiced = self.silence = 0
        self.continuation = False
        self.wait_for_silence = wait_for_silence

    def push(self, pcm, probability):
        if type(pcm) is not bytes or len(pcm) != BLOCK * 2 or not isinstance(probability, (int, float)) or not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError('audio-segment-input-invalid')
        start = self.samples
        self.samples += BLOCK
        if self.wait_for_silence:
            self.silence = self.silence + 1 if probability < self.offset else 0
            if self.silence >= self.silence_blocks:
                self.wait_for_silence = False
                self.silence = 0
            return None
        if self.frames is None:
            self.pre.append((start, pcm, probability))
            self.run = self.run + 1 if probability >= self.onset else 0
            if self.run < self.start_blocks:
                return None
            self.frames = [entry[1] for entry in self.pre]
            self.start = self.pre[0][0]
            self.voiced = sum(p >= self.offset for _, _, p in self.pre)
            self.silence = 0
            self.pre.clear()
        else:
            self.frames.append(pcm)
            self.voiced += probability >= self.offset
            self.silence = self.silence + 1 if probability < self.offset else 0
        ended = self.silence >= self.silence_blocks
        limited = len(self.frames) >= self.max_blocks
        if not ended and not limited:
            return None
        result = None
        if self.voiced >= self.min_blocks:
            result = {'pcm': b''.join(self.frames), 'sample_start': self.start,
                      'sample_end': self.samples, 'sample_rate': RATE,
                      'reason': 'silence' if ended else 'limit', 'continuation': self.continuation}
        self.frames = None if ended else []
        self.start = self.samples
        self.voiced = self.silence = self.run = 0
        self.continuation = not ended
        return result


class Frontend:
    def __init__(self, directory, aec_v12=False):
        resampler, aec, model, vad_model = verify(directory, aec_v12)
        self.vad = Silero(vad_model)
        self.dsp = AudioDsp(resampler, aec, model)
        self.segmenter = Segmenter()
        self.pending = bytearray()
        self.sequence = 0

    def process(self, sequence, pcm):
        if type(sequence) is not int or sequence != self.sequence or sequence >= MAX_SEQUENCE:
            raise ValueError('audio-sequence-invalid')
        clean = self.dsp.process(pcm)
        self.sequence += 1
        self.pending.extend(clean)
        result = {'type': 'processed', 'sequence': sequence, 'probability': None, 'segment': None}
        # At 10 ms in / 32 ms out, a request produces at most one VAD block.
        if len(self.pending) >= BLOCK * 2:
            block = bytes(self.pending[:BLOCK * 2])
            del self.pending[:BLOCK * 2]
            probability = self.vad.probability(block)
            result['probability'] = probability
            segment = self.segmenter.push(block, probability)
            if segment:
                segment['data'] = base64.b64encode(segment.pop('pcm')).decode('ascii')
                result['segment'] = segment
        return result

    def reset(self):
        self.dsp.reset()
        self.vad.reset()
        self.pending.clear()
        self.segmenter = Segmenter(wait_for_silence=True)
        self.sequence = 0

    def close(self):
        self.dsp.close()
        self.pending.clear()
        self.segmenter = Segmenter()


def run(directory, source, destination, aec_v12=False):
    # Each lease gets a new process and new AEC/VAD state. IPC is ordered and
    # bounded; no threads, audio recording files, network or implicit model hub.
    frontend = Frontend(directory, aec_v12)
    def send(value):
        destination.write(json.dumps(value, separators=(',', ':')) + '\n')
        destination.flush()
    try:
        send({'type': 'ready', 'protocol': 1, 'input_rate': 24000, 'output_rate': RATE,
              'frame_samples': FRAME, 'channels': 2, 'block_samples': BLOCK,
              'resampler_latency_samples': frontend.dsp.latency_samples})
        while True:
            line = source.readline(5201)
            if not line:
                break
            if len(line) > 5200 or not line.endswith('\n'):
                raise ValueError('audio-request-limit')
            request = json.loads(line)
            if isinstance(request, dict) and set(request) == {'reset'} and request['reset'] is True:
                frontend.reset()
                send({'type': 'reset'})
                continue
            if not isinstance(request, dict) or set(request) != {'sequence', 'data'} or type(request['sequence']) is not int:
                raise ValueError('audio-request-invalid')
            data = request['data']
            batch = isinstance(data, list)
            if batch and not 2 <= len(data) <= 4:
                raise ValueError('audio-request-invalid')
            frames = []
            for encoded in data if batch else [data]:
                if not isinstance(encoded, str) or len(encoded) != 1280:
                    raise ValueError('audio-request-invalid')
                pcm = base64.b64decode(encoded, validate=True)
                if base64.b64encode(pcm).decode('ascii') != encoded:
                    raise ValueError('audio-request-invalid')
                frames.append(pcm)
            results = [frontend.process(request['sequence'] + index, pcm) for index, pcm in enumerate(frames)]
            send({'type': 'processed_batch', 'frames': results} if batch else results[0])
    finally:
        frontend.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--aec-v12', action='store_true')
    args = parser.parse_args()
    # Native dependencies can write C stdout diagnostics. Preserve the protocol
    # pipe on a separate FD and route all ordinary/native stdout to stderr.
    import os
    protocol = os.fdopen(os.dup(1), 'w', buffering=1)
    sys.stdout.flush()
    os.dup2(2, 1)
    try:
        run(args.directory.absolute(), sys.stdin, protocol, args.aec_v12)
    except Exception:
        # Protocol errors deliberately contain no speech, paths or traceback.
        print('{"type":"error","code":"audio-frontend-failed"}', file=protocol, flush=True)
        raise SystemExit(1)
