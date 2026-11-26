// SPDX-License-Identifier: MIT
// Extends the pinned Xiaozhi CoreS3 codec; original driver and its MIT notices
// remain in the prepared checkout. Configuration follows that board's codec.
#include <cores3_audio_codec.h>
#include "audio_engine.h"
#include <driver/i2s_common.h>
#include <esp_attr.h>
#include <algorithm>
#include <limits>

bool IRAM_ATTR CoreS3AudioCodec::AgentSent(i2s_chan_handle_t, i2s_event_data_t* event, void* context) {
    auto* codec = static_cast<CoreS3AudioCodec*>(context);
    portENTER_CRITICAL_ISR(&codec->agent_rx_mux_);
    if (!event || !event->dma_buf || !event->size || event->size > 4092 ||
        codec->agent_tx_bytes_ > std::numeric_limits<uint64_t>::max() - event->size) {
        codec->agent_tx_fault_ = true;
    } else codec->agent_tx_bytes_ += event->size;
    portEXIT_CRITICAL_ISR(&codec->agent_rx_mux_);
    return false;
}

bool CoreS3AudioCodec::AgentBeginPlaybackFence(bool discard) {
    if (!output_enabled_ || agent_tx_fencing_) return false;
    i2s_chan_info_t info{};
    if (i2s_channel_get_info(tx_handle_, &info) != ESP_OK || !info.is_enabled ||
        !info.total_dma_buf_size || info.total_dma_buf_size > 32 * 4092) return false;
    // Only the output codec is muted; RX remains clocked and continues Read.
    if (discard && esp_codec_dev_set_out_mute(output_dev_, true) != ESP_CODEC_DEV_OK) return false;
    agent_tx_muted_ = discard;
    portENTER_CRITICAL(&agent_rx_mux_);
    const uint64_t distance = static_cast<uint64_t>(info.total_dma_buf_size) * 2;
    const bool ok = !agent_tx_fault_ && agent_tx_bytes_ <= std::numeric_limits<uint64_t>::max() - distance;
    if (ok) agent_tx_fence_ = agent_tx_bytes_ + distance;
    portEXIT_CRITICAL(&agent_rx_mux_);
    agent_tx_fencing_ = ok;
    return ok;
}

int CoreS3AudioCodec::AgentPollPlaybackFence() {
    if (!output_enabled_ || !agent_tx_fencing_) return -1;
    portENTER_CRITICAL(&agent_rx_mux_);
    const bool failed = agent_tx_fault_;
    const bool done = agent_tx_bytes_ >= agent_tx_fence_;
    portEXIT_CRITICAL(&agent_rx_mux_);
    if (failed) return -1;
    if (!done) return 0;
    // Two actual DMA rotations after the final write, with the pinned driver's
    // auto_clear_after_cb=true, also advance zero data past the TX FIFO.
    // This is a digital-output fence, not a room-acoustics measurement.
    if (agent_tx_muted_ && esp_codec_dev_set_out_mute(output_dev_, false) != ESP_CODEC_DEV_OK) return -1;
    agent_tx_muted_ = agent_tx_fencing_ = false;
    return 1;
}

bool IRAM_ATTR CoreS3AudioCodec::AgentReceiveOverflow(i2s_chan_handle_t, i2s_event_data_t*, void* context) {
    auto* codec = static_cast<CoreS3AudioCodec*>(context);
    portENTER_CRITICAL_ISR(&codec->agent_rx_mux_);
    codec->agent_rx_overflow_ = true;
    portEXIT_CRITICAL_ISR(&codec->agent_rx_mux_);
    return false;
}
bool CoreS3AudioCodec::AgentRxOverflowed() {
    portENTER_CRITICAL(&agent_rx_mux_);
    const bool overflowed = agent_rx_overflow_;
    portEXIT_CRITICAL(&agent_rx_mux_);
    return overflowed;
}

