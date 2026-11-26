#pragma once
#include <string>
#include <functional>
#include <map>
#include <memory>
struct SocketError { std::string ToString()const{return "test-error";} };
struct ConnectResult { operator bool()const{return true;} SocketError error()const{return {};} };
class WebSocket {
public:
 inline static std::map<std::string,std::string> headers;
 inline static std::string url;
 inline static std::string hello=R"({"type":"hello","transport":"websocket","session_id":"test","audio_params":{"sample_rate":24000,"frame_duration":60}})";
 ~WebSocket(){if(disconnected_)disconnected_();}
 void SetHeader(const char* k,const char* v){headers[k]=v;}
 bool IsConnected()const{return connected_;}
 ConnectResult Connect(const char* value){url=value;connected_=true;return {};}
 bool Send(const std::string& text){if(text.find("\"hello\"")!=std::string::npos && data_)data_(hello.data(),hello.size(),false);return true;}
 bool Send(const void*,size_t,bool){return true;}
 void OnData(std::function<void(const char*,size_t,bool)> f){data_=std::move(f);}
 void OnDisconnected(std::function<void()> f){disconnected_=std::move(f);}
private:
 bool connected_=false;
 std::function<void(const char*,size_t,bool)>data_;
 std::function<void()>disconnected_;
};
