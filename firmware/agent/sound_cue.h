// SPDX-License-Identifier: MIT
#pragma once
#include <string_view>

namespace sion::agent {
// The linker provides both boundaries of each embedded asset. Defer length
// calculation to the consumer so merely including the header needs no startup.
struct SoundCue {
    const char* begin;
    const char* end;
    operator std::string_view() const {
        return {begin, static_cast<std::size_t>(end - begin)};
    }
};
}
