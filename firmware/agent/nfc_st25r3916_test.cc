// SPDX-License-Identifier: MIT
// Host test: an emulated ST25R3916 on I2C with one emulated ISO14443A card.
#include "nfc_st25r3916.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <vector>
using namespace sion::agent;

struct Chip {
    // Registers, interrupt latches and FIFO of the reader.
    std::array<uint8_t, 64> a{}, b{};
    std::vector<uint8_t> fifo, loaded;
    std::vector<uint8_t> commands;          // Direct commands in order
    std::vector<std::vector<uint8_t>> writes;
    uint8_t identity = 0x2A;                // Type 5 (ST25R3916), revision 2
    bool oscillator = true, fail_bus = false, protection = false;
    uint64_t us = 0;
    // The card.
    bool card = false, corrupt_bcc = false;
    std::vector<uint8_t> uid;
    uint16_t atqa = 0;
    uint8_t sak = 0, level = 0;             // 0 idle, n = answering cascade level n
    bool active = false;
    // Type 2 tag behaviour once selected.
    bool type2 = false, nak_reads = false;
    std::array<uint8_t, 8> version{};
    std::vector<uint8_t> memory;                  // Pages of 4 bytes
    std::vector<uint8_t> card_commands;           // First byte of every command after select
    unsigned wupas = 0, wupas_without_field = 0;

