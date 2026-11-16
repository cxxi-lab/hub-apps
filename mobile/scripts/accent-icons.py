#!/usr/bin/env python3
"""
The launcher icon in each accent (app/src/core/theme/theme.ts, ACCENTS): the blue icons
(mipmap-*/ic_launcher*.png) repainted with the accent's logo gradient (hub-ui styles/theme.css,
--color-brand-300 → --color-brand-500), written next to them as ic_launcher_<accent>*.png, with the
adaptive icons (mipmap-anydpi-v26/ic_launcher_<accent>*.xml). The launcher aliases are in
AndroidManifest.xml (ThemePlugin switches them). Run: python3 scripts/accent-icons.py
"""
import os
from PIL import Image

ACCENTS = {
    'green': ('#80de9c', '#2ecc71'),
    'teal': ('#75cfb7', '#1abc9c'),
    'purple': ('#ab7cbf', '#9b59b6'),
    'red': ('#ec7d6d', '#e74c3c'),
    'orange': ('#eea26c', '#e67e22'),
    'yellow': ('#ffe180', '#f1c40f'),
}
RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
BACKGROUND = (30, 32, 37)  # @color/app_background


def rgb(hex_):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


def gradient_at(box, x, y, start, end):
    # as the logo: light at the top right, full colour at the bottom left
    x0, y0, x1, y1 = box
    u = (x1 - x) / max(1, x1 - x0)
    v = (y - y0) / max(1, y1 - y0)
    t = min(1.0, max(0.0, (u + v) / 2))
    return tuple(round(a + (b - a) * t) for a, b in zip(start, end))


def mark_weight(pixel, on_background):
    """How much of the mark a pixel is: its alpha on a transparent icon, its distance from the
    background colour on an opaque one (the blue mark is the only thing brighter in blue)."""
    r, g, b, a = pixel
    if not on_background:
        return a / 255
    return min(1.0, max(0.0, (b - BACKGROUND[2]) / (240 - BACKGROUND[2])))


def repaint(src, dst, start, end, on_background):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    px = im.load()
    weights = [[mark_weight(px[x, y], on_background) for x in range(w)] for y in range(h)]
    xs = [x for y in range(h) for x in range(w) if weights[y][x] > 0.5]
    ys = [y for y in range(h) for x in range(w) if weights[y][x] > 0.5]
    box = (min(xs), min(ys), max(xs), max(ys))
    out = Image.new('RGBA', (w, h))
    o = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            k = weights[y][x]
            if k == 0:
                o[x, y] = (r, g, b, a)
                continue
            c = gradient_at(box, x, y, start, end)
            if on_background:
                o[x, y] = tuple(round(BACKGROUND[i] + (c[i] - BACKGROUND[i]) * k) for i in range(3)) + (a,)
            else:
                o[x, y] = c + (a,)
    out.save(dst, optimize=True)


ADAPTIVE = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground_{accent}"/>
</adaptive-icon>
'''

for accent, (light, full) in ACCENTS.items():
    start, end = rgb(light), rgb(full)
    for d in DENSITIES:
        folder = os.path.join(RES, f'mipmap-{d}')
        repaint(f'{folder}/ic_launcher_foreground.png', f'{folder}/ic_launcher_foreground_{accent}.png', start, end, False)
        repaint(f'{folder}/ic_launcher.png', f'{folder}/ic_launcher_{accent}.png', start, end, True)
        repaint(f'{folder}/ic_launcher_round.png', f'{folder}/ic_launcher_round_{accent}.png', start, end, True)
    for name in ('ic_launcher', 'ic_launcher_round'):
        with open(os.path.join(RES, 'mipmap-anydpi-v26', f'{name}_{accent}.xml'), 'w') as f:
            f.write(ADAPTIVE.format(accent=accent))
    print(accent)
