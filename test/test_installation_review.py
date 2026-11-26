"""Offline corruption/bounds checks; no private fixtures, ports or network."""
import json
from pathlib import Path
import struct
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prepare_installation import assets_info, image_info, ota_records


def ota(seq, state):
    data = bytearray(b'\xff' * 4096)
    struct.pack_into('<I', data, 0, seq)
    struct.pack_into('<II', data, 24, state, zlib.crc32(data[:4], 0xffffffff))
    return data


def assets():
    index = json.dumps({'version': 1, 'srmodels': 'model', 'text_font': 'font'}).encode()
    files = [('index.json', index), ('model', b'model fixture'), ('font', b'font fixture')]
    table, payload = bytearray(), bytearray()
    for name, value in files:
        table += struct.pack('<32sIIHH', name.encode(), len(value), len(payload), 0, 0)
        payload += b'ZZ' + value
    body = table + payload
    return struct.pack('<III', len(files), sum(body) & 0xffff, len(body)) + body


class InstallationReviewTests(unittest.TestCase):
    def test_aborted_slot_is_not_original(self):
        records = ota_records(ota(3, 4) + ota(2, 2))
        self.assertFalse(records[0]['valid'])
        self.assertTrue(records[1]['valid'])

    def test_ota_crc_corruption(self):
        data = ota(2, 2) + ota(3, 0)
        data[0] ^= 1
        self.assertFalse(ota_records(data)[0]['valid'])

    def test_ota_length(self):
        with self.assertRaises(ValueError):
            ota_records(ota(2, 2))

    def test_erased_ota_not_valid(self):
        self.assertFalse(any(r['valid'] for r in ota_records(b'\xff' * 8192)))

    def test_asset_payload_skips_marker(self):
        self.assertEqual(assets_info(assets())['files'], 3)

    def test_asset_checksum_corruption(self):
        data = bytearray(assets()); data[-1] ^= 1
        with self.assertRaisesRegex(ValueError, 'checksum'):
            assets_info(data)

    def test_asset_bounds_even_with_valid_checksum(self):
        data = bytearray(assets())
        struct.pack_into('<I', data, 12 + 36, len(data) + 20)
        struct.pack_into('<I', data, 4, sum(data[12:]) & 0xffff)
        with self.assertRaisesRegex(ValueError, 'entry'):
            assets_info(data)

    def test_bad_asset_marker_even_with_valid_checksum(self):
        data = bytearray(assets()); data[12 + 3 * 44] = 0
        struct.pack_into('<I', data, 4, sum(data[12:]) & 0xffff)
        with self.assertRaisesRegex(ValueError, 'marker'):
            assets_info(data)

    def test_image_checksum_and_digest(self):
        from esptool.bin_image import ESP32S3FirmwareImage, ImageSegment
        image = ESP32S3FirmwareImage()
        image.segments = [ImageSegment(0x3fc80000, b'\x00' * 256)]
        image.segments[0].name = '.fixture'
        data = image.save(None)
        self.assertTrue(image_info(data)['digestValid'])
        bad = bytearray(data); bad[40] ^= 1
        with self.assertRaisesRegex(ValueError, 'checksum'):
            image_info(bad)
        bad = bytearray(data); bad[-1] ^= 1
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            image_info(bad)


if __name__ == '__main__':
    unittest.main()
