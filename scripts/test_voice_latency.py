import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from voice_latency import read_intervals, summarize


SCRIPT = Path(__file__).with_name("voice_latency.py")


class VoiceLatencyTest(unittest.TestCase):
    def test_regions_report_typical_and_tail_latency_without_dropping_failures(self):
        intervals = read_intervals([
            "12.000000\t13.201000\treply\n",
            "0.500000\t1.300000\treply\n",
            "4.000000\t6.000000\treply-timeout\n",
            "7.000000\t7.300000\tstop\n",
            "8.000000\t8.600000\tstop-unclear\n",
        ])
        report = summarize(intervals)
        self.assertEqual(report["reply"], {
            "attempts": 3, "measured": 2, "timeout": 1, "unclear": 0,
            "p50_ms": 1001, "p95_ms": 1201, "p95_uses_sample_maximum": True,
        })
        self.assertEqual(report["stop"]["unclear"], 1)
        self.assertEqual(report["stop"]["p50_ms"], 300)

    def test_nearest_rank_and_missing_measurements(self):
        rows = [f"{index}.000000\t{index}.{index + 1:03d}\treply\n" for index in range(20)]
        rows.append("25\t28\tstop-timeout")
        report = summarize(read_intervals(rows))
        self.assertEqual(report["reply"]["p95_ms"], 19)
        self.assertFalse(report["reply"]["p95_uses_sample_maximum"])
        self.assertEqual(report["stop"]["attempts"], 1)
        self.assertIsNone(report["stop"]["p95_ms"])

    def test_rejects_missing_invalid_duplicate_and_overlapping_regions(self):
        bad_label_sets = [
            [],
            ["3\t3\treply"],
            ["3\t2\treply"],
            ["nan\t2\treply"],
            ["-1\t2\treply"],
            ["3\t4\tuser audio transcript"],
            ["3 4 reply"],
            ["3\t4\treply", "3\t4\treply"],
            ["3\t5\treply", "4\t6\tstop"],
        ]
        for lines in bad_label_sets:
            with self.subTest(lines=lines), self.assertRaises(ValueError):
                read_intervals(lines)

    def test_cli_reports_transports_separately_without_echoing_input_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            usb = Path(directory, "private-usb.txt")
            lan = Path(directory, "private-lan.txt")
            relay = Path(directory, "private-relay.txt")
            usb.write_text("\ufeff1\t2\treply\n", encoding="utf-8")
            lan.write_text("1\t2.5\treply\n", encoding="utf-8")
            relay.write_text("1\t4\treply-timeout\n", encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--source", "synthetic", "--phase", "warm"]
            report = subprocess.run(command + ["--usb", str(usb), "--lan", str(lan), "--relay", str(relay)],
                                    check=True, capture_output=True, text=True).stdout
            result = json.loads(report)
            self.assertEqual(result["source"], "synthetic")
            self.assertNotIn(directory, report)
            self.assertEqual(result["transports"]["usb"]["reply"]["p50_ms"], 1000)
            self.assertEqual(result["transports"]["lan"]["reply"]["p50_ms"], 1500)
            self.assertEqual(result["transports"]["relay"]["reply"]["timeout"], 1)
            self.assertNotIn("noise", result["transports"])
            duplicate = subprocess.run(command + ["--usb", str(usb), "--lan", str(usb)],
                                       capture_output=True, text=True)
            self.assertEqual(duplicate.returncode, 2)
            self.assertEqual(duplicate.stdout, "")
            self.assertIn("separate label file", duplicate.stderr)


if __name__ == "__main__":
    unittest.main()
