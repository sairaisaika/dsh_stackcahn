#pragma once
#include "web_socket.h"
struct NetworkInterface { std::unique_ptr<WebSocket>CreateWebSocket(int){return std::make_unique<WebSocket>();} };
class Board {
public:
 static Board& GetInstance(){static Board b;return b;}
 NetworkInterface* GetNetwork(){return &network_;}
 std::string GetUuid(){return "fake-client";}
private:NetworkInterface network_;
};
