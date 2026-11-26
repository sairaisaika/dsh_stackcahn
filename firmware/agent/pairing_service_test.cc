// SPDX-License-Identifier: MIT
#include "pairing_service.cc"
#include <cassert>
#include <atomic>
#include <condition_variable>
#include <fstream>
#include <iostream>
#include <thread>
using namespace sion::agent;
static const std::string device="001122334455",nonce(32,'e'),pair(32,'c'),request_id(32,'d');
static std::string Record(){return "{\"version\":1,\"role\":\"sion-device\",\"pair_id\":\""+pair+
 "\",\"control_key\":\""+std::string(64,'a')+"\",\"local_token\":\""+std::string(64,'b')+
 "\",\"local_url\":\"wss://192.168.1.2:8766/audio\",\"ca\":\"-----BEGIN CERTIFICATE-----private-ca\","
 "\"cert\":\"-----BEGIN CERTIFICATE-----private-cert\",\"key\":\"-----BEGIN PRIVATE KEY-----private-key\"}";}
static std::string RelayRecord(){return "{\"version\":1,\"pair_id\":\""+pair+"\",\"revision\":\""+std::string(32,'4')+
 "\",\"origin\":\"wss://relay.example.test\",\"room_id\":\""+std::string(32,'1')+
 "\",\"token\":\""+std::string(64,'2')+"\",\"ca\":\"-----BEGIN CERTIFICATE-----\\nfixture-cert-body\","
 "\"ssid\":\"test-ssid\",\"password\":\"fixture-password\"}";}
