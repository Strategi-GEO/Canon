#!/usr/bin/env python3
"""Generate the Strategi Canon APP icons at build time with Pillow.

A burnt orange (#D45512) rounded square with a bold white "C". Outputs
canon.icns (macOS) and canon.ico (Windows) into canon_app/build_assets/,
which is gitignored: no binary assets live in git, the build scripts run
this right before PyInstaller.

The "C" is drawn with a real bold font when one is found on the build
machine (Arial Bold / Helvetica); otherwise it falls back to a thick
geometric arc-C so the build never depends on a font being present.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "build_assets"
BURNT_ORANGE = "#D45512"
WHITE = "#FFFFFF"

FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    # Windows
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    # Linux CI runners
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(px: int) -> ImageFont.FreeTypeFont | None:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, px)
            except OSError:
                continue
    return None


def draw_arc_c(draw: ImageDraw.ImageDraw, size: int) -> None:
    """Fallback bold 'C': a thick white arc with its mouth opening right."""
    margin = size * 0.24
    thickness = int(size * 0.14)
    bbox = [margin, margin, size - margin, size - margin]
    draw.arc(bbox, start=35, end=325, fill=WHITE, width=thickness)
    # Round the two arc ends with small dots so the C does not look sheared.
    cx, cy = size / 2, size / 2
    radius = (size - 2 * margin) / 2 - thickness / 2 + thickness / 2
    r_mid = (size - 2 * margin) / 2 - thickness / 2
    for angle in (35, 325):
        x = cx + r_mid * math.cos(math.radians(angle))
        y = cy + r_mid * math.sin(math.radians(angle))
        draw.ellipse([x - thickness / 2, y - thickness / 2,
                      x + thickness / 2, y + thickness / 2], fill=WHITE)


def base_icon(size: int) -> Image.Image:
    """Rounded burnt-orange square with a bold white C, drawn supersampled."""
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    corner = int(big * 0.22)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=corner, fill=BURNT_ORANGE)

    font = load_font(int(big * 0.72))
    if font is not None:
        left, top, right, bottom = draw.textbbox((0, 0), "C", font=font)
        x = (big - (right - left)) / 2 - left
        y = (big - (bottom - top)) / 2 - top
        draw.text((x, y), "C", font=font, fill=WHITE)
    else:
        draw_arc_c(draw, big)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    master = base_icon(1024)

    icns_path = OUT_DIR / "canon.icns"
    master.save(icns_path, format="ICNS")
    print(f"wrote {icns_path}")

    ico_path = OUT_DIR / "canon.ico"
    master.save(ico_path, format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"wrote {ico_path}")

    # A PNG preview for humans; PyInstaller does not use it.
    png_path = OUT_DIR / "canon-256.png"
    master.resize((256, 256), Image.LANCZOS).save(png_path, format="PNG")
    print(f"wrote {png_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