    bool Field() const { return a[0x02] & 0x08; }
    void Reset() { for (size_t i = 0; i < a.size(); ++i) if (i != 0x3F) a[i] = 0; b.fill(0); fifo.clear(); }
    void Irq(uint8_t main, uint8_t timer = 0) { a[0x1A] |= main; a[0x1B] |= timer; }
    std::array<uint8_t, 4> Level(uint8_t n) const {   // UID CLn as sent on the wire
        std::array<uint8_t, 4> out{};
        const size_t levels = uid.size() == 4 ? 1 : uid.size() == 7 ? 2 : 3;
        const size_t at = (n - 1) * 3;
        if (n < levels) { out = {0x88, uid[at], uid[at + 1], uid[at + 2]}; }
        else for (size_t i = 0; i < 4; ++i) out[i] = uid[at + i];
        return out;
    }
    uint8_t Levels() const { return uid.size() == 4 ? 1 : uid.size() == 7 ? 2 : 3; }
    void Command(uint8_t c, const uint8_t* data, size_t n) {
        commands.push_back(c);
        switch (c) {
            case 0xC1: Reset(); break;
            case 0xFC: protection = n == 2 && data[0] == 0x04 && data[1] == 0x10; break;
            case 0xC8: a[0x02] |= 0x08; break;   // Initial field on
            case 0xDB: fifo.clear(); break;
            case 0xC7:
                ++wupas;
                Irq(0x08);
                if (!Field()) { ++wupas_without_field; Irq(0, 0x40); break; }
                if (card) { level = 1; active = false; fifo = {uint8_t(atqa), uint8_t(atqa >> 8)}; Irq(0x30); }
                else Irq(0, 0x40);
                break;
            case 0xC5: {   // Anticollision: SEL, NVB 0x20
                Irq(0x08);
                const uint8_t want = uint8_t(0x91 + level * 2);
                if (!Field() || !card || !level || loaded.size() != 2 || loaded[0] != want || loaded[1] != 0x20) { Irq(0, 0x40); break; }
                const auto cl = Level(level);
                fifo.assign(cl.begin(), cl.end());
                fifo.push_back(uint8_t(cl[0] ^ cl[1] ^ cl[2] ^ cl[3] ^ (corrupt_bcc ? 1 : 0)));
                Irq(0x30);
                break;
            }
            case 0xC4: {   // Select: SEL 0x70 CLn BCC; after select, Type 2 commands
                Irq(0x08);
                if (active && !loaded.empty()) {
                    card_commands.push_back(loaded[0]);
                    if (!Field() || !card) { Irq(0, 0x40); break; }
                    if (type2 && loaded[0] == 0x60 && loaded.size() == 1) {
                        fifo.assign(version.begin(), version.end()); fifo.push_back(0xAA); fifo.push_back(0xBB);
                    } else if (type2 && loaded[0] == 0x30 && loaded.size() == 2 && !nak_reads && loaded[1] * 4u < memory.size()) {
                        fifo.clear();
                        for (unsigned i = 0; i < 16; ++i) fifo.push_back(memory[(loaded[1] * 4u + i) % memory.size()]);
                        fifo.push_back(0xAA); fifo.push_back(0xBB);
                    } else { fifo = {0x00}; active = false; }   // 4-bit NAK; the tag drops back to idle
                    Irq(0x30);
                    break;
                }
                const auto cl = Level(level);
                const bool match = Field() && card && level && loaded.size() == 7 && loaded[0] == uint8_t(0x91 + level * 2) &&
                    loaded[1] == 0x70 && std::equal(cl.begin(), cl.end(), loaded.begin() + 2) &&
                    loaded[6] == uint8_t(cl[0] ^ cl[1] ^ cl[2] ^ cl[3]);
                if (!match) { Irq(0, 0x40); break; }
                const bool last = level == Levels();
                fifo = {last ? sak : uint8_t(0x04), 0x12, 0x34};   // SAK and its CRC
                if (last) { active = true; level = 0; } else ++level;
                Irq(0x30);
                break;
            }
            default: break;
        }
    }
    // Bus
    bool Write(const uint8_t* d, size_t n) {
        us += 100;
        if (fail_bus) return false;
        writes.emplace_back(d, d + n);
        if (d[0] == 0xFB) { for (size_t i = 2; i < n; ++i) b[(d[1] + i - 2) & 0x3F] = d[i]; return true; }
        if (d[0] == 0x80) { loaded.assign(d + 1, d + n); return true; }
        if ((d[0] & 0xC0) == 0xC0) { Command(d[0], d + 1, n - 1); return true; }
        assert((d[0] & 0xC0) == 0x00);
        const bool field_before = Field();
        for (size_t i = 1; i < n; ++i) a[(d[0] + i - 1) & 0x3F] = d[i];
        if (field_before && !Field()) { level = 0; active = false; }   // Card loses power and resets
        if ((a[0x02] & 0x80) && oscillator) { a[0x31] |= 0x10; Irq(0x80); }
        return true;
    }
    bool Transfer(const uint8_t* tx, size_t n, uint8_t* rx, size_t m) {
        us += 100;
        if (fail_bus) return false;
        assert(n >= 1);
        if (tx[0] == 0xFB) { assert(n == 2); for (size_t i = 0; i < m; ++i) rx[i] = b[(tx[1] + i) & 0x3F]; return true; }
        if (tx[0] == 0x9F) {
            assert(m <= fifo.size());
            std::copy(fifo.begin(), fifo.begin() + m, rx);
            fifo.erase(fifo.begin(), fifo.begin() + m);
            return true;
        }
        assert(n == 1 && (tx[0] & 0xC0) == 0x40);
        for (size_t i = 0; i < m; ++i) {
            const uint8_t reg = (tx[0] + i) & 0x3F;
            if (reg == 0x1E) rx[i] = uint8_t(fifo.size() & 0xFF);
            else if (reg == 0x1F) rx[i] = uint8_t((fifo.size() >> 8) << 6);
            else if (reg == 0x3F) rx[i] = identity;
            else rx[i] = a[reg];
            if (reg >= 0x1A && reg <= 0x1D) a[reg] = 0;   // Reading clears a latch
        }
        return true;
    }
    uint64_t Micros() { return us += 10; }
    void SleepMs(uint32_t ms) { us += uint64_t(ms) * 1000; }
};

static void Wrote(const Chip& chip, std::vector<uint8_t> bytes) {
    for (const auto& w : chip.writes) if (w == bytes) return;
    assert(!"expected write missing");
}

