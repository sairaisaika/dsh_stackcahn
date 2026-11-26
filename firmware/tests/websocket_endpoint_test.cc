#include "websocket_protocol.h"
#include "settings.h"
#include <cassert>
#include <iostream>
int main() {
    { WebsocketProtocol local(WebsocketEndpoint{"ws://192.168.1.2/voice","local-only-secret",1});
      assert(local.Start()); assert(local.OpenAudioChannel());
      assert(Settings::reads==0); assert(WebSocket::url=="ws://192.168.1.2/voice");
      assert(WebSocket::headers.at("Authorization")=="Bearer local-only-secret");
      assert(local.server_sample_rate()==24000); local.CloseAudioChannel(); }
    { WebSocket::headers.clear();
      WebsocketProtocol local(WebsocketEndpoint{"ws://192.168.1.2/voice","",1});
      assert(local.OpenAudioChannel()); assert(Settings::reads==0);
      assert(WebSocket::headers.count("Authorization")==0); }
    { WebSocket::headers.clear(); WebsocketProtocol factory;
      assert(factory.OpenAudioChannel()); assert(Settings::reads>0);
      assert(WebSocket::url=="wss://factory.example/voice");
      assert(WebSocket::headers.at("Authorization")=="Bearer factory-only-secret"); }
    { WebSocket::hello=R"({"type":"hello","transport":"invalid"})";
      WebsocketProtocol local(WebsocketEndpoint{"ws://192.168.1.2/voice","local",1});
      assert(!local.OpenAudioChannel()); }
    std::cout<<"4 production WebsocketProtocol scenarios passed (network/NVS stubs)\n";
}
