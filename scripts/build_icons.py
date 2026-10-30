#!/usr/bin/env python3
"""Generate the application icon and the installer artwork from the brand files.

Everything is derived from ``assets/brand/*.svg`` - the outlines taken out of the
openDAQ Design Manual - so the icon, the DMG background, the Windows installer
bitmaps and the browser favicon cannot drift apart.

    python scripts/build_icons.py

The application icon is the manual's own two elements and nothing invented: the
45-degree brand gradient (the manual's "core graphic element") on a rounded tile,
with the logo's star badge in white on top. The full wordmark is not used here -
at 16 px it is a smudge - which is exactly why the manual gives the badge as a
separable element.

The outputs are committed, so this only needs running when the artwork changes.
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import brandkit  # noqa: E402 - the path above has to be set first

ROOT = brandkit.ROOT
DESKTOP_BUILD = ROOT / "desktop" / "build"
WEB_PUBLIC = ROOT / "frontend" / "public"

#: The tile as a fraction of the canvas, and its corner radius as a fraction of
#: the tile. Both follow the proportions macOS has used since Big Sur, which
#: Windows and Linux tolerate happily.
TILE_INSET = 0.09
TILE_RADIUS = 0.225
#: The badge, as a fraction of the tile. Large enough to read at 16 px.
BADGE_SCALE = 0.52

MASTER = 1024

#: macOS icon types: (OSType, pixel size). The retina variants repeat sizes on
#: purpose - that is how the format expresses @2x.
ICNS_TYPES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic13", 256),
    (b"ic14", 512),
]

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def build_icon(size: int = MASTER):
    """The application icon: brand gradient tile, white badge."""
    from PIL import Image

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = round(size * TILE_INSET)
    side = size - 2 * inset

    tile = brandkit.gradient((side, side)).convert("RGBA")
    tile.putalpha(brandkit.rounded_mask((side, side), round(side * TILE_RADIUS)))
    canvas.paste(tile, (inset, inset), tile)

    badge = brandkit.render("opendaq-badge.svg", round(side * BADGE_SCALE), colour=brandkit.WHITE)
    canvas.paste(
        badge,
        (inset + (side - badge.width) // 2, inset + (side - badge.height) // 2),
        badge,
    )
    return canvas


def write_icns(master, destination: Path) -> None:
    """Assemble an .icns directly; ``iconutil`` is macOS-only and not always present."""
    chunks = b""
    for kind, size in ICNS_TYPES:
        buffer = io.BytesIO()
        master.resize((size, size), _lanczos()).save(buffer, format="PNG")
        data = buffer.getvalue()
        chunks += kind + struct.pack(">I", len(data) + 8) + data
    destination.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def _lanczos():
    from PIL import Image

    return Image.LANCZOS


def build_favicon() -> str:
    """The same icon as vector, so the browser tab matches the dock icon."""
    text = (brandkit.BRAND / "opendaq-badge.svg").read_text(encoding="utf-8")
    start = text.index('d="') + 3
    badge_path = text[start : text.index('"', start)]
    inset, radius = 3, 14
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <title>openDAQ Studio</title>
  <defs>
    <linearGradient id="brand" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="{brandkit.HBK_DARK_BLUE}"/>
      <stop offset="0.45" stop-color="{brandkit.HBK_DARK_BLUE}"/>
      <stop offset="0.95" stop-color="{brandkit.DEWESOFT_ORANGE}"/>
      <stop offset="1" stop-color="{brandkit.DEWESOFT_ORANGE}"/>
    </linearGradient>
  </defs>
  <rect x="{inset}" y="{inset}" width="{64 - 2 * inset}" height="{64 - 2 * inset}"
        rx="{radius}" fill="url(#brand)"/>
  <g transform="translate(16.5 16.5) scale(1.84)">
    <path fill="#FFFFFF" d="{badge_path}"/>
  </g>
</svg>
"""


