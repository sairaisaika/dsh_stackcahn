// SPDX-License-Identifier: MIT
//
// ST25R3916 NFC reader, minimal ISO14443A (NFC-A) poller: detect a card and
// read its UID, ATQA and SAK; for NFC Forum Type 2 tags (NTAG, Ultralight) also
// GET_VERSION and, on request, READ of memory pages. Read-only: the only card
// commands this file can send are WUPA, ANTICOLLISION/SELECT, GET_VERSION (0x60)
// and READ (0x30); never WRITE, COMPATIBILITY WRITE, PWD_AUTH or lock bits.
//
// The chip setup, registers and the REQA/WUPA, anticollision and select
// sequences are ported from M5Stack's M5Unit-NFC library, commit
// 471a6e02e8052264d39b3ac97005ce4de9d1cb91 (src/unit/unit_ST25R3916.cpp
// begin(), src/unit/unit_ST25R3916_nfca.cpp, src/unit/unit_ST25R3916_util.cpp,
// src/unit/ST25R3916_definition.hpp, src/nfc/a/nfca.hpp). That code carries
// this notice:
//
//   MIT License
//
//   Copyright (c) 2025 M5Stack Technology CO LTD
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// Differences from the library: I2C only, interrupts are polled over I2C (no
// IRQ pin), and the RF field is switched on only for one poll and off again,
// so a card resets between polls and always answers WUPA.
#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace sion::agent {
struct NfcCard {
    uint8_t uid[10]{};
    uint8_t uid_size = 0;   // 4, 7 or 10
    uint16_t atqa = 0;      // As received: second byte high
    uint8_t sak = 0;
    bool has_version = false;   // Type 2 tags: GET_VERSION answer (vendor, type, subtype, version, size, protocol)
    uint8_t version[8]{};
};
// A read of Type 2 memory pages (4 bytes each), done during one poll.
struct NfcRead {
    enum class Code : uint8_t { None, Read, NoCard, Unsupported, Failed };
    static constexpr uint8_t kMaxPages = 64;
    uint8_t page = 0, count = 0;
    Code code = Code::None;
    uint8_t data[kMaxPages * 4]{};
};
// How far polls got since the reader was last enabled: raw counts, one stage per poll
// (the furthest reached), so "never answered" and "answered but garbled" can be told apart.
struct NfcPollStats {
    uint32_t polls = 0;
    uint32_t field_failed = 0;     // Field could not be switched on (already on, or a bus error)
    uint32_t silent = 0;           // WUPA sent, nothing started to come back
    uint32_t partial = 0;          // A reply started (RXS) but no whole ATQA arrived
    uint32_t anticollision_failed = 0;  // ATQA received, UID not read
    uint32_t select_failed = 0;    // UID read, SELECT not answered with a valid SAK
    uint32_t selected = 0;         // Card selected
    uint32_t version_failed = 0;   // Type 2 tag that did not answer GET_VERSION
    uint32_t read_failed = 0;      // Page read attempted and failed
    uint32_t collisions = 0;       // Polls where a bit collision was flagged
    uint32_t error_irq = 0;        // OR of CRC/parity/framing error bits seen
};
inline bool SameCard(const NfcCard& a, const NfcCard& b) {
    return a.uid_size == b.uid_size && std::memcmp(a.uid, b.uid, a.uid_size) == 0;
}

