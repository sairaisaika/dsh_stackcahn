#!/usr/bin/env python3
"""Compile and run the power-key boot selector's host test (no device, no ESP-IDF)."""
import subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as d:
    out = Path(d)/'pek'
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-g',
                    str(root/'firmware/boot-selector-pek/test/pek_logic_test.c'), '-o', str(out)], check=True)
    subprocess.run([str(out)], check=True)
