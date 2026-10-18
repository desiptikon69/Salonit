"""Generate iOS launch (splash) images for the installed SalonIt PWA.

Cream canvas, dark rounded logo tile, wordmark and caption, optically centred.
Outputs public/splash/apple-splash-<w>x<h>.png and prints the media queries
that src/app/layout.tsx uses in metadata.appleWebApp.startupImage.
"""
import os
from PIL import Image, ImageDraw, ImageFont

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "make_pwa_icons", os.path.join(os.path.dirname(__file__), "make-pwa-icons.py")
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
draw_logo, BG, ACCENT = _mod.draw_logo, _mod.BG, _mod.ACCENT

CREAM = "#f6f4ef"
INK = "#22201f"
MUTED = "#76716a"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "splash")

SIZES = [
    (1290, 2796, 430, 932, 3),
    (1179, 2556, 393, 852, 3),
    (1170, 2532, 390, 844, 3),
    (1284, 2778, 428, 926, 3),
    (1125, 2436, 375, 812, 3),
    (1242, 2688, 414, 896, 3),
    (828, 1792, 414, 896, 2),
    (750, 1334, 375, 667, 2),
    (1242, 2208, 414, 736, 3),
    (1536, 2048, 768, 1024, 2),
    (1620, 2160, 810, 1080, 2),
    (1640, 2360, 820, 1180, 2),
    (1668, 2388, 834, 1194, 2),
    (2048, 2732, 1024, 1366, 2),
]

FONT_BOLD = r"C:\Windows\Fonts\arialbd.ttf"
FONT_REG = r"C:\Windows\Fonts\arial.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def spaced_text(draw, xy, text, fnt, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking


def make(w, h):
    ss = 2  # supersampling keeps the rounded mark crisp
    W, H = w * ss, h * ss
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    unit = W / 430  # scale from a 430pt reference width

    tile = int(W * 0.24)
    radius = int(tile * 0.25)
    left = (W - tile) // 2
    top = int(H * 0.5 - tile * 0.9)
    d.rounded_rectangle([left, top, left + tile, top + tile], radius=radius, fill=BG)
    scale = tile / 64
    draw_logo(d, (left, top), scale, tile * 6 / 64)

    # wordmark
    word_size = int(unit * 54)
    wf = font(FONT_BOLD, word_size)
    word = "salonit"
    word_w = d.textlength(word, font=wf)
    wy = top + tile + int(unit * 54)
    d.text(((W - word_w) / 2, wy), word, font=wf, fill=INK)
    dot_r = int(unit * 5)
    d.ellipse(
        [((W + word_w) / 2 + int(unit * 4), wy + word_size * 0.62),
         ((W + word_w) / 2 + int(unit * 4) + dot_r * 2, wy + word_size * 0.62 + dot_r * 2)],
        fill=ACCENT,
    )

    cap_size = int(unit * 11)
    cf = font(FONT_REG, cap_size)
    cap = "BEAUTY, YOUR WAY."
    cap_w = sum(d.textlength(ch, font=cf) + unit * 3.2 for ch in cap) - unit * 3.2
    spaced_text(d, ((W - cap_w) / 2, wy + word_size + int(unit * 34)), cap, cf, MUTED, unit * 3.2)

    return img.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for w, h, cw, ch, dpr in SIZES:
        path = os.path.join(OUT, f"apple-splash-{w}x{h}.png")
        make(w, h).save(path, "PNG", optimize=True)
        print(f"{os.path.basename(path)} | (device-width: {cw}px) and (device-height: {ch}px) and (-webkit-device-pixel-ratio: {dpr})")