namespace st25r3916 {
// Space A registers.
constexpr uint8_t kIoConfig1 = 0x00, kIoConfig2 = 0x01, kOperation = 0x02, kMode = 0x03, kBitrate = 0x04,
                  kIso14443a = 0x05, kPassiveTargetDef = 0x08, kAuxiliary = 0x0A, kReceiver1 = 0x0B,
                  kNoResponseTimer1 = 0x10, kTimerEmv = 0x12, kMaskMain = 0x16, kMainIrq = 0x1A,
                  kErrorIrq = 0x1C, kPassiveIrq = 0x1D, kFifoStatus1 = 0x1E, kCollision = 0x20, kTxBytes1 = 0x22,
                  kAntennaTuning1 = 0x26, kAntennaTuning2 = 0x27, kTxDriver = 0x28, kPassiveTargetMod = 0x29,
                  kFieldOnThreshold = 0x2A, kFieldOffThreshold = 0x2B, kAuxDisplay = 0x31, kIdentity = 0x3F;
// Space B registers (reached with the 0xFB prefix).
constexpr uint8_t kEmdSuppression = 0x05, kCorrelator1 = 0x0C, kCorrelator2 = 0x0D, kResistiveAm = 0x2A,
                  kOvershoot1 = 0x30, kOvershoot2 = 0x31, kUndershoot1 = 0x32, kUndershoot2 = 0x33;
// Direct commands.
constexpr uint8_t kSetDefault = 0xC1, kStopAll = 0xC2, kTransmitWithCrc = 0xC4, kTransmitWithoutCrc = 0xC5,
                  kTransmitWupa = 0xC7, kInitialFieldOn = 0xC8, kResetRxGain = 0xD5, kAdjustRegulators = 0xD6,
                  kClearFifo = 0xDB, kSpaceB = 0xFB, kTestAccess = 0xFC;
constexpr uint8_t kReadRegister = 0x40, kLoadFifo = 0x80, kReadFifo = 0x9F;
constexpr uint8_t kIdentityType = 0x05;   // ST25R3916/7
// Bits.
constexpr uint8_t kEn = 0x80, kRxEn = 0x40, kTxEn = 0x08, kWakeup = 0x04;
constexpr uint8_t kAatEn = 0x20, kIoDriveLevel = 0x04, kSupply3V = 0x80, kI2cThd0 = 0x10;
constexpr uint8_t kAntiCollision = 0x01, kNoCrcRx = 0x80, kDisableCorrelator = 0x04, kNrtStep = 0x01, kOscOk = 0x10;
constexpr uint8_t kIrqOsc = 0x80;
constexpr uint32_t kIrqOsc32 = 0x80000000u, kIrqRxs32 = 0x20000000u, kIrqRxe32 = 0x10000000u,
                   kIrqCol32 = 0x04000000u, kIrqNre32 = 0x00400000u;
// Card timeouts (ms), from the library's nfca.hpp.
constexpr uint32_t kTimeoutWakeup = 4, kTimeoutAnticollision = 8, kTimeoutSelect = 8, kTimeoutGetVersion = 5, kTimeoutRead = 12;
// Type 2 card commands; nothing else past select is ever sent.
constexpr uint8_t kGetVersion = 0x60, kReadPages = 0x30;
constexpr uint32_t kIrqErrors32 = 0x0000F000u;   // CRC, parity, soft and hard framing errors

inline uint16_t NoResponseTicks(uint32_t ms, bool step4096) {
    const uint64_t step = step4096 ? 4096ull * 1000000 : 64ull * 1000000;
    const uint64_t ticks = (uint64_t(ms) * 1000 * 13560000 + step - 1) / step;
    return static_cast<uint16_t>(std::max<uint64_t>(std::min<uint64_t>(ticks, 0xFFFF), 1));
}
inline uint8_t Bcc(const uint8_t* data, size_t n) {
    uint8_t bcc = 0;
    for (size_t i = 0; i < n; ++i) bcc ^= data[i];
    return bcc;
}
}  // namespace st25r3916

// Bus: Write(bytes,n), Transfer(tx,n,rx,m) as one I2C write-then-read,
// Micros() a monotonic clock and SleepMs(ms).
template <class Bus>
class St25r3916 {
public:
    // Where setup stopped; Identity means the chip at this address is not an ST25R3916.
    enum class Step : uint8_t { None, Identity, SetDefault, Protection, IoConfig, Settings, Oscillator, Regulators, NfcA };
    enum class Poll : uint8_t { Card, NoCard, BusError };
    explicit St25r3916(Bus& bus) : bus_(bus) {}

