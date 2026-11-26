// SPDX-License-Identifier: MIT
#pragma once
#include "session_lifecycle.h"
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#ifdef ESP_PLATFORM
#include <esp_heap_caps.h>
#endif

namespace sion::agent {
// Product limits, not measured camera performance. One JPEG, no video queue.
constexpr size_t kCameraMaxBytes = 256 * 1024;
constexpr uint64_t kCameraTimeoutMs = 5000;
enum class CameraPhase { Idle, Opening, Capturing, Closing, Fault };
enum class CameraError { None, Memory, Open, Capture, InvalidImage, Timeout, Close };
struct CameraImageInfo { size_t size=0; uint16_t width=0, height=0; };
struct CameraBufferDeleter {
    void operator()(uint8_t* data) const {
#ifdef ESP_PLATFORM
        heap_caps_free(data);
#else
        delete[] data;
#endif
    }
};
using CameraBuffer=std::unique_ptr<uint8_t[],CameraBufferDeleter>;
inline CameraBuffer AllocateCameraBuffer(size_t size) {
#ifdef ESP_PLATFORM
    return CameraBuffer(static_cast<uint8_t*>(heap_caps_aligned_alloc(16,size,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)));
#else
    return CameraBuffer(new(std::nothrow) uint8_t[size]);
#endif
}
struct CameraPicture {
    uint64_t epoch=0, ticket=0;
    CameraError error=CameraError::None;
    CameraImageInfo info{};
    CameraBuffer jpeg;
};
struct CameraStatus {
    CameraPhase phase;
    CameraError error;
    uint64_t epoch, ticket;
    bool allowed, result_ready;
};

// Only the camera worker calls these methods. No original AI audio, preview or
// cloud Explain side effects. Read waits must be bounded and may return Pending.
// Open/Close can still wait inside SDK locks: the lifecycle must keep Pending or
// Fault until they actually finish, never force-delete the worker to report Done.
// Even failed Open requires Close for partial resources.
// Read writes at most capacity bytes; info is valid only on Done. The worker
// buffer is borrowed only for this call, and may not be retained by the port.
// Done means encoded JPEG bytes, not a sensor/preview buffer. JPEG decoding and
// attachment normalization belong to the host, not this envelope check.
struct CameraPort {
    virtual ~CameraPort()=default;
    virtual bool Open()=0;
    virtual Result Read(uint8_t* target, size_t capacity, CameraImageInfo& info)=0;
    virtual bool Close()=0;
};

// Exactly one worker invokes Pump; control methods may run concurrently.
// The owner must keep both objects alive until the worker is joined and the port
// is closed. A software fence is NOT driver cancellation or a task-exit receipt.
class CameraEngine {
public:
    explicit CameraEngine(CameraPort& port):port_(port){}
    void AllowCapture(bool allowed) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(allowed_==allowed) return;
        allowed_=allowed;
        if(!allowed) CancelLocked();
    }
    // Caller must independently authenticate and validate the active lease.
    // Returns a local monotonic ticket, NOT a network request_id. Zero rejects.
    uint64_t Begin(uint64_t epoch, uint64_t now_ms) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!allowed_||!epoch||epoch<=fence_||epoch<epoch_||
           phase_!=CameraPhase::Idle||ready_||ticket_==std::numeric_limits<uint64_t>::max()) return 0;
        epoch_=epoch; ++ticket_; started_=now_ms;
        error_=CameraError::None; phase_=CameraPhase::Opening;
        return ticket_;
    }
    void Stop(uint64_t fence) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(fence<epoch_) return;
        StopLocked(fence);
    }
    Result Stopped(uint64_t fence) const {
        std::lock_guard<std::mutex> lock(mutex_);
        if(fence!=fence_||epoch_>fence) return Result::Pending;
        if(phase_==CameraPhase::Fault) return Result::Failed;
        return phase_==CameraPhase::Idle ? Result::Done : Result::Pending;
    }
    // Request-local cancellation; does not fence an ongoing audio session.
    void Cancel(uint64_t epoch,uint64_t ticket) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(epoch==epoch_&&ticket==ticket_) CancelLocked();
    }
    bool RequestValid(uint64_t epoch,uint64_t ticket) const {
        std::lock_guard<std::mutex> lock(mutex_);
        return allowed_&&epoch==epoch_&&epoch>fence_&&ticket==ticket_&&ticket>cancelled_ticket_;
    }
    CameraStatus status() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return {phase_,error_,epoch_,ticket_,allowed_,ready_};
    }
    bool Take(uint64_t epoch,uint64_t ticket,CameraPicture& picture) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(!ready_||epoch!=epoch_||ticket!=ticket_||epoch<=fence_) return false;
        picture=std::move(result_); ready_=false;
        return true;
    }
    void Pump(uint64_t now_ms) {
        CameraPhase phase;
        uint64_t ticket;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if(phase_==CameraPhase::Idle||phase_==CameraPhase::Fault) return;
            // Clock reversal and deadline both discard a pending image. Driver
            // cleanup still runs; its failure must not be reported as idle.
            if(epoch_>fence_&&(now_ms<started_||now_ms-started_>=kCameraTimeoutMs)) {
                if(error_==CameraError::None) error_=CameraError::Timeout;
                phase_=CameraPhase::Closing;
            }
            phase=phase_; ticket=ticket_;
        }
        if(phase==CameraPhase::Closing) {
            const bool ok=!owns_port_||port_.Close();
            if(ok) owns_port_=false;
            std::lock_guard<std::mutex> lock(mutex_);
            if(!ok) {
                phase_=CameraPhase::Fault; error_=CameraError::Close;
                buffer_.reset(); info_={}; return;
            }
            // Stop may have arrived during Close. Never publish its old image.
            phase_=CameraPhase::Idle;
            if(epoch_>fence_&&ticket_>cancelled_ticket_) {
                result_={epoch_,ticket_,error_,{},nullptr};
                if(error_==CameraError::None) {
                    result_.info=info_; result_.jpeg=std::move(buffer_);
                }
                ready_=true;
            }
            buffer_.reset(); info_={}; return;
        }
        if(phase==CameraPhase::Opening) {
            buffer_=AllocateCameraBuffer(kCameraMaxBytes);
            info_={};
            bool ok=false;
            if(buffer_) {
                owns_port_=true; // Partial initialization also requires cleanup.
                ok=port_.Open();
            }
            std::lock_guard<std::mutex> lock(mutex_);
            if(!Current(ticket,CameraPhase::Opening)) return;
            error_=!buffer_ ? CameraError::Memory : ok ? CameraError::None : CameraError::Open;
            phase_=ok ? CameraPhase::Capturing : CameraPhase::Closing;
            return;
        }
        CameraImageInfo info{};
        const auto result=port_.Read(buffer_.get(),kCameraMaxBytes,info);
        std::lock_guard<std::mutex> lock(mutex_);
        if(!Current(ticket,CameraPhase::Capturing)) return;
        if(result==Result::Pending) return;
        if(result==Result::Failed) error_=CameraError::Capture;
        else if(!ValidEnvelope(info)) error_=CameraError::InvalidImage;
        else info_=info;
        phase_=CameraPhase::Closing;
    }