bool CoreS3AudioCodec::AgentOpen(int volume) {
    using namespace sion::agent;
    if (input_sample_rate_ != kAudioRate || output_sample_rate_ != kAudioRate || input_channels_ != 2)
        return false;
    if (!AgentClose()) return false;
    output_volume_ = std::clamp(volume, 0, 100); // DSH preference; no factory NVS writes.
    portENTER_CRITICAL(&agent_rx_mux_);
    agent_rx_overflow_ = false;
    agent_tx_bytes_ = agent_tx_fence_ = 0; agent_tx_fault_ = false;
    portEXIT_CRITICAL(&agent_rx_mux_);
    i2s_event_callbacks_t callbacks{};
    callbacks.on_recv_q_ovf = AgentReceiveOverflow;
    if (i2s_channel_register_event_callback(rx_handle_, &callbacks, this) != ESP_OK) return false;
    i2s_event_callbacks_t tx_callbacks{};
    tx_callbacks.on_sent = AgentSent;
    if (i2s_channel_register_event_callback(tx_handle_, &tx_callbacks, this) != ESP_OK) return false;
    esp_codec_dev_sample_info_t input = {};
    input.bits_per_sample = 16; input.channel = 4;
    input.channel_mask = ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0) | ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1);
    input.sample_rate = kAudioRate;
    esp_codec_dev_sample_info_t output = {};
    output.bits_per_sample = 32; output.channel = 1; output.sample_rate = kAudioRate;
    if (esp_codec_dev_open(input_dev_, &input) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_set_in_channel_gain(input_dev_, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0), input_gain_) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_open(output_dev_, &output) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_set_out_vol(output_dev_, output_volume_) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_set_out_mute(output_dev_, false) != ESP_CODEC_DEV_OK) return false;
    input_enabled_ = output_enabled_ = true;
    return true;
}

bool CoreS3AudioCodec::AgentVolume(int volume) {
    if (!output_enabled_) return false;
    const int next = std::clamp(volume, 0, 100);
    if (esp_codec_dev_set_out_vol(output_dev_, next) != ESP_CODEC_DEV_OK) return false;
    output_volume_ = next;
    return true;
}

bool CoreS3AudioCodec::AgentRead(int16_t* pcm, size_t samples) {
    if (!input_enabled_ || samples != sion::agent::kAudioSamples * 2 ||
        AgentRxOverflowed()) return false;
    size_t bytes = 0;
    const auto result = i2s_channel_read(rx_handle_, pcm, samples * sizeof(int16_t), &bytes, 50);
    return result == ESP_OK && bytes == samples * sizeof(int16_t) &&
           !AgentRxOverflowed();
}

bool CoreS3AudioCodec::AgentWrite(const int16_t* pcm, size_t samples) {
    if (!output_enabled_ || agent_tx_fencing_ || samples != sion::agent::kAudioSamples) return false;
    std::array<int32_t, sion::agent::kAudioSamples> expanded{};
    for (size_t i = 0; i < samples; ++i) expanded[i] = static_cast<int32_t>(pcm[i]) * 65536;
    size_t bytes = 0;
    const auto result = i2s_channel_write(tx_handle_, expanded.data(), sizeof(expanded), &bytes, 50);
    return result == ESP_OK && bytes == sizeof(expanded);
}

bool CoreS3AudioCodec::AgentClose() {
    // esp_codec_dev_close drops driver errors internally: explicitly check the
    // actual hardware disable and channel stop as well as that bookkeeping call.
    bool ok = true;
    if (out_codec_if_->enable && out_codec_if_->enable(out_codec_if_, false) != ESP_CODEC_DEV_OK) ok = false;
    if (in_codec_if_->enable && in_codec_if_->enable(in_codec_if_, false) != ESP_CODEC_DEV_OK) ok = false;
    if (esp_codec_dev_close(output_dev_) != ESP_CODEC_DEV_OK) ok = false;
    if (esp_codec_dev_close(input_dev_) != ESP_CODEC_DEV_OK) ok = false;
    input_enabled_ = output_enabled_ = false;
    agent_tx_fencing_ = agent_tx_muted_ = false;
    for (auto handle : {tx_handle_, rx_handle_}) {
        auto result = i2s_channel_disable(handle);
        // The codec layer may already have stopped it. Both handles were
        // initialized in the base constructor, so READY is the other valid state.
        if (result != ESP_OK && result != ESP_ERR_INVALID_STATE) ok = false;
    }
    // A stopped DMA can still contain speech. Fill every descriptor with zeros
    // while READY, bounded above the fixed six-descriptor 240-frame allocation.
    const std::array<int32_t, sion::agent::kAudioSamples> silence{};
    for (size_t i = 0; i < 32; ++i) {
        size_t loaded = 0;
        if (i2s_channel_preload_data(tx_handle_, silence.data(), sizeof(silence), &loaded) != ESP_OK) return false;
        if (loaded == 0) return ok;
    }
    return false; // Unexpected DMA capacity/state, not a fabricated release ack.
}