    // Identity check first: anything else at the address is never written.
    bool Begin() {
        namespace r = st25r3916;
        failed_ = Step::None;
        bus_.SleepMs(50);   // Power-on settling, as the library does.
        bool detected = false;
        for (int attempt = 0; attempt < 5 && !detected; ++attempt) {
            uint8_t id = 0;
            detected = Read(r::kIdentity, id) && ((id >> 3) & 0x1F) == r::kIdentityType && (id & 0x07) != 0;
            if (!detected) bus_.SleepMs(20);
        }
        if (!detected) return Fail(Step::Identity);
        // Leftover activity from before a warm restart.
        Command(r::kStopAll);
        Modify(r::kOperation, 0, r::kTxEn | r::kRxEn);
        bus_.SleepMs(2);
        if (!Command(r::kSetDefault)) return Fail(Step::SetDefault);
        // Keeps the internal overheat protection from tripping below the junction limit.
        const uint8_t protection[] = {0x04, 0x10};
        if (!Command(r::kTestAccess, protection, sizeof protection)) return Fail(Step::Protection);
        // 400 kHz I2C hold time, IO drive level, 3.3 V supply (the library's default).
        const uint8_t io[] = {r::kIoConfig1, r::kI2cThd0, r::kIoDriveLevel | r::kSupply3V};
        if (!Raw(io, sizeof io)) return Fail(Step::IoConfig);
        const bool settings =
            Write(r::kTxDriver, 13 << 4) &&                      // AM modulation depth: library default 13
            Modify(r::kIoConfig1, 0x07, 0x07) &&                 // No clock out on MCU_CLK
            WriteB(r::kResistiveAm, 0x80) && Modify(r::kIoConfig2, r::kAatEn, 0) && WriteB(r::kResistiveAm, 0x00) &&
            Write(r::kFieldOnThreshold, 0x13) && Write(r::kFieldOffThreshold, 0x02) &&
            Modify(r::kPassiveTargetDef, 0x50, 0xF0) && Write(r::kPassiveTargetMod, 0x5F) &&
            WriteB(r::kEmdSuppression, 0x40) && Write(r::kAntennaTuning1, 0x82) && Write(r::kAntennaTuning2, 0x82) &&
            Modify(r::kOperation, 0x03, 0) && Command(r::kClearFifo);
        if (!settings) return Fail(Step::Settings);
        if (!WriteMask(0xFFFF00FFu) || !ClearInterrupts() || !EnableOscillator() || !WriteMask(0))
            return Fail(Step::Oscillator);
        if (!Command(r::kAdjustRegulators)) return Fail(Step::Regulators);
        bus_.SleepMs(5);
        // NFC-A initiator, 106 kbit/s both ways; the field stays off until a poll.
        const bool nfca =
            Command(r::kStopAll) && Modify(r::kOperation, 0, r::kWakeup) &&
            Write(r::kMode, 0x08 | 0x01) && Write(r::kBitrate, 0x00) && Write(r::kIso14443a, 0x00) &&
            Modify(r::kAuxiliary, 0, r::kDisableCorrelator) &&
            WriteB(r::kOvershoot1, 0x40) && WriteB(r::kOvershoot2, 0x03) &&
            WriteB(r::kUndershoot1, 0x40) && WriteB(r::kUndershoot2, 0x03) &&
            WriteB(r::kCorrelator1, 0x47) && WriteB(r::kCorrelator2, 0x00) &&
            WriteReceivers() && Command(r::kResetRxGain) && WriteMask(0);
        if (!nfca) return Fail(Step::NfcA);
        ready_ = true;
        return true;
    }

