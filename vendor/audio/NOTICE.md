# Input audio dependencies

- SpeexDSP 1.2.1, Xiph.org and contributors: BSD-3-Clause. The pinned official
  release archive is listed in assets.json; full copyright and license text is
  preserved in speexdsp-COPYING. The installer builds the unmodified library
  privately. This is the DSP library, not the Speex voice codec.
- LocalVQE v1.2 and v1.3, LocalAI team: Apache-2.0 code/models. Source commit
  7f61cd05095d42e56a135b303f5bb4d761da22b9 and model revision
  29ca38495cba9d6393a92a4dd890f28dd81f758d are fixed in assets.json and aec-v12.json.
  Preserve localvqe-LICENSE. Uses the upstream streaming C API with CPU inference;
  the upstream GRU patch is applied to its exact GGML dependency during the build.
- GGML commit c044a8eeae2591faa0950c8b5e514cbc4bbfc4ca: MIT; preserve
  ggml-LICENSE. The native libraries are built locally, never loaded from an
  unpinned binary download. Speex is now used only for resampling, not cascaded AEC.
- Silero VAD v6.2.3, Silero Team: MIT. Model and license are fixed to commit
  5cd7945676eb32225748052e2e6a0580e4686a08; full license in silero-LICENSE.
- Model inference uses the existing pinned Torch environment documented under
  vendor/voice. No additional pip install, model hub or cloud speech service is
  required during inference. Those dependencies retain their own licenses.

Native library and model binaries are downloaded/built in an ignored private
runtime, not committed here. These notices must accompany future distributions;
the current development installer is not a signed consumer distribution.
