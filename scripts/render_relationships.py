from pathlib import Path
import json, html
root = Path(__file__).resolve().parents[1]
edges = json.loads((root / 'wiki/relationships.json').read_text())
height = 108 + len(edges) * 79
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="{height}" viewBox="0 0 1080 {height}">',
'<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#506781"/></marker></defs>',
'<rect width="100%" height="100%" fill="#f8fafc"/>',
'<text x="28" y="32" font-family="sans-serif" font-size="22" fill="#152c48">Sion: scoped producers, consumers and lifecycle</text>',
'<text x="28" y="60" font-family="sans-serif" font-size="15" fill="#53657a">Solid = partial code; dashed = proposed / consumer missing. No live acceptance claimed.</text>']
for i,e in enumerate(edges):
    y = 85 + i * 79
    partial = e['status'] in ('core-implemented-runtime-unverified', 'firmware-built-hardware-unverified', 'host-code-tested-device-unverified')
    stroke = '' if partial else ' stroke-dasharray="5 4"'
    color = '#e0ecfa' if partial else '#fff2df'
    esc = html.escape
    parts += [f'<g id="{esc(e["id"])}"><title>{esc(e.get("detail", e["status"]))}</title>',
    f'<text x="28" y="{y+23}" font-family="monospace" font-size="16">{esc(e["id"])}</text>',
    f'<rect x="95" y="{y}" width="270" height="36" rx="7" fill="{color}"/>',
    f'<rect x="760" y="{y}" width="290" height="36" rx="7" fill="{color}"/>',
    f'<path d="M375,{y+22} H748" stroke="#506781" stroke-width="2"{stroke} marker-end="url(#arrow)"/>',
    f'<text x="110" y="{y+24}" font-family="sans-serif" font-size="17">{esc(e["producer"])}</text>',
    f'<text x="775" y="{y+24}" font-family="sans-serif" font-size="17">{esc(e["consumer"])}</text>',
    f'<text x="565" y="{y+13}" text-anchor="middle" font-family="sans-serif" font-size="15">{esc(e["data"])}</text>',
    f'<text x="95" y="{y+57}" font-family="sans-serif" font-size="13" fill="#53657a">{esc(e["status"])}</text></g>']
parts.append('</svg>')
(root / 'wiki/assets/relationships.svg').write_text('\n'.join(parts))

# Readable local projections, retaining the complete export and stable IDs.
header = parts[:5]
for start in range(0, len(edges), 9):
    subset = edges[start:start+9]
    small_height = 1080  # Square viewBox also prevents Quick Look thumbnail cropping.
    part = [header[0].replace(str(height), str(small_height))] + header[1:]
    # Reuse generated groups, translate each row to its local position.
    for offset in range(len(subset)):
        group = ''.join(parts[5 + (start+offset)*9:5 + (start+offset+1)*9])
        part.append(f'<g transform="translate(0,{-start*79})">{group}</g>')
    part.append('</svg>')
    (root / f'wiki/assets/relationships-{start//9+1}.svg').write_text('\n'.join(part))