    // One poll: field on, WUPA, anticollision and select through cascade
    // levels 1..3, GET_VERSION for a Type 2 tag (SAK 0x00), the requested
    // page read if any, field off. A card in the field answers every poll.
    Poll PollOnce(NfcCard& card, NfcRead* read = nullptr) {
        card = {};
        if (!ready_) return Poll::BusError;
        bus_error_ = false;
        ++stats_.polls;
        poll_errors_ = 0; wakeup_started_ = false; collided_ = false;
        const bool field = FieldOn();
        uint16_t atqa = 0;
        const bool found = field && Wakeup(atqa);
        bool completed = false, uid_read = false;
        if (found) {
            card.atqa = atqa;
            for (uint8_t level = 1; level <= 3 && !completed; ++level) {
                if (!SelectLevel(card, level, completed, uid_read)) break;
            }
        }
        // GET_VERSION only for Type 2 tags: other cards may halt on an unknown command.
        if (completed && card.sak == 0x00) {
            card.has_version = GetVersion(card.version);
            if (!card.has_version) ++stats_.version_failed;
        }
        if (read && read->count) {
            read->code = !completed ? NfcRead::Code::NoCard : card.sak != 0x00 ? NfcRead::Code::Unsupported :
                ReadPages(read->page, read->count, read->data) ? NfcRead::Code::Read : NfcRead::Code::Failed;
            if (read->code == NfcRead::Code::Failed) ++stats_.read_failed;
        }
        if (!field) ++stats_.field_failed;
        else if (!found) ++(wakeup_started_ ? stats_.partial : stats_.silent);
        else if (completed) ++stats_.selected;
        else if (uid_read) ++stats_.select_failed;
        else ++stats_.anticollision_failed;
        if (collided_) ++stats_.collisions;
        stats_.error_irq |= poll_errors_;
        const bool off = FieldOff();
        if (bus_error_ || !off) return Poll::BusError;
        return completed ? Poll::Card : Poll::NoCard;
    }

    bool FieldOff() {
        namespace r = st25r3916;
        return Command(r::kStopAll) && Modify(r::kOperation, 0, r::kTxEn | r::kRxEn);
    }
    Step failed() const { return failed_; }
    bool ready() const { return ready_; }
    const NfcPollStats& stats() const { return stats_; }
    void ResetStats() { stats_ = {}; }

private:
    Bus& bus_;
    Step failed_ = Step::None;
    bool ready_ = false, bus_error_ = false, wakeup_started_ = false, collided_ = false;
    uint32_t stored_ = 0, poll_errors_ = 0;
    NfcPollStats stats_{};

