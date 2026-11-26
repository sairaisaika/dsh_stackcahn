// SPDX-License-Identifier: MIT
#pragma once
#include "agent_network_queue.h"
#include "agent_session.h"
#include <atomic>
namespace sion::agent {
enum class NetworkStage { Idle, Preparing, Wifi, Clock, Connecting, Connected, Closing, Failed };
enum class NetworkError { None, Pairing, Busy, Task, NoSavedWifi, Wifi, Clock, Transport, Protocol, Send, Cleanup, RelayConfiguration, RelayAuthentication, LanConfiguration };
enum class NetworkMode { Lan, Relay };
class AgentCarrier : public AgentWireSink {
public:
    virtual bool Start(uint64_t now)=0;
    virtual bool Poll(NetworkEvent& event)=0;
    virtual bool Finished()=0;
    virtual bool Closing()=0;
    virtual const char* StatusText()const=0;
    virtual const std::string& device()const=0;
    virtual const std::string& pair()const=0;
    virtual const std::string& boot()const=0;
};
// Start/Poll/Close and the sink belong to the application owner. The worker
// owns credentials, Wi-Fi, clock sync and the SDK client; callbacks only queue.
class AgentNetwork final:public AgentCarrier {
public:
    bool Start(uint64_t now)override;
    bool Start(uint64_t now, NetworkMode mode);
    bool Poll(NetworkEvent& event)override;
    bool Text(const std::string& text)override;
    bool Binary(const uint8_t* bytes,size_t size)override;
    bool CameraText(const std::string& text)override;
    void Close()override;
    bool Finished()override{return queue_.Finished();}
    bool Closing()override{return queue_.Closing(generation_);}
    bool Congested()override{return queue_.Congested(generation_);}
    NetworkStage stage()const{return stage_.load();}
    NetworkError error()const{return error_.load();}
    const char* StatusText()const override;
    const std::string& device()const override{return device_;}
    const std::string& pair()const override{return pair_;}
    // Read only after Poll returns Connected (mailbox publication barrier).
    const std::string& boot()const override{return boot_;}
private:
    struct RunContext;
    AgentNetworkQueue queue_;
    std::atomic<NetworkStage> stage_{NetworkStage::Idle};
    std::atomic<NetworkError> error_{NetworkError::None};
    std::atomic<NetworkMode> mode_{NetworkMode::Lan};
    uint64_t generation_=0,ticket_=0;
    std::string device_,pair_,boot_;
    void Fail(uint64_t generation,NetworkError error);
    void Run();
    void RunRelay(RunContext& context, const std::string& local_token);
    bool PublishConnected(uint64_t generation);
    static void Worker(void* arg);
    static void WifiEvent(void* arg,const char* base,int32_t id,void* data);
    static void SocketEvent(void* arg,const char* base,int32_t id,void* data);
};
AgentNetwork& DeviceNetwork();
}
