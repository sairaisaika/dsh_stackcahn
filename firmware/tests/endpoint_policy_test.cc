#include "sion/endpoint_policy.h"
#include <cassert>
#include <iostream>
int main() {
    for (auto s:{"ws://192.168.1.2:8000/xiaozhi/v1/","wss://10.0.0.3/voice","ws://172.16.1.4:1/"})
        assert(sion::ValidLocalEndpoint(s));
    for (auto s:{"http://192.168.1.2/","ws://8.8.8.8/","ws://127.0.0.1/","ws://169.254.1.2/",
                 "ws://172.32.1.2/","ws://192.168.0.999/","ws://192.168.1.2.3/",
                 "ws://192.168.1.2:0/","ws://192.168.1.2:65536/","ws://192.168.1.2:/",
                 "ws://user@192.168.1.2/","ws://192.168.1.2/?token=secret","ws://router.local/",
                 "ws://192.168.1.2/\rHeader:foo","ws://192.168.1.2"}) assert(!sion::ValidLocalEndpoint(s));
    assert(sion::ValidSecret(std::string(32,'a')));
    assert(!sion::ValidSecret("short"));
    assert(!sion::ValidSecret(std::string(32,'a')+"\r"));
    std::cout<<"18 endpoint cases and 3 credential cases passed\n";
}
