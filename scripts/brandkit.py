"""Rasterising the openDAQ brand artwork for icons and installer graphics.

The sources are ``assets/brand/*.svg`` - the outlines taken out of the Design
Manual, the same ones the UI draws. Everything downstream (the application icon,
the DMG background, the Windows installer bitmaps) is generated from them so
there is one place the artwork lives.

Rendering is done with Pillow alone rather than a real SVG engine. Those files
use only ``M``, ``L``, ``C`` and ``Z``, which is a few lines to flatten, and a
full renderer would be a much heavier build dependency than two shapes justify.

Fills use the even-odd rule. For these outlines that is identical to the
non-zero rule the SVG declares - every hole is a simple counter inside its
letter, never a shape inside a hole - and it is far cheaper to compute.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets" / "brand"

#: Design Manual v1.0, "Colours / Definition".
HBK_DARK_BLUE = "#00335A"
DEWESOFT_ORANGE = "#F15D31"
WHITE = "#FFFFFF"

#: The manual's core graphic element: 45 degrees, 60/40 blue to orange.
GRADIENT_STOPS: tuple[tuple[float, str], ...] = (
    (0.00, HBK_DARK_BLUE),
    (0.45, HBK_DARK_BLUE),
    (0.95, DEWESOFT_ORANGE),
    (1.00, DEWESOFT_ORANGE),
)

#: Segments per cubic. 24 is indistinguishable from exact at the sizes used here
#: once the 4x supersample is taken into account.
CURVE_STEPS = 24

Point = tuple[float, float]
SubPath = list[Point]

_PATH_RE = re.compile(r'<path[^>]*?fill="([^"]+)"[^>]*?d="([^"]+)"', re.DOTALL)
_VIEWBOX_RE = re.compile(r'viewBox="([\d.\s-]+)"')
_TOKEN_RE = re.compile(r"([MLCZmlcz])|(-?\d+\.?\d*)")


class Shape:
    """One ``<path>``: its declared fill and its flattened outlines."""

    def __init__(self, fill: str, subpaths: list[SubPath]) -> None:
        self.fill = fill
        self.subpaths = subpaths


def parse_path(d: str) -> list[SubPath]:
    """Flatten one path's ``d`` attribute into polygons."""
    subpaths: list[SubPath] = []
    current: SubPath = []
    cursor: Point = (0.0, 0.0)
    tokens = _TOKEN_RE.findall(d)

    index = 0
    command = "M"
    while index < len(tokens):
        letter = tokens[index][0]
        if letter:
            command = letter
            index += 1
            if command in "Zz":
                if len(current) > 2:
                    subpaths.append(current)
                current = []
            continue

        def coords(count: int) -> list[float]:
            nonlocal index
            values = []
            while len(values) < count and index < len(tokens):
                _, value = tokens[index]
                if not value:
                    break
                values.append(float(value))
                index += 1
            return values

        if command in "Mm":
            x, y = coords(2)
            if len(current) > 2:
                subpaths.append(current)
            cursor = (x, y)
            current = [cursor]
            command = "L" if command == "M" else "l"
        elif command in "Ll":
            x, y = coords(2)
            cursor = (x, y)
            current.append(cursor)
        elif command in "Cc":
            x1, y1, x2, y2, x3, y3 = coords(6)
            current.extend(_bezier(cursor, (x1, y1), (x2, y2), (x3, y3)))
            cursor = (x3, y3)
        else:  # pragma: no cover - the brand files use no other command
            raise ValueError(f"unsupported path command: {command!r}")

    if len(current) > 2:
        subpaths.append(current)
    return subpaths


def _bezier(p0: Point, p1: Point, p2: Point, p3: Point) -> list[Point]:
    points = []
    for step in range(1, CURVE_STEPS + 1):
        t = step / CURVE_STEPS
        u = 1.0 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        points.append((x, y))
    return points


def load_svg(name: str) -> tuple[float, float, list[Shape]]:
    """``(width, height, shapes)`` for one of the committed brand files."""
    text = (BRAND / name).read_text(encoding="utf-8")
    box = _VIEWBOX_RE.search(text)
    if box is None:
        raise ValueError(f"{name} has no viewBox")
    _, _, width, height = (float(value) for value in box.group(1).split())
    shapes = [Shape(fill, parse_path(d)) for fill, d in _PATH_RE.findall(text)]
    if not shapes:
        raise ValueError(f"{name} contains no paths")
    return width, height, shapes


def render(
    name: str,
    height: int,
    *,
    colour: str | None = None,
    supersample: int = 4,
) -> Image.Image:
    """Rasterise a brand file to ``height`` pixels, antialiased, with alpha.

    ``colour`` overrides every declared fill, which is how the white secondary
    version of the logo is produced from the primary artwork.
    """
    art_width, art_height, shapes = load_svg(name)
    scale = (height * supersample) / art_height
    width = max(1, round(art_width * scale))
    big = (width, height * supersample)

    canvas = Image.new("RGBA", big, (0, 0, 0, 0))
    for shape in shapes:
        mask = np.zeros((big[1], big[0]), dtype=bool)
        for subpath in shape.subpaths:
            layer = Image.new("1", big, 0)
            ImageDraw.Draw(layer).polygon(
                [(x * scale, y * scale) for x, y in subpath], fill=1
            )
            # Even-odd: a counter inside a letter cancels the letter.
            mask ^= np.array(layer, dtype=bool)
        tinted = Image.new("RGBA", big, colour or shape.fill)
        canvas.paste(tinted, (0, 0), Image.fromarray((mask * 255).astype(np.uint8), mode="L"))

    return canvas.resize((max(1, round(art_width * (height / art_height))), height), Image.LANCZOS)


def gradient(size: tuple[int, int], stops: Sequence[tuple[float, str]] = GRADIENT_STOPS) -> Image.Image:
    """The manual's 45-degree brand gradient, bottom-left to top-right."""
    width, height = size
    xs = np.linspace(0.0, 1.0, width)[None, :]
    ys = np.linspace(0.0, 1.0, height)[:, None]
    # 45 degrees in CSS points at the top-right corner; image y grows downward.
    t = np.clip((xs + (1.0 - ys)) / 2.0, 0.0, 1.0)

    positions = np.array([stop for stop, _ in stops])
    colours = np.array([_rgb(value) for _, value in stops], dtype=float)
    out = np.zeros((height, width, 3), dtype=float)
    for channel in range(3):
        out[:, :, channel] = np.interp(t, positions, colours[:, channel])
    return Image.fromarray(out.round().astype(np.uint8), mode="RGB")


def _rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def rounded_mask(size: tuple[int, int], radius: int, supersample: int = 4) -> Image.Image:
    """An antialiased rounded-rectangle mask."""
    big = (size[0] * supersample, size[1] * supersample)
    mask = Image.new("L", big, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big[0] - 1, big[1] - 1), radius=radius * supersample, fill=255
    )
    return mask.resize(size, Image.LANCZOS)


def paste_centred(canvas: Image.Image, art: Image.Image, *, box: tuple[int, int, int, int]) -> None:
    """Paste ``art`` centred in ``box``, scaled to fit inside it."""
    left, top, right, bottom = box
    available = (right - left, bottom - top)
    ratio = min(available[0] / art.width, available[1] / art.height)
    scaled = art.resize((max(1, round(art.width * ratio)), max(1, round(art.height * ratio))), Image.LANCZOS)
    canvas.paste(
        scaled,
        (left + (available[0] - scaled.width) // 2, top + (available[1] - scaled.height) // 2),
        scaled if scaled.mode == "RGBA" else None,
    )
