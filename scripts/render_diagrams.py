"""Render the Wiki's Mermaid source projections; no hardware or user browser access."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cli', type=Path, default=root/'work/wiki-renderer/node_modules/.bin/mmdc')
parser.add_argument('--browser', type=Path, help='Optional installed Chromium/Chrome executable')
parser.add_argument('--png-dir', type=Path, help='Optional private preview output directory')
args = parser.parse_args()
sources = sorted((root/'wiki/diagrams').glob('*.mmd'))
if not sources:
    raise SystemExit('No Mermaid source diagrams found')
output = root/'wiki/assets/views'
output.mkdir(parents=True, exist_ok=True)
if args.png_dir:
    args.png_dir.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='sion-wiki-render-') as directory:
    temporary = Path(directory)
    browser = temporary/'browser.json'
    browser.write_text(json.dumps({'executablePath': str(args.browser)} if args.browser else {}))
    config = temporary/'mermaid.json'
    config.write_text(json.dumps({
        'theme': 'neutral', 'fontFamily': 'Arial, PingFang SC, Noto Sans CJK SC, sans-serif',
        'sequence': {'useMaxWidth': False, 'wrap': True, 'width': 220,
                     'messageFontSize': 16, 'noteFontSize': 15},
        'flowchart': {'useMaxWidth': False, 'htmlLabels': False, 'wrappingWidth': 340},
    }))
    for source in sources:
        command = [str(args.cli.resolve()), '-i', str(source), '-p', str(browser),
                   '-c', str(config), '-b', 'white', '--size', '1600']
        subprocess.run(command+['-o', str(output/(source.stem+'.svg'))], check=True, timeout=90)
        if args.png_dir:
            subprocess.run(command+['-o', str(args.png_dir/(source.stem+'.png'))], check=True, timeout=90)
        print(source.name, 'rendered', flush=True)
print(f'{len(sources)} diagrams rendered; semantic review and runtime validation remain separate.')