static std::string Request(const char* action,const std::string& expected="",const std::string& window=nonce,const std::string& id=device){
 auto* json=cJSON_CreateObject();cJSON_AddStringToObject(json,"action",action);cJSON_AddStringToObject(json,"request_id",request_id.c_str());
 if(std::string_view(action)!="status"&&std::string_view(action)!="relay_status"){
  cJSON_AddStringToObject(json,"expected_device",id.c_str());cJSON_AddStringToObject(json,"expected_pair_id",expected.c_str());cJSON_AddStringToObject(json,"window",window.c_str());
  if(std::string(action)=="install")cJSON_AddItemToObject(json,"record",cJSON_Parse(Record().c_str()));
  if(std::string(action)=="relay_install")cJSON_AddItemToObject(json,"record",cJSON_Parse(RelayRecord().c_str()));
 }
 char* encoded=cJSON_PrintUnformatted(json);std::string result="SIONA1 "+std::string(encoded);cJSON_free(encoded);cJSON_Delete(json);return result;
}
static bool Ok(const std::string& reply,const char* error=""){
 assert(reply.rfind("SIONA1 ",0)==0);auto* json=cJSON_Parse(reply.c_str()+7);assert(json);
 assert(Field(json,"request_id")==request_id&&Field(json,"error")==error);
 const bool ok=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json,"ok"));cJSON_Delete(json);
 assert(reply.find("private-key")==std::string::npos&&reply.find("control_key")==std::string::npos);
 assert(reply.find("fixture-password")==std::string::npos&&reply.find("fixture-cert-body")==std::string::npos);
 return ok;
}
struct Store:PairingRepository {
 PairingStatus current{PairingState::Empty,{}};PairingWrite outcome=PairingWrite::Saved;
 std::atomic<int>writes{0};bool block=false,entered=false,released=false,read_error=false;
 std::mutex mutex;std::condition_variable cv;
 std::string relay_revision;
 bool relay_read_error=false;
 PairingStatus Read()override{return read_error?PairingStatus{PairingState::StorageError,{}}:current;}
 PairingStatus ReadPrivate(std::string& raw)override{
  if(block){std::unique_lock<std::mutex> lock(mutex);entered=true;cv.notify_all();cv.wait(lock,[&]{return released;});}
  raw=Record();return Read();
 }
 PairingWrite Replace(const std::string& expected,const std::string& raw)override{
  ++writes;assert(expected==current.id&&raw==Record());
  if(block){std::unique_lock<std::mutex> lock(mutex);entered=true;cv.notify_all();cv.wait(lock,[&]{return released;});}
  if(outcome==PairingWrite::Saved)current={PairingState::Paired,pair};return outcome;
 }
 PairingWrite Remove(const std::string& expected)override{++writes;assert(expected==current.id);current={PairingState::Revoked,{}};return outcome;}
 RelayStatus ReadRelay(const std::string& id)override{
  if(id.empty())return {};
  if(relay_read_error)return {RelayState::StorageError,{}};
  return relay_revision.empty()?RelayStatus{RelayState::Empty,{}}:RelayStatus{RelayState::Ready,relay_revision};
 }
 PairingWrite WriteRelay(const std::string& id,const std::string* record)override{
  assert(id==current.id);++writes;
  if(record){assert(*record==RelayRecord());relay_revision=std::string(32,'4');}
  else relay_revision.clear();
  return outcome;
 }
};
class CapturedPairing final : public PairingRepository {
public:
 explicit CapturedPairing(const char* path):path_(path){}
 PairingStatus Read()override{return status_;}
 PairingWrite Replace(const std::string& expected,const std::string& raw)override{
  assert(expected.empty()&&status_.state==PairingState::Empty);
  auto* record=cJSON_Parse(raw.c_str());assert(record);
  const auto installed=Field(record,"pair_id");cJSON_Delete(record);
  assert(installed.size()==32);
  std::ofstream captured(path_,std::ios::out|std::ios::binary);captured<<raw;captured.close();assert(captured);
  status_={PairingState::Paired,installed};return PairingWrite::Saved;
 }
 PairingWrite Remove(const std::string&)override{assert(false);return PairingWrite::Invalid;}
private:
 const char* path_;
 PairingStatus status_{PairingState::Empty,{}};
};
static void ServePairing(PairingMaintenance& endpoint) {
 PairingLineBuffer buffer;std::string line;
 for(char byte;std::cin.get(byte);)
  if(buffer.Feed(byte,100,line))std::cout<<endpoint.Process(line,100)<<std::flush;
}
int main(int argc,char** argv){
 if(argc==4&&std::string(argv[1])=="--stdio-capture"){
  CapturedPairing fixture(argv[3]);
  PairingMaintenance endpoint(fixture);endpoint.Initialize(argv[2]);endpoint.DriverReady(true);
  assert(endpoint.OpenWindow(0,nonce));ServePairing(endpoint);
  return 0;
 }
 if(argc==2){
  const std::string mode=argv[1];
  if(mode=="--record"){std::cout<<Record()<<'\n';return 0;}
  if(mode=="--relay-record"){std::cout<<RelayRecord()<<'\n';return 0;}
  assert(mode=="--stdio"||mode=="--stdio-paired"||mode=="--stdio-relay");
  Store fixture;if(mode!="--stdio")fixture.current={PairingState::Paired,pair};
  if(mode=="--stdio-relay")fixture.relay_revision=std::string(32,'4');
  PairingMaintenance endpoint(fixture);endpoint.Initialize(device);endpoint.DriverReady(true);
  assert(endpoint.OpenWindow(0,nonce));ServePairing(endpoint);
  return 0;
 }
 Store store;PairingMaintenance service(store);service.Initialize(device);
 assert(Ok(service.Process(Request("status"),0)));assert(!service.OpenWindow(0,nonce));
 service.DriverReady(true);assert(!service.OpenWindow(0,"bad"));
 assert(!Ok(service.Process(Request("install"),0),"window_closed")&&store.writes==0);
 assert(service.OpenWindow(100,nonce));assert(service.Snapshot(100).reserved());
 assert(!Ok(service.Process(Request("install","",nonce,"ffeeddccbbaa"),101),"wrong_device"));
 assert(!Ok(service.Process(Request("install",pair),102),"identity_conflict"));
 assert(!Ok(service.Process(Request("install","",std::string(32,'f')),103),"window_closed"));
 assert(store.writes==0);
 assert(!Ok(service.Process(Request("install"),120100),"window_closed"));
 assert(service.OpenWindow(120101,nonce));assert(Ok(service.Process(Request("install"),120102)));
 assert(store.writes==1&&service.Snapshot(120103).pairing.id==pair&&!service.Snapshot(120103).reserved());
 assert(!Ok(service.Process(Request("install",pair),120104),"window_closed")&&store.writes==1);
 assert(service.OpenWindow(120105,nonce));service.CloseWindow();
 assert(!Ok(service.Process(Request("remove",pair),120106),"window_closed"));
 assert(service.OpenWindow(120107,nonce));assert(Ok(service.Process(Request("remove",pair),120108)));
 assert(service.Snapshot(120109).pairing.state==PairingState::Revoked);
 // Failure and failed post-write reread consume the window and never report saved.
 store.outcome=PairingWrite::NoSpace;assert(service.OpenWindow(120110,nonce));
 assert(!Ok(service.Process(Request("install"),120111),"no_space"));
 assert(!service.Snapshot(120112).reserved());store.outcome=PairingWrite::Saved;
 assert(service.OpenWindow(120113,nonce));store.read_error=true;
 assert(!Ok(service.Process(Request("install"),120114),"write_unconfirmed"));
 assert(!service.OpenWindow(120115,nonce));store.read_error=false;
 // Malformed/deep input cannot trigger storage work or reflect private input.
 const auto before=store.writes.load();
 assert(service.Process("SION1 {}",0).empty());
 assert(service.Process("SIONA1 "+std::string(8192,'x'),0).empty());
 assert(service.Process("SIONA1 {\"a\":{\"b\":{}}}",0).empty());
 assert(service.Process("SIONA1 {\"action\":\"status\\u0000hidden\"}",0).empty());
 auto duplicated=Request("status");duplicated.insert(duplicated.size()-1,",\"action\":\"status\"");
 assert(!Ok(service.Process(duplicated,0),"invalid_request"));assert(store.writes==before);
 // Slow storage does not hold the UI snapshot lock; closing the window cannot
 // cancel a write already admitted, and busy remains until reread completes.
 Store blocked;blocked.block=true;PairingMaintenance concurrent(blocked);concurrent.Initialize(device);concurrent.DriverReady(true);
 assert(concurrent.OpenWindow(1000,nonce));std::string reply;
 std::thread writer([&]{reply=concurrent.Process(Request("install"),1001);});
 {std::unique_lock<std::mutex> lock(blocked.mutex);blocked.cv.wait(lock,[&]{return blocked.entered;});}
 assert(concurrent.Snapshot(1002).busy);assert(Ok(concurrent.Process(Request("status"),1003)));
 assert(!concurrent.OpenWindow(1004,nonce));concurrent.CloseWindow();assert(concurrent.Snapshot(1005).reserved());
 {std::lock_guard<std::mutex> lock(blocked.mutex);blocked.released=true;}blocked.cv.notify_all();writer.join();
 assert(Ok(reply)&&!concurrent.Snapshot(1006).reserved());
 assert(concurrent.OpenWindow(2000,nonce));assert(concurrent.Snapshot(1001).remaining_ms==120000);
 assert(concurrent.Snapshot(122000).remaining_ms==0);
 // Network owns a stable identity until teardown. Reads do not block snapshots
 // or admit USB mutation; stale teardown cannot release a newer reservation.
 Store credentials;credentials.current={PairingState::Paired,pair};credentials.block=true;
 PairingMaintenance transport(credentials);transport.Initialize(device);transport.DriverReady(true);
 assert(transport.OpenWindow(1,nonce));assert(!transport.ReserveTransport(2));transport.CloseWindow();
 auto ticket=transport.ReserveTransport(3);assert(ticket&&!transport.ReserveTransport(4));
 std::string secret;bool loaded=false;
 std::thread reader([&]{loaded=transport.ReadTransport(ticket,secret);});
 {std::unique_lock<std::mutex> lock(credentials.mutex);credentials.cv.wait(lock,[&]{return credentials.entered;});}
 assert(!transport.OpenWindow(5,nonce));assert(!transport.ReleaseTransport(ticket));
 assert(Ok(transport.Process(Request("status"),6)));
 assert(!Ok(transport.Process(Request("remove",pair),7),"maintenance_busy")&&credentials.writes==0);
 {std::lock_guard<std::mutex> lock(credentials.mutex);credentials.released=true;}credentials.cv.notify_all();reader.join();
 assert(loaded&&secret==Record());assert(transport.ReleaseTransport(ticket));
 const auto next=transport.ReserveTransport(8);assert(next>ticket&&!transport.ReleaseTransport(ticket));
 assert(!transport.ReadTransport(ticket,secret)&&secret.empty());credentials.read_error=true;
 assert(!transport.ReadTransport(next,secret)&&secret.empty());assert(transport.ReleaseTransport(next));
 assert(transport.OpenWindow(9,nonce));
 Store relay_store;relay_store.current={PairingState::Paired,pair};
 PairingMaintenance relay(relay_store);relay.Initialize(device);relay.DriverReady(true);
 assert(relay.Process(Request("status"),0).find("relay_state")==std::string::npos);
 assert(relay.Process(Request("relay_status"),1).find("\"relay_state\":\"empty\"")!=std::string::npos);
 assert(!Ok(relay.Process(Request("relay_install",pair),2),"window_closed"));
 assert(relay.OpenWindow(3,nonce));
 assert(!Ok(relay.Process(Request("relay_install",std::string(32,'a')),4),"identity_conflict"));
 auto installed=relay.Process(Request("relay_install",pair),5);assert(Ok(installed));
 assert(installed.find(std::string(32,'4'))!=std::string::npos&&relay_store.writes==1);
 assert(!Ok(relay.Process(Request("relay_remove",pair),6),"window_closed"));
 const auto relay_ticket=relay.ReserveTransport(7);assert(relay_ticket);
 assert(!Ok(relay.Process(Request("relay_remove",pair),8),"maintenance_busy"));
 assert(relay.ReleaseTransport(relay_ticket));
 relay_store.relay_read_error=true;
 assert(relay.OpenWindow(9,nonce));
 assert(!Ok(relay.Process(Request("relay_remove",pair),10),"write_unconfirmed"));
 assert(relay.Snapshot(10).relay.state==RelayState::StorageError);
 relay_store.relay_read_error=false;
 auto restored=relay.Process(Request("relay_status"),11);assert(Ok(restored));
 assert(restored.find("\"relay_state\":\"empty\"")!=std::string::npos&&relay.Snapshot(11).pairing.id==pair);
 // Real chunking/overflow/idle reset logic, not a substituted line parser.
 PairingLineBuffer buffer;std::string line;const auto status=Request("status");
 for(char c:status)assert(!buffer.Feed(c,1,line));assert(buffer.Feed('\n',2,line)&&line==status);
 for(int i=0;i<8193;++i)assert(!buffer.Feed('x',3,line));assert(!buffer.Feed('\n',4,line));
 assert(!buffer.Feed('x',5,line));for(char c:status)assert(!buffer.Feed(c,6000,line));
 assert(buffer.Feed('\n',6001,line)&&line==status);
 std::cout<<"Pairing maintenance: physical window/expiry/identity/replay, failure reread, secret-free replies, bounded parser and concurrent UI access passed\n";
}
