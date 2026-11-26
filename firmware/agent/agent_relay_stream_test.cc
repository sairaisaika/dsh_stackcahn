// SPDX-License-Identifier: MIT
#include "agent_relay_stream.h"
#include <cassert>
#include <vector>

using sion::agent::AgentRelayStream;
namespace {
constexpr std::string_view Ready = "SION-RELAY-READY 1", Start = "\nSIONR1\n";

bool Text(AgentRelayStream& stream, std::string_view frame, int offset = 0, int count = -1) {
    if (count < 0) count = static_cast<int>(frame.size()) - offset;
    return stream.Feed(1, true, frame.size(), offset,
                       reinterpret_cast<const uint8_t*>(frame.data() + offset), count);
}
bool Binary(AgentRelayStream& stream, std::string_view frame) {
    return stream.Feed(2, true, frame.size(), 0, reinterpret_cast<const uint8_t*>(frame.data()), frame.size());
}
}

int main() {
    uint8_t output[4]{};
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready, 0, 3));
        assert(!stream.CanHandshake() && stream.Read(output, sizeof(output)) == 0);
        assert(Text(stream, Ready, 3));
        assert(Binary(stream, Start.substr(0, 4)) && !stream.CanHandshake());
        assert(Binary(stream, "NR1\n\x16\x03\x03"));
        assert(stream.CanHandshake() && stream.Read(output, 1) == 1 && output[0] == 0x16);
        assert(stream.Read(output, sizeof(output)) == 2 && output[0] == 3 && output[1] == 3);
        assert(stream.Read(output, sizeof(output)) == 0);
    }
    {
        AgentRelayStream stream;
        assert(!Binary(stream, Start) && !stream.CanHandshake());
        assert(!Text(stream, Ready) && stream.Read(output, sizeof(output)) == -1);
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready));
        assert(!Binary(stream, "\nSIONU1\n") && !stream.CanHandshake());
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready, 0, 7));
        assert(!Text(stream, Ready, 8));
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready) && Binary(stream, Start));
        const std::string a(AgentRelayStream::MaxFrame, 'a'), b(a.size(), 'b'), c(a.size(), 'c');
        assert(Binary(stream, a) && Binary(stream, b));
        std::vector<uint8_t> bytes(AgentRelayStream::Capacity);
        assert(stream.Read(bytes.data(), a.size() - 1) == int(a.size() - 1));
        assert(std::all_of(bytes.begin(), bytes.begin() + a.size() - 1, [](uint8_t x) { return x == 'a'; }));
        assert(stream.Read(output, 2) == 2 && output[0] == 'a' && output[1] == 'b');
        assert(Binary(stream, c));
        assert(stream.Read(bytes.data(), bytes.size()) == int(b.size() - 1 + c.size()));
        assert(std::all_of(bytes.begin(), bytes.begin() + b.size() - 1, [](uint8_t x) { return x == 'b'; }));
        assert(std::all_of(bytes.begin() + b.size() - 1, bytes.begin() + b.size() - 1 + c.size(),
                           [](uint8_t x) { return x == 'c'; }));
        assert(Binary(stream, a) && Binary(stream, b) && !Binary(stream, "z"));
        assert(!stream.CanHandshake() && stream.Read(output, sizeof(output)) == -1);
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready) && Binary(stream, Start));
        assert(stream.Feed(2, true, 4, 0, reinterpret_cast<const uint8_t*>("ab"), 2));
        assert(!stream.Feed(2, true, 3, 2, reinterpret_cast<const uint8_t*>("c"), 1));
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready) && !Text(stream, Ready));
    }
    {
        AgentRelayStream stream;
        assert(Text(stream, Ready));
        assert(!stream.Feed(2, false, Start.size(), 0, reinterpret_cast<const uint8_t*>(Start.data()), Start.size()));
    }
}