private:
    CameraPort& port_;
    mutable std::mutex mutex_;
    CameraPhase phase_=CameraPhase::Idle;
    CameraError error_=CameraError::None;
    uint64_t epoch_=0,ticket_=0,fence_=0,started_=0,cancelled_ticket_=0;
    bool allowed_=false,ready_=false;
    CameraPicture result_;
    // Worker-only resources. Stop never frees memory underneath a running Read.
    bool owns_port_=false;
    CameraBuffer buffer_;
    CameraImageInfo info_{};
    bool Current(uint64_t ticket,CameraPhase phase) const {
        return ticket==ticket_&&ticket>cancelled_ticket_&&phase==phase_&&epoch_>fence_;
    }
    void StopLocked(uint64_t fence) {
        if(fence>fence_) fence_=fence;
        CancelLocked();
    }
    void CancelLocked() {
        cancelled_ticket_=ticket_;
        ready_=false; result_={};
        if(phase_!=CameraPhase::Idle) phase_=CameraPhase::Closing;
    }
    bool ValidEnvelope(const CameraImageInfo& info) const {
        return info.size>=4&&info.size<=kCameraMaxBytes&&info.width&&info.width<=640&&
            info.height&&info.height<=480&&buffer_[0]==0xff&&buffer_[1]==0xd8&&
            buffer_[info.size-2]==0xff&&buffer_[info.size-1]==0xd9;
    }
};
}