    bool Fail(Step step) { failed_ = step; ready_ = false; return false; }
    bool Raw(const uint8_t* bytes, size_t n) {
        if (bus_.Write(bytes, n)) return true;
        bus_error_ = true;
        return false;
    }
    bool ReadRaw(const uint8_t* tx, size_t n, uint8_t* rx, size_t m) {
        if (bus_.Transfer(tx, n, rx, m)) return true;
        bus_error_ = true;
        return false;
    }
    bool Read(uint8_t reg, uint8_t& value) { return ReadN(reg, &value, 1); }
    bool ReadN(uint8_t reg, uint8_t* bytes, size_t n) {
        const uint8_t op = st25r3916::kReadRegister | (reg & 0x3F);
        return ReadRaw(&op, 1, bytes, n);
    }
    bool Write(uint8_t reg, uint8_t value) {
        const uint8_t bytes[] = {static_cast<uint8_t>(reg & 0x3F), value};
        return Raw(bytes, sizeof bytes);
    }
    bool WriteB(uint8_t reg, uint8_t value) {
        const uint8_t bytes[] = {st25r3916::kSpaceB, static_cast<uint8_t>(reg & 0x3F), value};
        return Raw(bytes, sizeof bytes);
    }
    bool Modify(uint8_t reg, uint8_t set, uint8_t clear) {
        uint8_t value = 0;
        if (!Read(reg, value)) return false;
        const uint8_t next = static_cast<uint8_t>((value & ~clear) | set);
        return next == value || Write(reg, next);
    }
    bool Command(uint8_t command, const uint8_t* data = nullptr, size_t n = 0) {
        uint8_t bytes[4] = {command};
        if (n > 3) return false;
        if (n) std::memcpy(bytes + 1, data, n);
        return Raw(bytes, 1 + n);
    }
    bool WriteMask(uint32_t mask) {
        const uint8_t bytes[] = {st25r3916::kMaskMain, uint8_t(mask >> 24), uint8_t(mask >> 16), uint8_t(mask >> 8), uint8_t(mask)};
        return Raw(bytes, sizeof bytes);
    }
    bool WriteReceivers() {
        // z600k; squelch after TX, AGC on for the whole receive at 6:1; gain set for stability.
        const uint8_t bytes[] = {st25r3916::kReceiver1, 0x08, 0x2D, 0xD8, 0x22};
        return Raw(bytes, sizeof bytes);
    }
    // The error register clears when the main one is read, so read it first.
    bool ReadInterrupts(uint32_t& value) {
        namespace r = st25r3916;
        uint8_t error = 0, main[2]{}, passive = 0;
        if (!Read(r::kErrorIrq, error) || !ReadN(r::kMainIrq, main, 2) || !Read(r::kPassiveIrq, passive)) return false;
        value = (uint32_t(main[0]) << 24) | (uint32_t(main[1]) << 16) | (uint32_t(error) << 8) | passive;
        return true;
    }
    bool ClearInterrupts() {
        stored_ = 0;
        uint8_t discard[4]{};
        return ReadN(st25r3916::kMainIrq, discard, sizeof discard);
    }
    uint32_t WaitInterrupt(uint32_t bits, uint32_t ms) {
        const uint64_t start = bus_.Micros();
        do {
            uint32_t value = 0;
            if (ReadInterrupts(value)) { stored_ |= value; poll_errors_ |= value & st25r3916::kIrqErrors32; }
            if (const uint32_t hit = stored_ & bits) { stored_ &= ~hit; return hit; }
        } while (bus_.Micros() - start < uint64_t(ms) * 1000);
        return stored_ | st25r3916::kIrqNre32;
    }
    bool EnableOscillator() {
        namespace r = st25r3916;
        uint8_t operation = 0, aux = 0;
        if (!Read(r::kOperation, operation)) return false;
        if (!(operation & r::kEn)) {
            if (!Modify(r::kMaskMain, 0, r::kIrqOsc) || !ClearInterrupts() || !Modify(r::kOperation, r::kEn, 0)) return false;
            const uint32_t irq = WaitInterrupt(r::kIrqOsc32, 50);
            Modify(r::kMaskMain, r::kIrqOsc, 0);
            (void)irq;   // A missed edge is fine: osc_ok below decides.
        }
        return Read(r::kAuxDisplay, aux) && (aux & r::kOscOk);
    }
    bool FieldOn() {
        namespace r = st25r3916;
        uint8_t operation = 0;
        if (!Read(r::kOperation, operation)) return false;
        if (operation & r::kTxEn) return false;
        if (!Command(r::kInitialFieldOn)) return false;
        bus_.SleepMs(5);
        if (!Modify(r::kOperation, r::kTxEn | r::kRxEn, 0)) return false;
        bus_.SleepMs(5);   // ISO14443-3 guard time before the first command.
        return true;
    }
    bool WriteTimeout(uint32_t ms) {
        namespace r = st25r3916;
        uint8_t control = 0;
        if (!Read(r::kTimerEmv, control)) return false;
        const uint16_t ticks = r::NoResponseTicks(ms, control & r::kNrtStep);
        const uint8_t bytes[] = {r::kNoResponseTimer1, uint8_t(ticks >> 8), uint8_t(ticks)};
        return Raw(bytes, sizeof bytes);
    }
    bool FifoSize(uint16_t& bytes, uint8_t& bits) {
        uint8_t status[2]{};
        if (!ReadN(st25r3916::kFifoStatus1, status, 2)) return false;
        bytes = static_cast<uint16_t>(status[0] | ((status[1] & 0xC0) << 2));
        bits = (status[1] >> 1) & 0x07;
        return true;
    }
    bool ReadFifo(uint8_t* out, uint16_t room, uint16_t& actual) {
        actual = 0;
        uint16_t bytes = 0;
        uint8_t bits = 0;
        if (!FifoSize(bytes, bits)) return false;
        const uint16_t n = std::min(bytes, room);
        const uint8_t op = st25r3916::kReadFifo;
        if (!n || !ReadRaw(&op, 1, out, n)) return false;
        actual = n;
        return true;
    }
    bool LoadFifo(const uint8_t* data, size_t n) {
        uint8_t bytes[8] = {st25r3916::kLoadFifo};
        if (!n || n > 7) return false;
        std::memcpy(bytes + 1, data, n);
        return Raw(bytes, 1 + n);
    }
    bool TransmitCount(uint16_t bytes, uint8_t bits) {
        const uint16_t value = static_cast<uint16_t>(((bytes & 0x01FF) << 3) | (bits & 0x07));
        const uint8_t out[] = {st25r3916::kTxBytes1, uint8_t(value >> 8), uint8_t(value)};
        return Raw(out, sizeof out);
    }
    // Waits for the FIFO to hold at least `want` bytes after a start of receive.
    bool WaitFifo(uint32_t ms, uint16_t want) {
        const uint64_t start = bus_.Micros();
        uint16_t bytes = 0;
        uint8_t bits = 0;
        do {
            if (FifoSize(bytes, bits) && bytes >= want) return true;
        } while (bus_.Micros() - start < uint64_t(ms) * 1000);
        return false;
    }
    bool Wakeup(uint16_t& atqa) {
        namespace r = st25r3916;
        atqa = 0;
        if (!WriteTimeout(r::kTimeoutWakeup) || !Write(r::kIso14443a, r::kAntiCollision) ||
            !Modify(r::kAuxiliary, r::kNoCrcRx, 0) || !ClearInterrupts() || !Command(r::kClearFifo) ||
            !Command(r::kTransmitWupa)) return false;
        uint32_t irq = WaitInterrupt(r::kIrqRxe32 | r::kIrqRxs32 | r::kIrqCol32, r::kTimeoutWakeup);
        wakeup_started_ = (irq & (r::kIrqRxs32 | r::kIrqRxe32 | r::kIrqCol32)) != 0;
        if (irq & r::kIrqCol32) collided_ = true;
        if (!(irq & r::kIrqRxe32) && (irq & r::kIrqRxs32) && WaitFifo(r::kTimeoutWakeup, 2)) irq |= r::kIrqRxe32;
        if (!(irq & r::kIrqRxe32)) return false;
        uint8_t answer[2]{};
        uint16_t actual = 0;
        if (!ReadFifo(answer, 2, actual) || actual != 2) return false;
        atqa = static_cast<uint16_t>((answer[1] << 8) | answer[0]);   // Inexact when two cards answered.
        return true;
    }
    // ANTICOLLISION at one cascade level; rbuf gets UID CLn (4 bytes) and its BCC.
    bool Anticollision(uint8_t rbuf[5], uint8_t level) {
        namespace r = st25r3916;
        if (!WriteTimeout(r::kTimeoutAnticollision) || !Write(r::kIso14443a, r::kAntiCollision) ||
            !Modify(r::kAuxiliary, 0, r::kNoCrcRx)) return false;
        uint8_t frame[7] = {static_cast<uint8_t>(0x91 + level * 2), 0x20};
        uint32_t sbytes = 2, sbits = 0;
        uint8_t offset = 0, collided = 1;
        uint16_t actual = 0;
        bool collision = false;
        uint32_t tries = 32;
        do {
            if (!ClearInterrupts() || !Command(r::kClearFifo) || !LoadFifo(frame, sbytes + (sbits != 0)) ||
                !TransmitCount(uint16_t(sbytes), uint8_t(sbits)) || !Command(r::kTransmitWithoutCrc)) return false;
            const uint32_t irq = WaitInterrupt(r::kIrqRxe32 | r::kIrqCol32, r::kTimeoutAnticollision);
            collision = irq & r::kIrqCol32;
            if (collision) collided_ = true;
            if (!collision && !(irq & r::kIrqRxe32)) return false;
            uint8_t display = 0;
            if (!ReadFifo(rbuf + offset, uint16_t(5 - offset), actual) || !actual || !Read(r::kCollision, display)) return false;
            if (collision) {
                const uint8_t cbytes = (display >> 4) & 0x0F, cbits = (display >> 1) & 0x07;
                collided = static_cast<uint8_t>(rbuf[offset + actual - 1] | (1u << cbits));
                sbytes = cbytes + (cbits == 0x07);
                sbits = (cbits + 1) & 0x07;
                // The display is raw and its byte field can name a position outside the frame.
                if (sbytes < 2 || sbytes >= sizeof frame) return false;
                frame[1] = static_cast<uint8_t>((sbytes << 4) | sbits);
                std::memcpy(frame + 2 + offset, rbuf + offset, actual);
                frame[sbytes] = collided;
                offset = static_cast<uint8_t>(actual - 1);
            }
            if (sbits) {
                rbuf[offset] = static_cast<uint8_t>(rbuf[offset] >> sbits);
                rbuf[offset] = static_cast<uint8_t>(rbuf[offset] << sbits);
                rbuf[offset] |= collided;
            }
        } while (collision && tries--);
        // A short answer leaves zeroes behind; only a full UID CLn with a matching BCC counts.
        return !collision && offset + actual == 5 && rbuf[4] == r::Bcc(rbuf, 4);
    }
    bool SelectLevel(NfcCard& card, uint8_t level, bool& completed, bool& uid_read) {
        namespace r = st25r3916;
        completed = false;
        uint8_t rbuf[5]{};
        if (!Anticollision(rbuf, level)) return false;
        uid_read = true;
        const bool cascade_tag = rbuf[0] == 0x88;
        std::memcpy(card.uid + (level - 1) * 3, rbuf + cascade_tag, 4 - cascade_tag);
        uint8_t select[7] = {static_cast<uint8_t>(0x91 + level * 2), 0x70};
        std::memcpy(select + 2, rbuf, sizeof rbuf);
        if (!WriteTimeout(r::kTimeoutSelect) || !Write(r::kIso14443a, 0x00) || !Modify(r::kAuxiliary, 0, r::kNoCrcRx) ||
            !ClearInterrupts() || !Command(r::kClearFifo) || !LoadFifo(select, sizeof select) ||
            !TransmitCount(sizeof select, 0) || !Command(r::kTransmitWithCrc)) return false;
        const uint32_t irq = WaitInterrupt(r::kIrqRxe32, r::kTimeoutSelect);
        if (!(irq & r::kIrqRxe32) && !((irq & r::kIrqRxs32) && WaitFifo(r::kTimeoutSelect, 3))) return false;
        uint8_t answer[3]{};   // SAK and its CRC
        uint16_t actual = 0;
        if (!ReadFifo(answer, 3, actual) || actual != 3) return false;
        const uint8_t sak = answer[0];
        if ((sak & 0x24) == 0x20 || (sak & 0x24) == 0x00) {   // UID complete (ISO14443-4 or not)
            card.uid_size = static_cast<uint8_t>(1 + level * 3);
            card.sak = sak;
            completed = true;
            return true;
        }
        return (sak & 0x04) != 0;   // Cascade bit: the UID continues at the next level.
    }
    // One command with CRC to a selected card; true only with exactly `want`
    // bytes back (answer plus its CRC) and no receive error. A 4-bit NAK fails.
    bool Exchange(const uint8_t* tx, size_t n, uint8_t* rx, uint16_t want, uint32_t ms) {
        namespace r = st25r3916;
        if (!WriteTimeout(ms) || !Write(r::kIso14443a, 0x00) || !Modify(r::kAuxiliary, 0, r::kNoCrcRx) ||
            !ClearInterrupts() || !Command(r::kClearFifo) || !LoadFifo(tx, n) ||
            !TransmitCount(uint16_t(n), 0) || !Command(r::kTransmitWithCrc)) return false;
        const uint32_t irq = WaitInterrupt(r::kIrqRxe32, ms);
        if (!(irq & r::kIrqRxe32) && !((irq & r::kIrqRxs32) && WaitFifo(ms, want))) return false;
        if (stored_ & r::kIrqErrors32) return false;
        uint16_t actual = 0;
        return ReadFifo(rx, want, actual) && actual == want;
    }
    bool GetVersion(uint8_t version[8]) {
        const uint8_t command = st25r3916::kGetVersion;
        uint8_t answer[10]{};
        if (!Exchange(&command, 1, answer, sizeof answer, st25r3916::kTimeoutGetVersion)) return false;
        std::memcpy(version, answer, 8);
        return true;
    }
    // READ returns four pages (16 bytes) from `page`; keep what was asked for.
    bool ReadPages(uint8_t page, uint8_t count, uint8_t* out) {
        if (!count || count > NfcRead::kMaxPages || page + count > 256) return false;
        for (unsigned done = 0; done < count; done += 4) {
            const uint8_t command[] = {st25r3916::kReadPages, static_cast<uint8_t>(page + done)};
            uint8_t answer[18]{};
            if (!Exchange(command, sizeof command, answer, sizeof answer, st25r3916::kTimeoutRead)) return false;
            std::memcpy(out + done * 4, answer, std::min(4u, count - done) * 4);
        }
        return true;
    }
};

