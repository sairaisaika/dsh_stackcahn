// SPDX-License-Identifier: MIT
#pragma once
#include "session_lifecycle.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <mutex>

namespace sion::agent {
constexpr size_t kAudioSamples = 240;  // 10 ms per channel at 24 kHz
constexpr size_t kAudioQueueFrames = 20;
constexpr int kAudioRate = 24000;
using InputPcm = std::array<int16_t, kAudioSamples * 2>; // mic, reference interleaved
using OutputPcm = std::array<int16_t, kAudioSamples>;
struct InputFrame { uint64_t epoch = 0, sequence = 0, read_started_us = 0; InputPcm pcm{}; };
struct OutputFrame { uint64_t epoch = 0, sequence = 0; OutputPcm pcm{}; };
enum class AudioPhase { Idle, Opening, Running, Closing, Fault };
enum class AudioError { None, Open, Read, Write, InputOverflow, Close, SequenceExhausted, Volume, PlaybackFence };
enum class PlaybackPhase { None, Requested, Waiting, Done };
enum class AudioPush { Accepted, Backpressure, Stale, OutOfOrder };
struct AudioStatus {
    AudioPhase phase; AudioError error; uint64_t epoch; size_t input_depth, output_depth;
    int requested_volume, applied_volume; bool capture_allowed; uint64_t output_written, output_received;
    uint64_t output_at_ms;
    uint8_t output_level;
    uint8_t input_level;   // Microphone peak of the latest frame, 0..31
};

// Calls belong exclusively to the I/O task. Close includes amplifier/channel
// shutdown and DMA clearing; success is stronger than dropping software queues.
struct AudioPort {
    virtual ~AudioPort() = default;
    virtual bool Open(int volume) = 0;
    virtual bool Volume(int volume) = 0;
    virtual bool Read(InputPcm& pcm) = 0;
    virtual bool Write(const OutputPcm& pcm) = 0;
    // Begin/Poll is nonblocking and belongs to the same I/O worker as Write.
    // Unsupported ports fail explicitly rather than reporting pretend drain.
    virtual Result PlaybackFence(bool /*begin*/, bool /*discard*/) { return Result::Failed; }
    virtual bool Close() = 0;
};

template<class T, size_t N> class AudioRing {
public:
    bool Push(const T& item) {
        if (size_ == N) return false;
        values_[(head_ + size_) % N] = item;
        ++size_; return true;
    }
    bool Pop(T& item) {
        if (!size_) return false;
        item = values_[head_]; head_ = (head_ + 1) % N; --size_; return true;
    }
    void Clear() { head_ = size_ = 0; }
    size_t size() const { return size_; }
private:
    std::array<T, N> values_{};
    size_t head_ = 0, size_ = 0;
};

class AudioEngine {
public:
    explicit AudioEngine(AudioPort& port) : port_(port) {}
    bool Begin(uint64_t epoch) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!capture_allowed_ || phase_ != AudioPhase::Idle || epoch <= epoch_) return false;
        epoch_ = epoch;
        input_sequence_ = output_sequence_ = output_written_ = 0;
        playback_phase_ = PlaybackPhase::None;
        error_ = AudioError::None;
        phase_ = AudioPhase::Opening;
        return true;
    }
    void SetVolume(int volume) {
        std::lock_guard<std::mutex> lock(mutex_);
        requested_volume_ = volume < 0 ? 0 : volume > 100 ? 100 : volume;
    }
    void AllowCapture(bool allowed) {
        std::lock_guard<std::mutex> lock(mutex_);
        capture_allowed_ = allowed;
        if (!allowed) {
            input_.Clear(); output_.Clear();
            if (phase_ != AudioPhase::Idle) phase_ = AudioPhase::Closing;
        }
    }
    void Stop(uint64_t fence) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (fence < epoch_) return;
        epoch_ = fence;
        input_.Clear(); output_.Clear();
        if (phase_ != AudioPhase::Idle) phase_ = AudioPhase::Closing;
    }
    Result Stopped(uint64_t fence) const {
        std::lock_guard<std::mutex> lock(mutex_);
        if (fence != epoch_) return Result::Pending;
        if (phase_ == AudioPhase::Fault) return Result::Failed;
        return phase_ == AudioPhase::Idle ? Result::Done : Result::Pending;
    }
    AudioStatus status() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return {phase_, error_, epoch_, input_.size(), output_.size(), requested_volume_, applied_volume_, capture_allowed_,
                output_written_, output_sequence_, output_at_ms_, output_level_, input_level_};
    }
    AudioPush Push(const OutputFrame& frame) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (phase_ != AudioPhase::Running || frame.epoch != epoch_) return AudioPush::Stale;
        if (playback_phase_ == PlaybackPhase::Requested || playback_phase_ == PlaybackPhase::Waiting)
            return AudioPush::Backpressure;
        if (frame.sequence != output_sequence_ || output_sequence_ == std::numeric_limits<uint64_t>::max())
            return AudioPush::OutOfOrder;
        if (!output_.Push(frame)) return AudioPush::Backpressure;
        ++output_sequence_;
        return AudioPush::Accepted;
    }
    bool RequestPlaybackFence(uint64_t epoch, bool discard) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!Current(epoch, AudioPhase::Running) || playback_phase_ == PlaybackPhase::Requested ||
            playback_phase_ == PlaybackPhase::Waiting) return false;
        playback_phase_ = PlaybackPhase::Requested;
        playback_discard_ = discard;
        if (discard) output_.Clear();
        return true;
    }
    Result PlaybackFenceStatus(uint64_t epoch) const {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!Current(epoch, AudioPhase::Running)) return Result::Failed;
        return playback_phase_ == PlaybackPhase::Done ? Result::Done : Result::Pending;
    }
    bool TakeInput(uint64_t epoch, InputFrame& frame) {
        std::lock_guard<std::mutex> lock(mutex_);
        return phase_ == AudioPhase::Running && epoch == epoch_ && input_.Pop(frame);
    }

    // Exactly one worker invokes Pump. Control methods may run concurrently.
    // No driver operation holds mutex_, so Stop never waits behind I/O.
    void Pump(uint64_t now_us) {
        AudioPhase phase;
        uint64_t epoch;
        int volume, applied;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            phase = phase_; epoch = epoch_; volume = requested_volume_; applied = applied_volume_;
        }
        if (phase == AudioPhase::Idle || phase == AudioPhase::Fault) return;
        if (phase == AudioPhase::Closing) {
            const bool ok = !owns_port_ || port_.Close();
            if (ok) owns_port_ = false;
            std::lock_guard<std::mutex> lock(mutex_);
            // A newer Stop also waits for this same physical close.
            phase_ = ok ? AudioPhase::Idle : AudioPhase::Fault;
            applied_volume_ = -1;
            if (!ok) error_ = AudioError::Close;
            return;
        }
        if (phase == AudioPhase::Opening) {
            owns_port_ = true; // Failed Open may have partially acquired hardware.
            const bool ok = port_.Open(volume);
            std::lock_guard<std::mutex> lock(mutex_);
            if (!Current(epoch, AudioPhase::Opening)) return;
            phase_ = ok ? AudioPhase::Running : AudioPhase::Closing;
            applied_volume_ = ok ? volume : -1;
            if (!ok) error_ = AudioError::Open;
            return;
        }

        if (volume != applied) {
            const bool ok = port_.Volume(volume);
            std::lock_guard<std::mutex> lock(mutex_);
            if (!Current(epoch, AudioPhase::Running)) return;
            if (!ok) { Fail(AudioError::Volume); return; }
            applied_volume_ = volume;
        }
        InputFrame input;
        input.epoch = epoch; input.read_started_us = now_us;
        const bool read_ok = port_.Read(input.pcm);
        uint8_t input_peak = 0;
        if (read_ok) {
            int peak = 0;
            for (int sample : input.pcm) {
                const int level = sample < 0 ? -sample : sample;
                if (level > peak) peak = level;
            }
            input_peak = static_cast<uint8_t>(peak / 1024);
        }
        OutputFrame output;
        bool have_output = false;
        bool fence = false, begin_fence = false, discard = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!Current(epoch, AudioPhase::Running)) return;
            if (!read_ok) { Fail(AudioError::Read); return; }
            if (input_sequence_ == std::numeric_limits<uint64_t>::max()) {
                Fail(AudioError::SequenceExhausted); return;
            }
            input.sequence = input_sequence_++;
            input_level_ = input_peak;
            if (!input_.Push(input)) { Fail(AudioError::InputOverflow); return; }
            have_output = output_.Pop(output);
            if (!have_output && (playback_phase_ == PlaybackPhase::Requested || playback_phase_ == PlaybackPhase::Waiting)) {
                fence = true; begin_fence = playback_phase_ == PlaybackPhase::Requested;
                if (begin_fence) playback_started_us_ = now_us;
                else if (now_us < playback_started_us_ || now_us - playback_started_us_ >= 2000000) {
                    Fail(AudioError::PlaybackFence); return;
                }
                discard = playback_discard_; playback_phase_ = PlaybackPhase::Waiting;
            }
        }
        // A Stop may occur just after this check; that one in-flight write is
        // covered by Pending until the next Pump closes and clears the DMA.
        if (have_output) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!Current(epoch, AudioPhase::Running)) return;
            }
            const bool ok = port_.Write(output.pcm);
            int peak = 0;
            if (ok) {
                for (int sample : output.pcm) {
                    const int level = sample < 0 ? -sample : sample;
                    if (level > peak) peak = level;
                }
            }
            std::lock_guard<std::mutex> lock(mutex_);
            if (Current(epoch, AudioPhase::Running)) {
                if (!ok) Fail(AudioError::Write);
                // Sequence watermark, not a count across discarded gaps. A future
                // wire interrupt consumer must retire discarded credits separately.
                else {
                    output_written_ = output.sequence + 1;
                    output_at_ms_ = now_us / 1000;
                    output_level_ = static_cast<uint8_t>(peak / 1024);
                }
            }
        }
        if (fence) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!Current(epoch, AudioPhase::Running)) return;
            }
            const auto result = port_.PlaybackFence(begin_fence, discard);
            std::lock_guard<std::mutex> lock(mutex_);
            if (!Current(epoch, AudioPhase::Running)) return;
            if (result == Result::Failed) Fail(AudioError::PlaybackFence);
            else if (result == Result::Done) playback_phase_ = PlaybackPhase::Done;
        }
    }
private:
    AudioPort& port_;
    mutable std::mutex mutex_;
    AudioPhase phase_ = AudioPhase::Idle;
    AudioError error_ = AudioError::None;
    uint64_t epoch_ = 0, input_sequence_ = 0, output_sequence_ = 0, output_written_ = 0;
    uint64_t output_at_ms_ = 0;
    uint8_t output_level_ = 0;
    uint8_t input_level_ = 0;
    int requested_volume_ = 0, applied_volume_ = -1;
    bool capture_allowed_ = true;
    bool owns_port_ = false; // I/O worker only
    PlaybackPhase playback_phase_ = PlaybackPhase::None;
    uint64_t playback_started_us_ = 0;
    bool playback_discard_ = false;
    AudioRing<InputFrame, kAudioQueueFrames> input_;
    AudioRing<OutputFrame, kAudioQueueFrames> output_;
    bool Current(uint64_t epoch, AudioPhase phase) const { return epoch == epoch_ && phase == phase_; }
    void Fail(AudioError error) { error_ = error; phase_ = AudioPhase::Closing; input_.Clear(); output_.Clear(); }
};
} // namespace sion::agent
