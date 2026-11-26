// SPDX-License-Identifier: MIT
#pragma once
#include "audio_engine.h"
#include <array>
#include <cstring>
namespace sion::agent::wire {
constexpr size_t kHeader=32,kInputBytes=kHeader+kAudioSamples*4,kOutputBytes=kHeader+kAudioSamples*2;
using InputBytes=std::array<uint8_t,kInputBytes>;
inline uint64_t U64(const uint8_t* p){uint64_t v=0;for(int i=0;i<8;++i)v=(v<<8)|p[i];return v;}
inline void Put64(uint8_t* p,uint64_t v){for(int i=7;i>=0;--i){p[i]=static_cast<uint8_t>(v);v>>=8;}}
inline InputBytes EncodeInput(const InputFrame& frame) {
    InputBytes bytes{};std::memcpy(bytes.data(),"SIA1",4);bytes[4]=1;
    Put64(bytes.data()+8,frame.epoch);Put64(bytes.data()+16,frame.sequence);Put64(bytes.data()+24,frame.read_started_us);
    for(size_t i=0;i<frame.pcm.size();++i){const auto sample=static_cast<uint16_t>(frame.pcm[i]);
        bytes[kHeader+i*2]=static_cast<uint8_t>(sample);bytes[kHeader+i*2+1]=static_cast<uint8_t>(sample>>8);}
    return bytes;
}
inline bool DecodeOutput(const uint8_t* p,size_t size,OutputFrame& frame) {
    if(!p||size!=kOutputBytes||std::memcmp(p,"SIA1",4)||p[4]!=2||p[5]||p[6]||p[7]||U64(p+24))return false;
    frame.epoch=U64(p+8);frame.sequence=U64(p+16);
    for(size_t i=0;i<frame.pcm.size();++i){const unsigned v=unsigned(p[kHeader+i*2])|(unsigned(p[kHeader+i*2+1])<<8);
        frame.pcm[i]=static_cast<int16_t>(v>32767?int(v)-65536:int(v));}
    return true;
}
}
