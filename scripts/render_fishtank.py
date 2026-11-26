#!/usr/bin/env python3
"""Test frames for the head-coupled view (wiki/head-coupled-view.md).

Ray-casts a small fish tank behind StackChan's screen: gridded walls, a sand floor,
bubbles and a simple whale built from ellipsoids. The screen is a window; the eye
sits at angle alpha from the screen normal (off-axis projection), and the whale
turns to yaw psi inside the tank. Writes 320x240 24-bit BMPs plus a timeline JSON
for scripts/body_probe.mjs. Test content only: not the whale-girl art.

  python3 scripts/render_fishtank.py OUT_DIR

Sets (slots follow the order the probe's "storedir" gives them):
  OUT_DIR/turn/    13 frames, eye on the normal, whale psi -60..60 in 10 degree steps
  OUT_DIR/window/   9 frames, owner still in front while the head turns theta
                    -30..30 in 7.5 degree steps: eye at alpha = theta, whale kept
                    facing the room (psi = theta), so she keeps looking at the owner
  OUT_DIR/inside/   9 frames, the same head angles with the whale fixed in the tank (psi = 0),
                    so from the owner's place her side shows as the head turns
  OUT_DIR/sweep.json  head yaw sine +-30 degrees over 8 s with the matching window
                    frames (slots 13..21) on one timeline
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 320, 240
SCREEN_W, SCREEN_H = 40.8, 30.6   # mm, 2.0 inch IPS
DEPTH = 32.0                       # tank depth behind the glass, mm
EYE_DISTANCE = 350.0               # mm
SUPERSAMPLE = 2
LIGHT = np.array([0.35, 0.8, 0.5]); LIGHT /= np.linalg.norm(LIGHT)

# Whale parts in its own frame (forward +z, up +y), mm: centre, radii, colour.
BODY_BLUE = np.array([70, 125, 205]) / 255
BELLY = np.array([225, 235, 245]) / 255
PARTS = [
    ((0.0, 0.0, 0.0), (6.5, 5.6, 10.5), 'body'),
    ((0.0, 1.0, -11.5), (6.5, 1.2, 3.0), BODY_BLUE * 0.9),     # tail flukes
    ((6.3, -2.4, 2.5), (3.2, 0.8, 1.8), BODY_BLUE * 0.85),     # fins
    ((-6.3, -2.4, 2.5), (3.2, 0.8, 1.8), BODY_BLUE * 0.85),
    ((3.9, 1.2, 7.6), (1.05, 1.05, 1.05), np.array([0.05, 0.05, 0.08])),   # eyes
    ((-3.9, 1.2, 7.6), (1.05, 1.05, 1.05), np.array([0.05, 0.05, 0.08])),
    ((3.6, -0.6, 8.3), (1.1, 0.5, 0.4), np.array([0.98, 0.62, 0.70])),     # cheeks
    ((-3.6, -0.6, 8.3), (1.1, 0.5, 0.4), np.array([0.98, 0.62, 0.70])),
]
WHALE_AT = np.array([0.0, -2.5, -15.0])
BUBBLES = [((-14.0, 6.0, -6.0), 1.6), ((-12.5, 10.5, -10.0), 1.0), ((13.5, 2.0, -26.0), 2.0),
           ((15.0, 8.5, -21.0), 1.2), ((-6.0, 12.0, -29.0), 1.4)]


def rays(alpha_deg):
    """Eye position and unit directions through every (supersampled) pixel."""
    a = math.radians(alpha_deg)
    eye = np.array([EYE_DISTANCE * math.sin(a), 0.0, EYE_DISTANCE * math.cos(a)])
    sw, sh = W * SUPERSAMPLE, H * SUPERSAMPLE
    xs = ((np.arange(sw) + 0.5) / sw - 0.5) * SCREEN_W
    ys = (0.5 - (np.arange(sh) + 0.5) / sh) * SCREEN_H
    px, py = np.meshgrid(xs, ys)
    points = np.stack([px, py, np.zeros_like(px)], -1)
    d = points - eye
    return eye, d / np.linalg.norm(d, axis=-1, keepdims=True)


def ellipsoid_hit(origin, dirs, centre, radii):
    """Nearest t and the surface normal for a ray bundle against an axis-aligned ellipsoid."""
    r = np.array(radii)
    o = (origin - centre) / r
    d = dirs / r
    a = (d * d).sum(-1)
    b = 2 * (d * o).sum(-1)
    c = (o * o).sum() - 1
    disc = b * b - 4 * a * c
    t = np.where(disc >= 0, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a), np.inf)
    t = np.where(t > 0, t, np.inf)
    p = origin + dirs * t[..., None]
    with np.errstate(invalid='ignore'):
        n = (p - centre) / (r * r)
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)
    return t, np.nan_to_num(n)


def shade(colour, normal, view, spec=0.25):
    lam = np.clip((normal * LIGHT).sum(-1), 0, 1)[..., None]
    h = LIGHT - view
    h /= np.linalg.norm(h, axis=-1, keepdims=True)
    s = np.clip((normal * h).sum(-1), 0, 1)[..., None] ** 40 * spec
    return colour * (0.38 + 0.62 * lam) + s


def tank(eye, dirs):
    """Colour of the tank wall each ray reaches (the rays pass the glass at z=0)."""
    big = np.full(dirs.shape[:-1], np.inf)
    hit = {}
    for name, axis, value in (('left', 0, -SCREEN_W / 2), ('right', 0, SCREEN_W / 2), ('floor', 1, -SCREEN_H / 2),
                              ('top', 1, SCREEN_H / 2), ('back', 2, -DEPTH)):
        with np.errstate(divide='ignore', invalid='ignore'):
            t = (value - eye[axis]) / dirs[..., axis]
        p = eye + dirs * t[..., None]
        inside = (t > 0) & (p[..., 2] <= 1e-6) & (p[..., 2] >= -DEPTH - 1e-6) & \
            (np.abs(p[..., 0]) <= SCREEN_W / 2 + 1e-6) & (np.abs(p[..., 1]) <= SCREEN_H / 2 + 1e-6)
        hit[name] = np.where(inside, t, np.inf)
    names = list(hit)
    stack = np.stack([hit[n] for n in names])
    which = stack.argmin(0)
    t = stack.min(0)
    p = eye + dirs * t[..., None]
    depth = np.clip(-p[..., 2] / DEPTH, 0, 1)[..., None]
    water = np.array([40, 120, 170]) / 255 * (1 - 0.45 * depth) + np.array([8, 30, 60]) / 255 * depth
    colour = water.copy()
    # Grid every 5 mm on each wall, in the two coordinates that run along it.
    def grid(u, v):
        fu, fv = np.abs((u / 5.0) - np.round(u / 5.0)), np.abs((v / 5.0) - np.round(v / 5.0))
        return (np.minimum(fu, fv) < 0.045)[..., None]
    walls = {'left': (p[..., 1], p[..., 2]), 'right': (p[..., 1], p[..., 2]), 'top': (p[..., 0], p[..., 2]),
             'back': (p[..., 0], p[..., 1])}
    for k, name in enumerate(names):
        mask = (which == k)[..., None]
        if name == 'floor':
            sand = np.array([214, 190, 140]) / 255 * (0.8 + 0.2 * (1 - depth))
            ripple = 0.06 * np.sin(p[..., 0] * 1.3 + p[..., 2] * 0.7)[..., None]
            line = grid(p[..., 0], p[..., 2])
            colour = np.where(mask, np.where(line, sand * 0.78, sand + ripple), colour)
        else:
            line = grid(*walls[name])
            colour = np.where(mask & line, water * 0.55 + np.array([0.75, 0.9, 1.0]) * 0.25, colour)
    return colour, t


def render(alpha_deg, psi_deg, whale=True):
    eye, dirs = rays(alpha_deg)
    colour, t_near = tank(eye, dirs)
    # Whale: rotate the rays into its frame (yaw psi: forward (sin psi, 0, cos psi) in screen coordinates).
    s, c = math.sin(math.radians(psi_deg)), math.cos(math.radians(psi_deg))
    to_local = np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]])
    o_local = to_local @ (eye - WHALE_AT)
    d_local = dirs @ to_local.T
    for centre, radii, paint in (PARTS if whale else ()):
        t, n_local = ellipsoid_hit(o_local, d_local, np.array(centre), radii)
        n = n_local @ to_local
        if isinstance(paint, str):   # body: blue back, pale belly
            p_local = o_local + d_local * t[..., None]
            belly = np.clip((-(p_local[..., 1] - centre[1]) / radii[1] - 0.15) * 3, 0, 1)[..., None]
            base = BODY_BLUE * (1 - belly) + BELLY * belly
        else:
            base = np.broadcast_to(paint, colour.shape)
        lit = shade(base, n, dirs)
        nearer = (t < t_near)[..., None]
        colour = np.where(nearer, lit, colour)
        t_near = np.minimum(t_near, t)
    for centre, radius in BUBBLES:
        t, n = ellipsoid_hit(eye, dirs, np.array(centre), (radius,) * 3)
        rim = 1 - np.abs((n * dirs).sum(-1))[..., None]
        lit = colour * 0.6 + np.array([0.85, 0.95, 1.0]) * (0.25 + 0.6 * rim ** 2) + shade(np.zeros(3), n, dirs, 0.6)
        colour = np.where((t < t_near)[..., None], lit, colour)
        t_near = np.minimum(t_near, t)
    # Glass edge: a thin dark frame so the window reads as a window.
    sw, sh = W * SUPERSAMPLE, H * SUPERSAMPLE
    edge = 3 * SUPERSAMPLE
    frame = np.zeros((sh, sw, 1), bool)
    frame[:edge], frame[-edge:], frame[:, :edge], frame[:, -edge:] = True, True, True, True
    colour = np.where(frame, np.array([0.06, 0.09, 0.14]), colour)
    img = np.clip(colour, 0, 1)
    img = img.reshape(H, SUPERSAMPLE, W, SUPERSAMPLE, 3).mean((1, 3))
    return Image.fromarray((img * 255 + 0.5).astype(np.uint8), 'RGB')


def crops(out, psis, step_name):
    """Character-only frames for the frame bank (wiki/head-coupled-view.md): one full-screen
    background without the whale, then for each angle only the box the whale can cover. The box
    already carries its background pixels, so pushing it over the background is seamless; with
    frames 2 a box of a third of the screen redraws in about a third of the time."""
    folder = out / step_name
    folder.mkdir(parents=True, exist_ok=True)
    background = render(0, 0, whale=False)
    frames = [render(0, psi) for psi in psis]
    bg = np.asarray(background, dtype=np.int16)
    mask = np.zeros(bg.shape[:2], bool)
    for f in frames:
        mask |= (np.abs(np.asarray(f, dtype=np.int16) - bg).sum(-1) > 6)
    ys, xs = np.nonzero(mask)
    x0, y0 = max(0, int(xs.min()) - 2) & ~1, max(0, int(ys.min()) - 2)
    x1, y1 = min(W, int(xs.max()) + 3), min(H, int(ys.max()) + 3)
    background.save(folder / 'background.bmp')
    names = []
    for k, (psi, f) in enumerate(zip(psis, frames)):
        name = f'{k:02d}_psi{psi:+04d}.bmp'
        f.crop((x0, y0, x1, y1)).save(folder / name)
        names.append(name)
    (folder / 'crops.json').write_text(json.dumps({'background': 'background.bmp', 'x': x0, 'y': y0,
        'width': x1 - x0, 'height': y1 - y0, 'frames': names}, indent=2))
    return x0, y0, x1 - x0, y1 - y0


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'frames')
    (out / 'turn').mkdir(parents=True, exist_ok=True)
    (out / 'window').mkdir(parents=True, exist_ok=True)
    turn = list(range(-60, 61, 10))
    for k, psi in enumerate(turn):
        render(0, psi).save(out / 'turn' / f'{k:02d}_psi{psi:+04d}.bmp')
    thetas = [-30 + 7.5 * k for k in range(9)]
    for k, theta in enumerate(thetas):
        render(theta, theta).save(out / 'window' / f'{k:02d}_theta{theta:+06.1f}.bmp')
    # The same head angles with the whale staying put in the tank (psi = 0): seen from the side, her side shows.
    (out / 'inside').mkdir(parents=True, exist_ok=True)
    for k, theta in enumerate(thetas):
        render(theta, 0).save(out / 'inside' / f'{k:02d}_theta{theta:+06.1f}.bmp')
    # Timeline: head yaw theta(t) = 30 sin(2 pi t / 4 s) for 8 s at 50 Hz, pitch facing the owner
    # (about 33.5 degrees on Sion), and the window frame nearest the angle (slots 13..21) whenever it changes.
    first_window_slot, pitch, points, last = len(turn), 335, [], None
    for i in range(400):
        at = i * 20
        theta = 30 * math.sin(2 * math.pi * at / 4000)
        point = {'atMs': at, 'yaw': round(theta * 10), 'pitch': pitch}
        frame = first_window_slot + min(range(len(thetas)), key=lambda k: abs(thetas[k] - theta))
        if frame != last:
            point['frame'] = frame
            last = frame
        points.append(point)
    (out / 'sweep.json').write_text(json.dumps({'points': points}))
    # 5-degree turn as character-only crops over one background (slot 0 background, crops from 1).
    psis5 = list(range(-60, 61, 5))
    box = crops(out, psis5, 'turn-crops')
    seq = list(range(1, 1 + len(psis5)))
    for fps, step in ((30, 33), (45, 22), (60, 16)):
        order = seq + seq[-2:0:-1]
        order = order * 2 + [seq[0]]
        pts = [{'atMs': 0, 'frame': 0}] + [{'atMs': 400 + i * step, 'frame': f} for i, f in enumerate(order)]
        (out / f'turn-crops-{fps}fps.json').write_text(json.dumps({'points': pts}))
    print(json.dumps({'turn': len(turn), 'window': len(thetas), 'firstWindowSlot': first_window_slot,
                      'sweepPoints': len(points), 'sweepFrameChanges': sum('frame' in p for p in points),
                      'cropBox': box, 'crops': len(psis5)}))


if __name__ == '__main__':
    main()
