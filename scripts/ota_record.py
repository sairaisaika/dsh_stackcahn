"""Encode the reviewed ESP-IDF OTA record for offline comparisons and fixtures."""
import struct
import zlib

OTA_NEW, OTA_PENDING_VERIFY, OTA_VALID, OTA_INVALID, OTA_ABORTED = 0, 1, 2, 3, 4


def ota_record(sequence, state):
    seq = struct.pack('<I', sequence)
    return seq + b'\xff' * 20 + struct.pack('<II', state, zlib.crc32(seq, 0xffffffff))
