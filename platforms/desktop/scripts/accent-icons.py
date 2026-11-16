#!/usr/bin/env python3
"""
The icon in each accent (resources/icons/<accent>/, app/src/core/theme/theme.ts ACCENTS): the blue
icons (resources/icons/<size>.png) repainted, at their own size, with the accent's logo gradient
(hub-ui styles/theme.css, --color-brand-300 → --color-brand-500). Run: python3 scripts/accent-icons.py
"""
import os
import re
from PIL import Image

ACCENTS = {
    'green': ('#80de9c', '#2ecc71'),
    'teal': ('#75cfb7', '#1abc9c'),
    'purple': ('#ab7cbf', '#9b59b6'),
    'red': ('#ec7d6d', '#e74c3c'),
    'orange': ('#eea26c', '#e67e22'),
    'yellow': ('#ffe180', '#f1c40f'),
}
ICONS = os.path.join(os.path.dirname(__file__), '..', 'resources', 'icons')


def rgb(hex_):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


def repaint(src, dst, start, end):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    px = im.load()
    x0, y0, x1, y1 = im.getchannel('A').getbbox()
    out = Image.new('RGBA', (w, h))
    o = out.load()
    for y in range(h):
        for x in range(w):
            a = px[x, y][3]
            if a == 0:
                continue
            # as the logo: light at the top right, full colour at the bottom left
            t = min(1.0, max(0.0, ((x1 - x) / max(1, x1 - x0) + (y - y0) / max(1, y1 - y0)) / 2))
            o[x, y] = tuple(round(s + (e - s) * t) for s, e in zip(start, end)) + (a,)
    out.save(dst, optimize=True)


for accent, (light, full) in ACCENTS.items():
    os.makedirs(os.path.join(ICONS, accent), exist_ok=True)
    for name in sorted(os.listdir(ICONS)):
        if re.fullmatch(r'\d+x\d+\.png', name):
            repaint(os.path.join(ICONS, name), os.path.join(ICONS, accent, name), rgb(light), rgb(full))
    print(accent)
