#include "common-whisper.h"
#include "ggml-backend.h"
#include "whisper.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

namespace {
constexpr std::array<const char *, 3> languages{"auto", "zh", "en"};
constexpr uint32_t max_wav_bytes = 44 + 24000 * 2 * 30;
constexpr size_t max_text_bytes = 24000;

void discard_log(ggml_log_level, const char *, void *) {}

bool respond(whisper_context * context, const std::vector<char> & wav, const char * language) {
    std::vector<float> samples;
    std::vector<std::vector<float>> stereo;
    if (!read_audio_data(wav.data(), wav.size(), samples, stereo, false) ||
        samples.empty() || samples.size() > WHISPER_SAMPLE_RATE * 30) {
        return false;
    }

    // Match the pinned CLI with -np -nt -t 4 -mc 0. Reset conditioning for
    // every request while keeping the model and its inference buffers alive.
    auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    params.greedy.best_of = whisper_full_default_params(WHISPER_SAMPLING_GREEDY).greedy.best_of;
    params.language = language;
    params.n_threads = 4;
    params.n_max_text_ctx = 0;
    params.no_context = true;
    params.no_timestamps = true;
    params.print_timestamps = false;
    params.print_progress = false;
    if (whisper_full(context, params, samples.data(), static_cast<int>(samples.size())) != 0) {
        return false;
    }

    const char * detected = whisper_lang_str(whisper_full_lang_id(context));
    const int segments = whisper_full_n_segments(context);
    if (!detected || segments > 512) {
        return false;
    }
    // Hex keeps arbitrary transcript bytes off the JSON control syntax.
    constexpr char digits[] = "0123456789abcdef";
    std::string hex;
    for (int segment = 0; segment < segments; ++segment) {
        for (const unsigned char * byte = reinterpret_cast<const unsigned char *>(
                 whisper_full_get_segment_text(context, segment)); *byte; ++byte) {
            if (hex.size() == max_text_bytes * 2) {
                return false;
            }
            hex.push_back(digits[*byte >> 4]);
            hex.push_back(digits[*byte & 15]);
        }
    }
    return std::printf("{\"type\":\"result\",\"language\":\"%s\",\"textHex\":\"%s\"}\n",
                       detected, hex.c_str()) >= 0 && std::fflush(stdout) == 0;
}
}

int main(int argc, char ** argv) {
    if (argc != 2) {
        return 2;
    }
    whisper_log_set(discard_log, nullptr);
    ggml_backend_load_all();
    std::unique_ptr<whisper_context, decltype(&whisper_free)> context(
        whisper_init_from_file_with_params(argv[1], whisper_context_default_params()), whisper_free);
    if (!context || std::puts("{\"type\":\"ready\",\"protocol\":1}") < 0 || std::fflush(stdout) != 0) {
        return 3;
    }
    for (;;) {
        std::array<unsigned char, 5> header{};
        const size_t received = std::fread(header.data(), 1, header.size(), stdin);
        if (received == 0 && std::feof(stdin)) {
            return 0;
        }
        const uint32_t size = uint32_t{header[0]} | (uint32_t{header[1]} << 8) |
            (uint32_t{header[2]} << 16) | (uint32_t{header[3]} << 24);
        if (received != header.size() || size <= 44 || size > max_wav_bytes || header[4] >= languages.size()) {
            return 4;
        }
        std::vector<char> wav(size);
        if (std::fread(wav.data(), 1, wav.size(), stdin) != wav.size() ||
            !respond(context.get(), wav, languages[header[4]])) {
            return 4;
        }
    }
}
