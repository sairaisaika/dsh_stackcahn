"""Build prepared firmware with an exported ESP-IDF environment; never flash."""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT/'work/firmware-build/firmware')
args = parser.parse_args()
source = args.source.resolve()
if not (source/'xiaozhi-esp32/main/sion/backend_runtime.cc').is_file():
    raise SystemExit('Run prepare_firmware.py --sion for this checkout first')
subprocess.run([
    'idf.py', '-C', str(source),
    '-DSDKCONFIG='+str(source/'build/sion-pairing-sdkconfig'),
    '-DSDKCONFIG_DEFAULTS='+str(source/'sdkconfig.defaults')+';'+str(ROOT/'firmware/feature.defaults'),
    'build',
], check=True)
print('Build only. Device ports were not opened; printed SDK flash suggestions were not executed.')
