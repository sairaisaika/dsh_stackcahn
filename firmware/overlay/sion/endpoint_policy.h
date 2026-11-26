// SPDX-License-Identifier: MIT
#pragma once
#include <charconv>
#include <string>
namespace sion {
inline bool ValidSecret(const std::string& secret) {
    if (secret.size() < 32 || secret.size() > 128)
        return false;
    for (unsigned char ch : secret)
        if (ch < 33 || ch > 126)
            return false;
    return true;
}
// LAN-only literal IPv4 avoids a public endpoint or DNS rebinding by configuration.
// Scheme/token policy is explicit: LAN WS carries a separate, scoped token, never factory
// credentials.
inline bool ValidLocalEndpoint(const std::string& url) {
    if (url.size() > 256 || url.find_first_of("\r\n\t @?#") != std::string::npos)
        return false;
    size_t begin = url.rfind("ws://", 0) == 0 ? 5 : url.rfind("wss://", 0) == 0 ? 6 : 0;
    if (!begin)
        return false;
    auto end = url.find('/', begin);
    if (end == std::string::npos)
        return false;
    auto authority = url.substr(begin, end - begin);
    auto colon = authority.find(':');
    auto host = authority.substr(0, colon);
    if (colon != std::string::npos) {
        auto port = authority.substr(colon + 1);
        unsigned p = 0;
        auto r = std::from_chars(port.data(), port.data() + port.size(), p);
        if (r.ec != std::errc{} || r.ptr != port.data() + port.size() || !p || p > 65535)
            return false;
    }
    unsigned octets[4]{};
    size_t offset = 0;
    for (int i = 0; i < 4; ++i) {
        auto stop = host.find('.', offset);
        if (i == 3)
            stop = host.size();
        if (stop == std::string::npos || stop == offset)
            return false;
        auto r = std::from_chars(host.data() + offset, host.data() + stop, octets[i]);
        if (r.ec != std::errc{} || r.ptr != host.data() + stop || octets[i] > 255)
            return false;
        offset = stop + 1;
    }
    return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
           (octets[0] == 192 && octets[1] == 168);
}
}  // namespace sion
