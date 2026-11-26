// SPDX-License-Identifier: MIT
#pragma once
#include "agent_network_queue.h"
#include <algorithm>
#include <array>
#include <cstring>
namespace sion::agent {
inline constexpr size_t UsbHeaderSize=3;
inline constexpr uint8_t UsbKeepalive=3;
inline constexpr char UsbPreamble[]="SIONU1\n";
inline constexpr char UsbStandbyProbe[]="SIONU0\n";
inline constexpr char UsbStandbyReady[]="\nSIONU0 READY\n";

// Accept an exact line while the user has armed USB audio. Bytes away from a
// line boundary never begin a handshake, and no rejected line is accumulated.
template<const auto& line=UsbPreamble>
class UsbPreambleReader {
public:
    bool Feed(char byte) {
        if (matched_<sizeof(line)-1 && byte==line[matched_]) {
            if (++matched_==sizeof(line)-1) { matched_=0; return true; }
        } else matched_=byte=='\n'?0:sizeof(line);
        return false;
    }
private:
    size_t matched_=0;
};

class UsbFrameReader {
public:
    template<typename Consumer>
    bool Feed(const uint8_t* bytes,size_t count,uint64_t now,Consumer consume) {
        while (count) {
            if (!used_) started_=now;
            if (Expired(now)) return false;
            const size_t copied=std::min(count,target_-used_);
            std::memcpy(frame_.data()+used_,bytes,copied);
            bytes+=copied; count-=copied; used_+=copied;
            if (used_!=target_) continue;
            if (target_==UsbHeaderSize) {
                const size_t length=(size_t(frame_[1])<<8)+frame_[2];
                if (frame_[0]<1 || frame_[0]>UsbKeepalive || !length ||
                    length>AgentNetworkQueue::MaxMessage || (frame_[0]==UsbKeepalive && length!=1)) return false;
                target_=UsbHeaderSize+length;
            } else {
                if (!consume(frame_[0],frame_.data()+UsbHeaderSize,target_-UsbHeaderSize)) return false;
                used_=0; target_=UsbHeaderSize;
            }
        }
        return true;
    }
    bool Expired(uint64_t now)const {return used_ && (now<started_ || now-started_>=5000);}
private:
    std::array<uint8_t,AgentNetworkQueue::MaxMessage+UsbHeaderSize> frame_;
    size_t used_=0,target_=UsbHeaderSize;
    uint64_t started_=0;
};
}
