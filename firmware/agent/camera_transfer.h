// SPDX-License-Identifier: MIT
#pragma once
#include "camera_engine.h"
#include <algorithm>
#include <string>
namespace sion::agent {
struct CameraView {
    bool allowed=false,busy=false;
    std::string phase="unavailable",error;
};
// Application-owner only. One image and at most one small reply, pull paced.
// The authenticated session validates boot/epoch before calling these methods.
class CameraTransfer {
public:
    static constexpr size_t ChunkBytes=1024;
    static constexpr uint64_t TimeoutMs=30000;
    explicit CameraTransfer(CameraEngine* camera=nullptr):camera_(camera){}
    bool supported()const{return camera_!=nullptr;}
    bool busy()const{return !id_.empty();}
    CameraView View()const {
        if(!camera_)return {};
        const auto s=camera_->status();
        const char* phase=s.phase==CameraPhase::Fault?"fault":s.phase==CameraPhase::Closing?"closing":
            s.phase==CameraPhase::Opening?"opening":s.phase==CameraPhase::Capturing?"capturing":
            (picture_.jpeg||s.result_ready)?"transferring":"idle";
        return {s.allowed,busy()||s.phase!=CameraPhase::Idle||s.result_ready,phase,
            s.phase==CameraPhase::Fault?"close":last_error_};
    }
    bool Begin(const std::string& id,uint64_t epoch,uint64_t now) {
        if(!camera_||busy()||id==retired_)return false;
        id_=id;epoch_=epoch;started_=now;offset_=advance_=0;meta_sent_=final_=false;last_error_.clear();
        ticket_=camera_->Begin(epoch,now);
        if(!ticket_)Fail(camera_->status().allowed?"unavailable":"disabled");
        return true;
    }
    bool Next(const std::string& id,uint64_t offset) {
        // A pull already in flight may arrive after local revocation/error.
        if((id==id_&&!failure_.empty())||(!busy()&&id==retired_))return true;
        if(id!=id_||!failure_.empty()||!meta_sent_||!pending_.empty()||!picture_.jpeg||offset!=offset_)return false;
        if(offset_==picture_.info.size){pending_="\"type\":\"camera_complete\"";final_=true;}
        else {
            advance_=std::min(ChunkBytes,picture_.info.size-offset_);
            pending_="\"type\":\"camera_chunk\",\"offset\":\""+std::to_string(offset_)+
                "\",\"data\":\""+Base64(picture_.jpeg.get()+offset_,advance_)+"\"";
        }
        return true;
    }
    void Reset() {
        if(busy())last_error_="cancelled";
        if(camera_&&ticket_)camera_->Cancel(epoch_,ticket_);
        Clear();
    }
    template<class Sender> void Pump(uint64_t now,const std::string& identity,Sender send) {
        if(!busy())return;
        if(failure_.empty()&&(now<started_||now-started_>=TimeoutMs))Fail("timeout");
        if(failure_.empty()&&!camera_->RequestValid(epoch_,ticket_))Fail("cancelled");
        if(!failure_.empty()) {
            const auto phase=camera_->status().phase;
            if(phase!=CameraPhase::Idle&&phase!=CameraPhase::Fault)return;
            if(phase==CameraPhase::Fault)failure_="close";
            pending_="\"type\":\"camera_error\",\"code\":\""+failure_+"\"";final_=true;
        } else if(!picture_.jpeg&&pending_.empty()) {
            if(camera_->status().phase==CameraPhase::Fault){Fail("close");return;}
            CameraPicture result;
            if(!camera_->Take(epoch_,ticket_,result))return;
            if(result.error!=CameraError::None){Fail(ErrorName(result.error));return;}
            picture_=std::move(result);
            pending_="\"type\":\"camera_meta\",\"bytes\":\""+std::to_string(picture_.info.size)+
                "\",\"width\":\""+std::to_string(picture_.info.width)+"\",\"height\":\""+
                std::to_string(picture_.info.height)+"\"";
        }
        if(pending_.empty())return;
        if(!send("{"+pending_+",\"request_id\":\""+id_+"\","+identity+"}"))return;
        if(final_){Clear();return;}
        meta_sent_=true;offset_+=advance_;advance_=0;pending_.clear();
    }
private:
    CameraEngine* camera_;
    CameraPicture picture_;
    std::string id_,retired_,pending_,failure_,last_error_;
    uint64_t epoch_=0,ticket_=0,started_=0;
    size_t offset_=0,advance_=0;
    bool meta_sent_=false,final_=false;
    void Clear(){if(!id_.empty())retired_=id_;id_.clear();pending_.clear();failure_.clear();picture_={};ticket_=0;}
    void Fail(const char* code) {
        failure_=code;last_error_=code;pending_.clear();picture_={};advance_=0;
        if(ticket_&&camera_->status().phase!=CameraPhase::Fault)camera_->Cancel(epoch_,ticket_);
    }
    static const char* ErrorName(CameraError e) {
        switch(e){case CameraError::Memory:return "memory";case CameraError::Open:return "open";
        case CameraError::Capture:return "capture";case CameraError::InvalidImage:return "invalid";
        case CameraError::Timeout:return "timeout";case CameraError::Close:return "close";
        default:return "invalid";}
    }
    static std::string Base64(const uint8_t* p,size_t n) {
        static constexpr char table[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string out;out.reserve((n+2)/3*4);
        for(size_t i=0;i<n;i+=3){const unsigned v=(unsigned(p[i])<<16)|(i+1<n?unsigned(p[i+1])<<8:0)|(i+2<n?p[i+2]:0);
            out+=table[(v>>18)&63];out+=table[(v>>12)&63];out+=i+1<n?table[(v>>6)&63]:'=';out+=i+2<n?table[v&63]:'=';}
        return out;
    }
};
}
