"""Generate PWA PNG icons from the SalonIt SVG mark (no external deps beyond PIL).

Outputs into public/icons:
  icon-192.png, icon-512.png            — standard ("any") icons, rounded square
  icon-maskable-192.png, icon-maskable-512.png — full-bleed maskable (safe zone)
  apple-touch-icon.png                  — 180x180 full-bleed for iOS
"""
import math
import os
from PIL import Image, ImageDraw

BG = "#22201f"
ACCENT = "#ddf86b"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")

# SVG is 64x64. Path: M43 19H27 c-11 0-11 13 0 13 h10 c11 0 11 13 0 13 H21
# stroke width 6, round caps. Dot: circle (49,45) r=3.


def cubic(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def mark_points():
    pts = [(43, 19), (27, 19)]
    pts += cubic((27, 19), (16, 19), (16, 32), (27, 32))
    pts.append((37, 32))
    pts += cubic((37, 32), (48, 32), (48, 45), (37, 45))
    pts.append((21, 45))
    return pts


def draw_logo(draw, offset, scale, stroke_w, dot=True):
    ox, oy = offset
    pts = [(ox + x * scale, oy + y * scale) for x, y in mark_points()]
    draw.line(pts, fill=ACCENT, width=int(stroke_w), joint="curve")
    r = stroke_w / 2
    for px, py in (pts[0], pts[-1]):  # round line caps
        draw.ellipse([px - r, py - r, px + r, py + r], fill=ACCENT)
    if dot:
        cx, cy, cr = ox + 49 * scale, oy + 45 * scale, 3 * scale
        draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=ACCENT)


def make_any(size):
    """Standard icon: transparent canvas, rounded-square tile like the SVG."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 16 / 64, fill=BG)
    draw_logo(d, (0, 0), size / 64, size * 6 / 64)
    return canvas


def make_fullbleed(size, zoom=0.62):
    """Full-bleed tile; logo kept inside maskable safe zone (~80%)."""
    canvas = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(canvas)
    logo = 64 * zoom  # logo box in tile units
    scale = size * zoom / 64
    off = (size - logo * (size / (64 * scale)) * scale) / 2  # center
    off = (size - 64 * scale) / 2
    # dot sits slightly low-right; nudge up a touch for optical centering
    draw_logo(d, (off, off - size * 0.005), scale, size * zoom * 6 / 64)
    return canvas


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, "PNG")
    print(f"{name}: {img.size[0]}x{img.size[1]} {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    SS = 4  # supersampling for smooth edges
    for size in (192, 512):
        save(make_any(size * SS).resize((size, size), Image.LANCZOS), f"icon-{size}.png")
        save(
            make_fullbleed(size * SS).resize((size, size), Image.LANCZOS),
            f"icon-maskable-{size}.png",
        )
    save(
        make_fullbleed(180 * SS, zoom=0.7).resize((180, 180), Image.LANCZOS),
        "apple-touch-icon.png",
    )
