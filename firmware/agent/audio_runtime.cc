// SPDX-License-Identifier: MIT
#include "audio_runtime.h"
#include "device_trace.h"
#include <board.h>
#include <cores3_audio_codec.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_timer.h>

namespace sion::agent {
namespace {
namespace trace = diagnostics;
using trace::Event;
using trace::Lane;
class CorePort final : public AudioPort {
public:
    bool Open(int volume) override {
        trace::Record(Lane::Audio,Event::AudioOpening);
        trace::Checkpoint(Lane::Audio,Event::AudioOpening);
        codec_ = dynamic_cast<CoreS3AudioCodec*>(Board::GetInstance().GetAudioCodec());
        const bool ok=codec_ && codec_->AgentOpen(volume);
        trace::Record(Lane::Audio,Event::AudioOpened,ok);
        return ok;
    }
    bool Volume(int volume) override {
        trace::Checkpoint(Lane::Audio,Event::AudioVolume);
        return codec_ && codec_->AgentVolume(volume);
    }
    bool Read(InputPcm& pcm) override {
        trace::Checkpoint(Lane::Audio,Event::AudioReading);
        return codec_ && codec_->AgentRead(pcm.data(), pcm.size());
    }
    bool Write(const OutputPcm& pcm) override {
        trace::Checkpoint(Lane::Audio,Event::AudioWriting);
        return codec_ && codec_->AgentWrite(pcm.data(), pcm.size());
    }
    Result PlaybackFence(bool begin, bool discard) override {
        trace::Checkpoint(Lane::Audio,Event::AudioPlaybackFence,uint32_t(begin)|(uint32_t(discard)<<1));
        if (!codec_ || (begin && !codec_->AgentBeginPlaybackFence(discard))) return Result::Failed;
        const int result = codec_->AgentPollPlaybackFence();
        return result < 0 ? Result::Failed : result == 0 ? Result::Pending : Result::Done;
    }
    bool Close() override {
        trace::Record(Lane::Audio,Event::AudioClosing);
        trace::Checkpoint(Lane::Audio,Event::AudioClosing);
        const bool ok=!codec_ || codec_->AgentClose();
        trace::Record(Lane::Audio,Event::AudioClosed,ok);
        trace::Checkpoint(Lane::Audio,Event::AudioClosed,ok);
        return ok;
    }
private:
    CoreS3AudioCodec* codec_ = nullptr;
};
CorePort port;
AudioEngine engine(port);
TaskHandle_t worker = nullptr;
}
AudioEngine& DeviceAudio() { return engine; }
bool StartAudioWorker() {
    if (worker) return true;
    return xTaskCreate([](void*) {
        auto last_error=AudioError::None;
        while (true) {
            engine.Pump(static_cast<uint64_t>(esp_timer_get_time()));
            // Running reads are clocked by I2S. An extra scheduler tick per
            // 10 ms frame would undersample on the default 100 Hz RTOS tick.
            const auto status=engine.status();
            if (status.error!=last_error) {
                last_error=status.error;
                trace::Record(Lane::Audio,Event::AudioError,static_cast<uint32_t>(last_error));
            }
            if (status.phase != AudioPhase::Running) {
                const TickType_t delay = pdMS_TO_TICKS(10);
                vTaskDelay(delay ? delay : 1);
            }
        }
    }, "sion_audio", 8192, nullptr, 5, &worker) == pdPASS;
}
}
