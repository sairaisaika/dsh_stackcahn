// SPDX-License-Identifier: MIT
// Compile the actual bridge implementation against injectable SDK functions.
#include "core_audio_bridge.cc"
#include <cassert>
#include <algorithm>
#include <iostream>
#include <limits>

namespace {
int codec_error = 0, io_error = 0, disable_error = 0, preload_error = 0, mute_error = 0, info_error = 0;
bool muted = false;
bool short_io = false, tx_running = true;
bool overflow_read = false;
i2s_event_callbacks_t events{};
i2s_event_callbacks_t tx_events{};
void* event_context = nullptr;
size_t dma_capacity = 11520, remaining = 11520, cleared = 0;
int opens = 0, settings_reads = 0, volume = 0;
std::array<int32_t, 240> written{};
void reset() {
    codec_error = io_error = disable_error = preload_error = mute_error = info_error = 0;
    muted = false; tx_events = {};
    short_io = false; tx_running = true;
    dma_capacity = remaining = 11520; cleared = 0;
    opens = settings_reads = volume = 0;
    overflow_read = false; events = {}; event_context = nullptr;
}
int enable(const audio_codec_if_t*, bool value) { assert(!value); return codec_error; }
audio_codec_if_t interface{enable};
}
CoreS3AudioCodec::CoreS3AudioCodec() { out_codec_if_ = in_codec_if_ = &interface; }
void CoreS3AudioCodec::Start() { ++settings_reads; }
int i2s_channel_register_event_callback(int channel, const i2s_event_callbacks_t* value, void* context) {
    assert(channel == 1 || channel == 2);
    if (channel == 2) events = *value; else tx_events = *value;
    event_context = context; return 0;
}
int i2s_channel_get_info(int channel,i2s_chan_info_t* info) {
    assert(channel == 1);info->is_enabled=tx_running;info->total_dma_buf_size=dma_capacity;return info_error;
}
int esp_codec_dev_set_out_mute(void* device,bool value) {
    assert(device==reinterpret_cast<void*>(4));if(mute_error)return mute_error;muted=value;return 0;
}
void sent(size_t bytes=1920) {
    i2s_event_data_t event{reinterpret_cast<void*>(5),bytes};
    assert(tx_events.on_sent);tx_events.on_sent(1,&event,event_context);
}
int esp_codec_dev_open(void* device, esp_codec_dev_sample_info_t* format) {
    ++opens; assert(format->sample_rate == 24000);
    if (device == reinterpret_cast<void*>(3)) {
        assert(format->bits_per_sample == 16 && format->channel == 4 && format->channel_mask == 3);
    } else {
        assert(format->bits_per_sample == 32 && format->channel == 1);
        tx_running = true; remaining = dma_capacity;
    }
    return codec_error;
}
int esp_codec_dev_set_in_channel_gain(void*, int mask, float) { assert(mask == 1); return codec_error; }
int esp_codec_dev_set_out_vol(void*, int value) { volume = value; return codec_error; }
int esp_codec_dev_close(void*) { return ESP_CODEC_DEV_OK; } // Real SDK hides disable errors.
int i2s_channel_disable(int channel) {
    if (disable_error) return disable_error;
    if (channel == 1) {
        if (!tx_running) return ESP_ERR_INVALID_STATE;
        tx_running = false; remaining = dma_capacity;
    }
    return ESP_OK;
}
int i2s_channel_preload_data(int channel, const void* buffer, size_t length, size_t* loaded) {
    assert(channel == 1);
    if (preload_error || tx_running) return -1;
    const auto* bytes = static_cast<const unsigned char*>(buffer);
    for (size_t i = 0; i < length; ++i) assert(bytes[i] == 0);
    *loaded = std::min(length, remaining); remaining -= *loaded; cleared += *loaded;
    return ESP_OK;
}
int i2s_channel_read(int channel, void* pcm, size_t size, size_t* done, unsigned timeout) {
    assert(channel == 2 && timeout == 50 && size == 960);
    static_cast<int16_t*>(pcm)[0] = 77;
    if (overflow_read) events.on_recv_q_ovf(channel, nullptr, event_context);
    *done = short_io ? size - 2 : size;
    return io_error;
}
int i2s_channel_write(int channel, const void* pcm, size_t size, size_t* done, unsigned timeout) {
    assert(channel == 1 && timeout == 50 && size == 960);
    std::copy_n(static_cast<const int32_t*>(pcm), 240, written.begin());
    *done = short_io ? size - 4 : size;
    return io_error;
}
void playback_fences() {
    reset();CoreS3AudioCodec codec;
    assert(codec.AgentOpen(40));
    sion::agent::OutputPcm out{};sion::agent::InputPcm input{};
    assert(codec.AgentWrite(out.data(),out.size()));
    sent(); // Prior DMA progress must not satisfy a new fence.
    assert(codec.AgentBeginPlaybackFence(false));assert(!muted);
    assert(!codec.AgentBeginPlaybackFence(false));
    assert(!codec.AgentWrite(out.data(),out.size()));
    for(int i=0;i<11;++i){sent();assert(codec.AgentPollPlaybackFence()==0);}
    assert(codec.AgentRead(input.data(),input.size())); // capture is never closed
    sent();assert(codec.AgentPollPlaybackFence()==1);assert(!muted);
    assert(codec.AgentWrite(out.data(),out.size()));
    assert(codec.AgentBeginPlaybackFence(true));assert(muted);
    for(int i=0;i<12;++i)sent();
    mute_error=-1;assert(codec.AgentPollPlaybackFence()==-1 && muted);
    mute_error=0;assert(codec.AgentPollPlaybackFence()==1 && !muted);
    assert(codec.AgentClose());assert(codec.AgentPollPlaybackFence()==-1);
    assert(codec.AgentOpen(0));
    mute_error=-1;assert(!codec.AgentBeginPlaybackFence(true));mute_error=0;
    info_error=-1;assert(!codec.AgentBeginPlaybackFence(false));info_error=0;
    dma_capacity=0;assert(!codec.AgentBeginPlaybackFence(false));dma_capacity=11520;
    assert(codec.AgentBeginPlaybackFence(false));sent(4093);assert(codec.AgentPollPlaybackFence()==-1);
    assert(codec.AgentClose());assert(codec.AgentOpen(10));
    codec.agent_tx_bytes_=std::numeric_limits<uint64_t>::max()-10;
    assert(!codec.AgentBeginPlaybackFence(false));sent();assert(codec.agent_tx_fault_);
    assert(codec.AgentClose());
}
int main() {
    playback_fences();
    reset(); CoreS3AudioCodec codec;
    assert(codec.AgentOpen(0) && settings_reads == 0 && volume == 0 && opens == 2);
    assert(cleared == 11520);
    sion::agent::InputPcm input{};
    sion::agent::OutputPcm output{}; output[0] = -32768; output[1] = 32767;
    assert(codec.AgentRead(input.data(), input.size()) && input[0] == 77);
    assert(codec.AgentWrite(output.data(), output.size()));
    assert(written[0] == std::numeric_limits<int32_t>::min() && written[1] == 2147418112);
    short_io = true;
    assert(!codec.AgentRead(input.data(), input.size()) && !codec.AgentWrite(output.data(), output.size()));
    short_io = false; io_error = -1;
    assert(!codec.AgentRead(input.data(), input.size()) && !codec.AgentWrite(output.data(), output.size()));
    io_error = 0; overflow_read = true;
    assert(!codec.AgentRead(input.data(), input.size()));
    overflow_read = false;
    assert(!codec.AgentRead(input.data(), input.size())); // Fault latches until re-open.
    assert(codec.AgentClose() && !tx_running && remaining == 0 && cleared == 23040);
    assert(!codec.AgentRead(input.data(), input.size()) && !codec.AgentWrite(output.data(), output.size()));
    assert(codec.AgentClose()); // Idempotent close of already stopped hardware.
    assert(codec.AgentOpen(1000) && volume == 100);
    assert(codec.AgentRead(input.data(), input.size()));
    assert(codec.AgentVolume(0) && volume == 0);
    codec_error = -1; assert(!codec.AgentVolume(50)); codec_error = 0;
    assert(codec.output_volume_ == 0);
    assert(codec.AgentClose()); assert(!codec.AgentVolume(50));
    for (int kind = 0; kind < 4; ++kind) {
        reset(); CoreS3AudioCodec faulty;
        if (kind == 0) codec_error = -1;
        if (kind == 1) disable_error = -1;
        if (kind == 2) preload_error = -1;
        if (kind == 3) dma_capacity = remaining = 1024 * 1024;
        assert(!faulty.AgentClose());
    }
    std::cout << "CoreS3 bridge passed: format, mute, PCM extrema, short/error/overflow I/O, disable errors and DMA clearing\n";
}