def build_dmg_background(scale: int = 1):
    """The macOS installer window: brand band, logo, and the drag arrow.

    No text is drawn. Finder writes the two icon labels itself, and a background
    that repeated them would be the only part of the window that could not be
    localised.
    """
    from PIL import Image, ImageDraw

    width, height = 540 * scale, 380 * scale
    band = 104 * scale

    canvas = Image.new("RGB", (width, height), "#F4F6F8")
    canvas.paste(brandkit.gradient((width, band)), (0, 0))

    logo = brandkit.render("opendaq-logo.svg", 34 * scale, colour=brandkit.WHITE)
    canvas.paste(logo, ((width - logo.width) // 2, (band - logo.height) // 2), logo)

    # The arrow between the two icon positions, in the manual's orange.
    draw = ImageDraw.Draw(canvas)
    y = 250 * scale
    x0, x1 = 232 * scale, 308 * scale
    draw.line([(x0, y), (x1 - 9 * scale, y)], fill=brandkit.DEWESOFT_ORANGE, width=3 * scale)
    draw.polygon(
        [(x1, y), (x1 - 14 * scale, y - 9 * scale), (x1 - 14 * scale, y + 9 * scale)],
        fill=brandkit.DEWESOFT_ORANGE,
    )
    return canvas


def build_nsis_sidebar():
    """164x314, the panel beside the Windows installer's first and last pages."""
    from PIL import Image

    width, height = 164, 314
    canvas = Image.new("RGB", (width, height))
    canvas.paste(brandkit.gradient((width, height)), (0, 0))

    logo = brandkit.render("opendaq-logo.svg", 30, colour=brandkit.WHITE)
    canvas.paste(logo, ((width - logo.width) // 2, 26), logo)

    badge = brandkit.render("opendaq-badge.svg", 64, colour=brandkit.WHITE)
    canvas.paste(badge, ((width - badge.width) // 2, 150), badge)
    return canvas


def build_nsis_header():
    """150x57, top-right of the installer's inner pages. White, so the logo is
    the primary coloured version - the only background the manual permits."""
    from PIL import Image

    canvas = Image.new("RGB", (150, 57), "#FFFFFF")
    logo = brandkit.render("opendaq-logo.svg", 22)
    canvas.paste(logo, (150 - logo.width - 10, (57 - logo.height) // 2), logo)
    return canvas


def main() -> int:
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        raise SystemExit("Pillow is required:  pip install pillow") from None

    DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)
    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)

    master = build_icon()
    written = []

    master.save(DESKTOP_BUILD / "icon.png")
    master.save(DESKTOP_BUILD / "icon.ico", sizes=[(size, size) for size in ICO_SIZES])
    write_icns(master, DESKTOP_BUILD / "icon.icns")
    master.resize((512, 512), _lanczos()).save(WEB_PUBLIC / "opendaq-icon.png")
    (WEB_PUBLIC / "favicon.svg").write_text(build_favicon(), encoding="utf-8")
    written += [
        DESKTOP_BUILD / "icon.png",
        DESKTOP_BUILD / "icon.ico",
        DESKTOP_BUILD / "icon.icns",
        WEB_PUBLIC / "opendaq-icon.png",
        WEB_PUBLIC / "favicon.svg",
    ]

    build_dmg_background(1).save(DESKTOP_BUILD / "background.png")
    build_dmg_background(2).save(DESKTOP_BUILD / "background@2x.png")
    written += [DESKTOP_BUILD / "background.png", DESKTOP_BUILD / "background@2x.png"]

    sidebar = build_nsis_sidebar()
    sidebar.save(DESKTOP_BUILD / "installerSidebar.bmp")
    sidebar.save(DESKTOP_BUILD / "uninstallerSidebar.bmp")
    build_nsis_header().save(DESKTOP_BUILD / "installerHeader.bmp")
    written += [
        DESKTOP_BUILD / "installerSidebar.bmp",
        DESKTOP_BUILD / "uninstallerSidebar.bmp",
        DESKTOP_BUILD / "installerHeader.bmp",
    ]

    print(f"source: {brandkit.BRAND.relative_to(ROOT)}/*.svg")
    for path in written:
        print(f"  {path.relative_to(ROOT)}  ({path.stat().st_size / 1024:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
