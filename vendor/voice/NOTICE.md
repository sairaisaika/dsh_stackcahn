# Local speech inputs

These are optional, separately prepared runtime components. No model binary is
committed and the plugin does not download a model on import or while speaking.
The fixed asset URLs, lengths and SHA256 values are authoritative in assets.json.

* whisper.cpp v1.9.5, commit d1be6fde11ac6e0407606b4e42fe72d34add8037:
  https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037
  MIT. Preserve its LICENSE with any redistributed binary. GGML small-q5_1 derives
  from OpenAI Whisper (MIT); model source is the pinned ggerganov/whisper.cpp asset.
* Kokoro Python 0.9.4: Apache-2.0; model Kokoro-82M-v1.1-zh and included zf_001 /
  af_maple voices: Apache-2.0, model revision 01e7505bd6a7a2ac4975463114c3a7650a9f7218.
  https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/01e7505bd6a7a2ac4975463114c3a7650a9f7218
  These voices do not reproduce the factory assistant voice or clone the user.
* Misaki 0.9.4: Apache-2.0; spaCy/en_core_web_sm: MIT. The locked environment also
  includes espeakng-loader and its bundled eSpeak NG phonemizer (GPL-3.0).
  Installation is private and separate; a redistributable environment requires
  the corresponding third-party notices/source obligations, not just this file.

requirements-macos-arm64.lock pins the Python 3.11 speech environment with hashes.
It does not bundle Python, whisper-cli, models, as binaries. The packaged installer builds a private environment. Versions of
transitive packages and their installed license metadata remain in that environment.
Downloaded models can run locally without a per-request speech API fee. Compute,
storage and the user's DSH model service are separate resources.

Installer inputs (explicit owner operation only): installer-assets.json pins the
whisper.cpp source archive and hash. The private build preserves its root MIT
LICENSE (Copyright 2023-2026 The ggml authors); this archive has no separate
ggml/LICENSE. build-tools.lock pins CMake 4.1.2 (official macOS universal2
wheel), wheel 0.45.1 and the speech lock's setuptools/packaging versions; their
installed distribution license metadata remains in the private environment.
Only hash-pinned jieba 0.42.1 and docopt 0.6.2 use sdists; build dependency isolation/resolution
is disabled and the fixed build tools are installed first. No global pip install.