// Card presence from successive polls: one event when a card arrives, one
// when it has been missing from kMisses polls in a row.
struct NfcEvent { bool present = false; NfcCard card; uint64_t at = 0; };
class NfcPresence {
public:
    static constexpr unsigned kMisses = 2;
    template <class Emit>
    void Note(bool found, const NfcCard& card, uint64_t now, Emit emit) {
        if (found) {
            if (have_ && !SameCard(card, current_)) { emit(NfcEvent{false, current_, now}); have_ = false; }
            misses_ = 0;
            if (!have_) { have_ = true; current_ = card; emit(NfcEvent{true, card, now}); }
            return;
        }
        if (have_ && ++misses_ >= kMisses) { have_ = false; misses_ = 0; emit(NfcEvent{false, current_, now}); }
    }
    void Reset() { have_ = false; misses_ = 0; }
private:
    bool have_ = false;
    unsigned misses_ = 0;
    NfcCard current_{};
};

// Board side. Polling (short RF field pulses) runs only while enabled; the
// session enables it for an active conversation.
struct NfcPort {
    virtual ~NfcPort() = default;
    virtual bool Ready() const = 0;   // Chip found and set up
    // Turning on starts afresh: a card already on the reader is reported again.
    virtual void Enable(bool on) = 0;
    virtual bool Take(NfcEvent& event) = 0;
    // A page read done at the next poll while enabled; false while one is pending.
    virtual bool RequestRead(uint8_t page, uint8_t count) = 0;
    // The finished read and the card it came from (empty card when none).
    virtual bool TakeRead(NfcRead& read, NfcCard& card) = 0;
    // Poll stage counts since the reader was last enabled.
    virtual NfcPollStats Stats() { return {}; }
};
}  // namespace sion::agent
