// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <deque>
#include <limits>
#include <mutex>
#include <string>
#include <vector>
namespace sion::agent {
enum class NetworkEventKind { Connected, Text, Binary, Closed };
struct NetworkEvent {
    NetworkEventKind kind=NetworkEventKind::Closed;
    std::vector<uint8_t> bytes;
};
// SDK callbacks and the TX worker never call AgentSession. The application
// owner drains this bounded mailbox. Close has a separate latch, so even a
// saturated queue cannot suppress disconnect/Stop. A generation is reusable
// only after the worker has destroyed its SDK client and called Finish.
class AgentNetworkQueue {
public:
    static constexpr size_t MaxMessage=2048, MaxMessages=24, MaxBytes=32768;
    uint64_t Begin() {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!finished_||generation_==std::numeric_limits<uint64_t>::max())return 0;
        ++generation_;finished_=false;closed_=connected_=closed_delivered_=false;
        incoming_.clear();outgoing_.clear();in_bytes_=out_bytes_=0;ResetMessage();
        return generation_;
    }
    bool Connected(uint64_t generation) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(generation))return false;
        if(connected_){CloseLocked();return false;}
        connected_=true;incoming_.push_back({NetworkEventKind::Connected,{}});return true;
    }
    // payload_len/offset describe one WebSocket frame, not the entire message.
    // Continuation frames use opcode 0; SDK chunks retain the frame opcode/FIN.
    bool Receive(uint64_t generation,int opcode,bool fin,int payload_len,int offset,
                 const uint8_t* bytes,int size,uint64_t now) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(generation))return false;
        auto fail=[&]{CloseLocked();return false;};
        if(!connected_||payload_len<0||offset<0||size<0||payload_len>int(MaxMessage)||
           offset>payload_len||size>payload_len-offset||(!bytes&&size)||
           (size==0&&payload_len!=0)||(opcode!=0&&opcode!=1&&opcode!=2))return fail();
        if(!frame_open_) {
            if(offset!=0||(!message_open_&&opcode==0)||(message_open_&&opcode!=0))return fail();
            if(!message_open_) {
                message_open_=true;kind_=opcode==1?NetworkEventKind::Text:NetworkEventKind::Binary;
                started_at_=now;
            }
            if(++frames_>32||message_.size()+size_t(payload_len)>MaxMessage)return fail();
            frame_open_=true;frame_size_=payload_len;frame_offset_=0;opcode_=opcode;fin_=fin;
        }
        if(now<started_at_||now-started_at_>=5000||++chunks_>64||offset!=frame_offset_||
           payload_len!=frame_size_||opcode!=opcode_||fin!=fin_)return fail();
        if(size)message_.insert(message_.end(),bytes,bytes+size);
        frame_offset_+=size;
        if(frame_offset_==frame_size_) {
            frame_open_=false;
            if(fin) {
                if(!Push(incoming_,in_bytes_,{kind_,std::move(message_)}))return fail();
                ResetMessage();
            }
        }
        return true;
    }
    bool Send(uint64_t generation,NetworkEventKind kind,const uint8_t* bytes,size_t size) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(generation))return false;
        if(!connected_||(kind!=NetworkEventKind::Text&&kind!=NetworkEventKind::Binary)||
           !bytes||!size||size>MaxMessage||outgoing_.size()>=MaxMessages||size>MaxBytes-out_bytes_) {
            CloseLocked();return false;
        }
        return Push(outgoing_,out_bytes_,{kind,std::vector<uint8_t>(bytes,bytes+size)});
    }
    // Capture audio is the only bulk producer. While the peer reads slowly it
    // yields, leaving the last eight slots and 8 KiB for control and receipts.
    bool Congested(uint64_t generation) {
        std::lock_guard<std::mutex> lock(mutex_);
        return Current(generation)&&connected_&&(outgoing_.size()>=MaxMessages-8||out_bytes_>MaxBytes-8192);
    }
    bool Poll(uint64_t generation,NetworkEvent& event) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(generation!=generation_||!generation)return false;
        if(closed_) {
            if(closed_delivered_)return false;
            closed_delivered_=true;event={NetworkEventKind::Closed,{}};return true;
        }
        return Pop(incoming_,in_bytes_,event);
    }
    bool TakeOutput(uint64_t generation,NetworkEvent& event) {
        std::lock_guard<std::mutex> lock(mutex_);
        return Current(generation)&&Pop(outgoing_,out_bytes_,event);
    }
    // Leave room for audio/receipts. Refusal neither closes nor mutates queues.
    bool CameraText(uint64_t generation,const std::string& text) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(generation)||!connected_||text.empty()||text.size()>MaxMessage||
           outgoing_.size()>=MaxMessages-8||out_bytes_>MaxBytes-8192||text.size()>MaxBytes-8192-out_bytes_)return false;
        return Push(outgoing_,out_bytes_,{NetworkEventKind::Text,std::vector<uint8_t>(text.begin(),text.end())});
    }
    void Close(uint64_t generation) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(generation&&generation==generation_)CloseLocked();
    }
    void Expire(uint64_t generation,uint64_t now) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(Current(generation)&&message_open_&&(now<started_at_||now-started_at_>=5000))CloseLocked();
    }
    bool Closing(uint64_t generation) {
        std::lock_guard<std::mutex> lock(mutex_);return !Current(generation);
    }
    void Finish(uint64_t generation) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(generation&&generation==generation_){CloseLocked();finished_=true;}
    }
    bool Finished() {std::lock_guard<std::mutex> lock(mutex_);return finished_;}
private:
    std::mutex mutex_;
    uint64_t generation_=0,started_at_=0;
    bool finished_=true,closed_=true,connected_=false,closed_delivered_=false;
    bool frame_open_=false,message_open_=false,fin_=false;
    int frame_size_=0,frame_offset_=0,opcode_=0;
    size_t in_bytes_=0,out_bytes_=0,frames_=0,chunks_=0;
    NetworkEventKind kind_=NetworkEventKind::Text;
    std::vector<uint8_t> message_;
    std::deque<NetworkEvent> incoming_,outgoing_;
    bool Current(uint64_t generation)const{return generation&&generation==generation_&&!closed_&&!finished_;}
    void ResetMessage(){message_.clear();frame_open_=message_open_=false;frames_=chunks_=0;}
    void CloseLocked(){closed_=true;incoming_.clear();outgoing_.clear();in_bytes_=out_bytes_=0;ResetMessage();}
    static bool Push(std::deque<NetworkEvent>& queue,size_t& used,NetworkEvent event) {
        if(queue.size()>=MaxMessages||event.bytes.size()>MaxBytes-used)return false;
        used+=event.bytes.size();queue.push_back(std::move(event));return true;
    }
    static bool Pop(std::deque<NetworkEvent>& queue,size_t& used,NetworkEvent& event) {
        if(queue.empty())return false;
        event=std::move(queue.front());queue.pop_front();used-=event.bytes.size();return true;
    }
};
}
