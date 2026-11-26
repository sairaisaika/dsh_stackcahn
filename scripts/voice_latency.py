#!/usr/bin/env python3
"""Summarize human-verified acoustic intervals exported as Audacity labels."""

import argparse
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import statistics


TRANSPORTS = ("usb", "lan", "relay")
METRICS = ("reply", "stop")
OUTCOMES = ("measured", "timeout", "unclear")
LABELS = {
    metric if outcome == "measured" else f"{metric}-{outcome}": (metric, outcome)
    for metric in METRICS
    for outcome in OUTCOMES
}
TIMESTAMP = re.compile(r"[0-9]+(?:\.[0-9]+)?")


def read_intervals(lines):
    intervals = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        fields = line.rstrip("\r\n").split("\t")
        if len(fields) != 3 or not all(TIMESTAMP.fullmatch(value) for value in fields[:2]):
            raise ValueError(f"line {number}: expected start, end and label in standard Audacity format")
        start, end = map(Decimal, fields[:2])
        label = fields[2]
        if label not in LABELS:
            raise ValueError(f"line {number}: expected one of {', '.join(LABELS)}")
        if end <= start:
            raise ValueError(f"line {number}: expected a region with positive duration")
        intervals.append((start, end, label, number))
    if not intervals:
        raise ValueError("the file contains no attempts")
    intervals.sort()
    for previous, current in zip(intervals, intervals[1:]):
        if current[0] < previous[1]:
            raise ValueError(f"lines {previous[3]} and {current[3]}: duplicate or overlapping regions")
    return intervals


def to_milliseconds(seconds):
    return int((seconds * 1000).to_integral_value(rounding=ROUND_HALF_UP))


def summarize(intervals):
    outcomes = {metric: Counter() for metric in METRICS}
    durations = {metric: [] for metric in METRICS}
    for start, end, label, _ in intervals:
        metric, outcome = LABELS[label]
        outcomes[metric][outcome] += 1
        if outcome == "measured":
            durations[metric].append(end - start)

    result = {}
    for metric in METRICS:
        counts = outcomes[metric]
        values = sorted(durations[metric])
        measured = len(values)
        p95_index = (95 * measured + 99) // 100 - 1
        result[metric] = {
            "attempts": sum(counts.values()),
            **{outcome: counts[outcome] for outcome in OUTCOMES},
            "p50_ms": to_milliseconds(statistics.median(values)) if values else None,
            "p95_ms": to_milliseconds(values[p95_index]) if values else None,
            "p95_uses_sample_maximum": (p95_index == measured - 1) if values else None,
        }
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("synthetic", "hardware"), required=True,
                        help="Origin declared by the operator")
    parser.add_argument("--phase", choices=("cold", "warm"), required=True,
                        help="Collect first turns and warmed turns in separate batches")
    for mode in TRANSPORTS:
        parser.add_argument(f"--{mode}", type=Path, help=f"Audacity labels for {mode}")
    args = parser.parse_args(argv)
    results = {}
    seen_files = set()
    for mode in TRANSPORTS:
        path = getattr(args, mode)
        if path is None:
            continue
        try:
            info = path.stat()
            identity = (info.st_dev, info.st_ino)
            if identity in seen_files:
                raise ValueError("supply a separate label file for each transport")
            with path.open(encoding="utf-8-sig") as labels:
                results[mode] = summarize(read_intervals(labels))
            seen_files.add(identity)
        except (OSError, ValueError) as error:
            parser.error(f"{mode}: {error}")
    if not results:
        parser.error("supply at least one of --usb, --lan or --relay")
    print(json.dumps({
        "schema_version": 1,
        "source": args.source,
        "phase": args.phase,
        "transports": results,
    }, indent=2))


if __name__ == "__main__":
    main()
