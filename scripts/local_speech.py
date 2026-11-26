"""Owned offline Kokoro worker. stdin/stdout are protocol v1; never opens audio devices."""
import argparse
import base64
import contextlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import socket
import shutil
import stat
import sys

from prepare_voice import MANIFEST, digest

# Optional voices outside the pinned installation manifest, so adding one never
# invalidates an installed environment. Each loads only if its file matches.
EXTRA = MANIFEST.with_name('extra-voices.json')
VOICES = ('', 'zf_001', 'zf_038', 'af_maple')

RATE = 24000
MAX_FRAMES = RATE * 120
REPO = 'hexgrad/Kokoro-82M-v1.1-zh'


def forbid_network(*_args, **_kwargs):
    raise RuntimeError('offline-worker-network-denied')


def offline():
    for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[key] = '1'
    # Defense against implicit Python-side downloads, beyond HF's offline flags.
    # This is not an OS sandbox for arbitrary third-party native code.
    socket.socket.connect = forbid_network
    socket.socket.connect_ex = forbid_network
    socket.create_connection = forbid_network


def verify_assets(directory):
    for item in json.loads(MANIFEST.read_text())['files']:
        if not item['path'].startswith('kokoro/'):
            continue
        path = directory / item['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise ValueError('asset-verification-failed')


def extra_voices(directory):
    found = []
    for item in json.loads(EXTRA.read_text())['voices']:
        path = directory / item['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            continue
        found.append((item['voice'], path))
    return found


def load(directory, runtime_directory=None):
    verify_assets(directory)
    if importlib.util.find_spec('en_core_web_sm') is None:
        raise ValueError('offline-language-model-missing')
    import torch
    from kokoro import KModel, KPipeline
    # Misaki configures the supported phonemizer wrapper on import. Override
    # its data path before any pipeline initializes the native library.
    import misaki.espeak
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    data_path = Path(espeakng_loader.get_data_path()).resolve()
    if len(os.fsencode(data_path)) >= 160:
        if runtime_directory is None:
            raise ValueError('phonemizer-short-directory-required')
        runtime_directory = Path(runtime_directory)
        mode = runtime_directory.lstat()
        if (runtime_directory.is_symlink() or not stat.S_ISDIR(mode.st_mode)
                or mode.st_uid != os.getuid() or mode.st_mode & 0o077):
            raise ValueError('phonemizer-directory-not-private')
        short = runtime_directory.resolve() / 'espeak-ng-data'
        if len(os.fsencode(short)) >= 160:
            raise ValueError('phonemizer-directory-too-long')
        shutil.copytree(data_path, short)
        EspeakWrapper.set_data_path(str(short))
    torch.set_num_threads(4)
    model = KModel(repo_id=REPO, config=str(directory / 'kokoro/config.json'),
                   model=str(directory / 'kokoro/kokoro-v1_1-zh.pth')).to('cpu').eval()
    english = KPipeline(lang_code='a', repo_id=REPO, model=model)
    if english.g2p.fallback is None:
        raise ValueError('offline-phonemizer-missing')
    chinese = KPipeline(lang_code='z', repo_id=REPO, model=model,
                        en_callable=lambda text: english.g2p(text)[0])
    voices = {name: torch.load(directory / f'kokoro/voices/{name}.pt',
                              map_location='cpu', weights_only=True)
              for name in ('zf_001', 'af_maple')}
    for name, path in extra_voices(directory):
        voices[name] = torch.load(path, map_location='cpu', weights_only=True)
    return {'en': english, 'zh': chinese}, voices


def request_fields(request):
    if not isinstance(request, dict) or set(request) != {'request_id', 'text', 'language', 'voice', 'speed'}:
        raise ValueError('invalid-request')
    identifier, text = request['request_id'], request['text']
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f-]{36}', identifier):
        raise ValueError('invalid-request')
    if not isinstance(text, str) or not text.strip() or len(text.encode('utf-16-le')) > 16000:
        raise ValueError('invalid-request')
    language, voice, speed = request['language'], request['voice'], request['speed']
    if language not in ('auto', 'zh', 'en') or voice not in VOICES:
        raise ValueError('invalid-request')
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not 0.5 <= speed <= 2:
        raise ValueError('invalid-request')
    if language == 'auto':
        language = 'zh' if re.search(r'[\u3400-\u9fff]', text) else 'en'
    voice = voice or ('zf_001' if language == 'zh' else 'af_maple')
    return identifier, text, language, voice, speed


def synthesize(request, pipelines, voices, send):
    import numpy as np
    import torch
    identifier, text, language, voice, speed = request_fields(request)
    if request['voice'] == '' and language == 'zh' and 'zf_038' in voices:
        voice = 'zf_038'  # The owner's chosen Chinese voice, when installed.
    if voice not in voices:
        voice = 'zf_001' if language == 'zh' else 'af_maple'  # Optional voice not installed.
    sequence, frames = 0, 0
    with torch.inference_mode():
        for result in pipelines[language](text, voice=voices[voice], speed=speed):
            if result.audio is None:
                raise ValueError('missing-audio')
            samples = result.audio.detach().cpu().numpy().reshape(-1)
            if not np.isfinite(samples).all() or frames + len(samples) > MAX_FRAMES:
                raise ValueError('invalid-audio')
            pcm = np.clip(np.rint(samples * 32768), -32768, 32767).astype('<i2').tobytes()
            for offset in range(0, len(pcm), 24000):
                chunk = pcm[offset:offset + 24000]
                send({'type': 'pcm', 'request_id': identifier, 'sequence': sequence,
                      'data': base64.b64encode(chunk).decode('ascii')})
                sequence += 1
            frames += len(samples)
    if frames == 0:
        raise ValueError('empty-audio')
    send({'type': 'done', 'request_id': identifier, 'frames': frames})


def run(directory, runtime_directory=None):
    protocol = sys.stdout

    def send(message):
        protocol.write(json.dumps(message, separators=(',', ':'), allow_nan=False) + '\n')
        protocol.flush()  # Pipe backpressure bounds output while the consumer pauses.

    offline()
    # Third-party progress and G2P diagnostics never contaminate protocol stdout.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            pipelines, voices = load(directory, runtime_directory)
        except Exception:
            send({'type': 'error', 'code': 'speech-startup-failed'})
            return 1
        send({'type': 'ready', 'protocol': 1, 'rate': RATE, 'channels': 1})
        while True:
            line = sys.stdin.buffer.readline(65538)
            if not line:
                return 0
            request = None
            try:
                if len(line) > 65537 or not line.endswith(b'\n'):
                    raise ValueError('request-too-large')
                request = json.loads(line.decode('utf-8'))
                request_fields(request)
                synthesize(request, pipelines, voices, send)
            except Exception:
                identifier = request.get('request_id') if isinstance(request, dict) else None
                if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f-]{36}', identifier):
                    identifier = None
                send({'type': 'error', 'request_id': identifier, 'code': 'speech-synthesis-failed'})
                # No reuse after partially emitted or malformed output.
                return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--runtime-directory', type=Path)
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.assets.absolute(), args.runtime_directory))
    except BrokenPipeError:
        raise SystemExit(1)