int main() {
    {   // Something else at 0x50: read only, never written.
        Chip chip;chip.identity = 0x00;
        St25r3916<Chip> reader(chip);
        assert(!reader.Begin() && reader.failed() == St25r3916<Chip>::Step::Identity && !reader.ready());
        assert(chip.writes.empty());
        NfcCard card;
        assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::BusError);
        assert(chip.writes.empty());
    }
    {   // Oscillator never reports ready: setup stops there.
        Chip chip;chip.oscillator = false;
        St25r3916<Chip> reader(chip);
        assert(!reader.Begin() && reader.failed() == St25r3916<Chip>::Step::Oscillator);
    }
    Chip chip;
    St25r3916<Chip> reader(chip);
    assert(reader.Begin() && reader.ready() && reader.failed() == St25r3916<Chip>::Step::None);
    // The library's power-on order: stop, set default, protection, then I/O configuration.
    assert(chip.commands.size() >= 3 && chip.commands[0] == 0xC2 && chip.commands[1] == 0xC1 && chip.commands[2] == 0xFC);
    assert(chip.protection);
    Wrote(chip, {0x00, 0x10, 0x84});                  // 400 kHz hold time, drive level, 3.3 V
    assert(chip.a[0x00] == 0x17 && chip.a[0x01] == 0xA4);
    assert(chip.a[0x02] & 0x80);                      // Oscillator on
    assert(!chip.Field());                            // Field stays off until a poll
    assert(chip.a[0x03] == 0x09 && chip.a[0x04] == 0x00);   // NFC-A initiator, 106 kbit/s
    assert(chip.a[0x0B] == 0x08 && chip.a[0x0C] == 0x2D && chip.a[0x0D] == 0xD8 && chip.a[0x0E] == 0x22);
    assert(chip.b[0x0C] == 0x47 && chip.b[0x30] == 0x40 && chip.b[0x33] == 0x03 && chip.b[0x05] == 0x40);
    Wrote(chip, {0x16, 0, 0, 0, 0});                  // All interrupts unmasked (polled over I2C)
    const size_t setup_commands = chip.commands.size();
    assert(std::find(chip.commands.begin(), chip.commands.end(), 0xD6) != chip.commands.end());   // Regulators adjusted

    NfcCard card;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::NoCard && card.uid_size == 0);
    assert(!chip.Field() && chip.wupas == 1 && chip.wupas_without_field == 0);
    assert(reader.stats().polls == 1 && reader.stats().silent == 1 && reader.stats().selected == 0);   // Nobody answered
    assert(chip.commands[setup_commands] == 0xC8);    // Field on with collision avoidance
    Wrote(chip, {0x10, 0x03, 0x50});                  // 4 ms no-response timer: 848 steps of 64/fc

    // 4-byte UID (MIFARE Classic 1K style).
    chip.card = true;chip.uid = {0xDE, 0xAD, 0xBE, 0xEF};chip.atqa = 0x0004;chip.sak = 0x08;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card);
    assert(card.uid_size == 4 && std::equal(chip.uid.begin(), chip.uid.end(), card.uid));
    assert(card.atqa == 0x0004 && card.sak == 0x08 && !chip.Field());
    // Field off reset the card: the next poll finds it again.
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card && card.uid_size == 4);

    // 7-byte UID (NTAG21x style): two cascade levels.
    chip.uid = {0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66};chip.atqa = 0x0044;chip.sak = 0x00;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card);
    assert(card.uid_size == 7 && std::equal(chip.uid.begin(), chip.uid.end(), card.uid) && card.atqa == 0x0044 && card.sak == 0x00);
    // 10-byte UID, ISO14443-4 card.
    chip.uid = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};chip.atqa = 0x0344;chip.sak = 0x20;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card);
    assert(card.uid_size == 10 && std::equal(chip.uid.begin(), chip.uid.end(), card.uid) && card.sak == 0x20);
    // A UID whose check byte is wrong is not reported.
    assert(reader.stats().selected == 4 && reader.stats().silent == 1 && reader.stats().polls == 5);
    reader.ResetStats();
    chip.corrupt_bcc = true;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::NoCard && !chip.Field());
    chip.corrupt_bcc = false;
    // It answered WUPA but the UID was not read: counted apart from silence.
    assert(reader.stats().polls == 1 && reader.stats().anticollision_failed == 1 && reader.stats().silent == 0);
    // The bus failing is reported as such, not as "no card".
    chip.fail_bus = true;
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::BusError);
    chip.fail_bus = false;
    assert(reader.stats().field_failed == 1);
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card && !chip.Field());

    // NTAG215 (the "Tap to Build" card): GET_VERSION on arrival, then a page read.
    chip.uid = {0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80};chip.atqa = 0x0044;chip.sak = 0x00;chip.type2 = true;
    chip.version = {0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03};
    chip.memory.assign(135 * 4, 0);
    for (size_t i = 0; i < chip.memory.size(); ++i) chip.memory[i] = uint8_t(i * 7);
    chip.card_commands.clear();
    assert(reader.PollOnce(card) == St25r3916<Chip>::Poll::Card && card.uid_size == 7);
    assert(card.has_version && std::equal(chip.version.begin(), chip.version.end(), card.version));
    NfcRead read;read.page = 4;read.count = 6;
    assert(reader.PollOnce(card, &read) == St25r3916<Chip>::Poll::Card && read.code == NfcRead::Code::Read);
    assert(std::equal(read.data, read.data + 24, chip.memory.begin() + 16));
    assert(read.data[24] == 0);                       // Nothing past what was asked for
    read = {};read.page = 0;read.count = NfcRead::kMaxPages;
    assert(reader.PollOnce(card, &read) == St25r3916<Chip>::Poll::Card && read.code == NfcRead::Code::Read);
    assert(std::equal(read.data, read.data + 256, chip.memory.begin()));
    // Read-only: GET_VERSION and READ are the only commands a card ever got.
    for (uint8_t c : chip.card_commands) assert(c == 0x60 || c == 0x30);
    assert(chip.card_commands.size() == 1 + 1 + 2 + 1 + 16);
    // A NAK (e.g. a protected page) is a failed read, not data.
    chip.nak_reads = true;read = {};read.page = 4;read.count = 4;
    assert(reader.PollOnce(card, &read) == St25r3916<Chip>::Poll::Card && read.code == NfcRead::Code::Failed);
    chip.nak_reads = false;
    assert(reader.stats().read_failed == 1 && reader.stats().version_failed == 0);
    // No card, or a card that is not Type 2 (no GET_VERSION is even tried).
    chip.card = false;read = {};read.page = 4;read.count = 4;
    assert(reader.PollOnce(card, &read) == St25r3916<Chip>::Poll::NoCard && read.code == NfcRead::Code::NoCard);
    chip.card = true;chip.uid = {0xDE, 0xAD, 0xBE, 0xEF};chip.atqa = 0x0004;chip.sak = 0x08;chip.card_commands.clear();
    read = {};read.page = 4;read.count = 4;
    assert(reader.PollOnce(card, &read) == St25r3916<Chip>::Poll::Card && read.code == NfcRead::Code::Unsupported);
    assert(!card.has_version && chip.card_commands.empty());

    // Presence: one event on arrival, one after two missed polls, a swap gives both.
    NfcPresence presence;
    std::vector<NfcEvent> events;
    const auto emit = [&](const NfcEvent& e) { events.push_back(e); };
    NfcCard a{}, b{};
    a.uid_size = 4;a.uid[0] = 1;b.uid_size = 7;b.uid[0] = 2;
    presence.Note(true, a, 10, emit);presence.Note(true, a, 20, emit);
    assert(events.size() == 1 && events[0].present && SameCard(events[0].card, a) && events[0].at == 10);
    presence.Note(false, {}, 30, emit);assert(events.size() == 1);   // One miss is not removal
    presence.Note(true, a, 40, emit);presence.Note(false, {}, 50, emit);presence.Note(false, {}, 60, emit);
    assert(events.size() == 2 && !events[1].present && SameCard(events[1].card, a) && events[1].at == 60);
    presence.Note(true, a, 70, emit);presence.Note(true, b, 80, emit);
    assert(events.size() == 5 && events[2].present && !events[3].present && SameCard(events[3].card, a) &&
           events[4].present && SameCard(events[4].card, b));
    presence.Reset();presence.Note(true, b, 90, emit);
    assert(events.size() == 6 && events[5].present);   // After a reset a card is new again
    std::puts("ST25R3916 NFC-A: identity gate, library setup order, field per poll, 4/7/10-byte UIDs, BCC, bus errors, NTAG GET_VERSION and read-only page reads, presence passed");
}
