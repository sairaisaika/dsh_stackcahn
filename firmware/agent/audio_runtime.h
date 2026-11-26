// SPDX-License-Identifier: MIT
#pragma once
#include "audio_engine.h"

namespace sion::agent {
// Worker startup allocates no codec and does not turn on the microphone. Only
// an authenticated owner's later engine().Begin(epoch) can acquire hardware.
AudioEngine& DeviceAudio();
bool StartAudioWorker(); // application owner task only, idempotent
}
