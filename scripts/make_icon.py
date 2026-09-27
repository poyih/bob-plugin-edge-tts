#!/usr/bin/env python3
"""生成 src/icon.png（512x512，RGBA）。只用标准库，用有向距离函数做抗锯齿。

图标是蓝绿渐变的圆角方块加一个白色喇叭，不含任何微软或 Edge 的商标图形。

用法：python3 scripts/make_icon.py
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIZE = 512

STOPS = [
    (0.0, (12, 89, 164)),
    (0.55, (20, 140, 190)),
    (1.0, (46, 196, 160)),
]


def gradient(t: float) -> tuple:
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(c0[i] + (c1[i] - c0[i]) * k for i in range(3))
    return STOPS[-1][1]


def rounded_box(x: float, y: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(x - cx) - hw + r
    qy = abs(y - cy) - hh + r
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - r


def convex_polygon(x: float, y: float, points: list) -> float:
    """顶点按顺时针（屏幕坐标系）给出；返回到各边的最大有向距离。"""
    worst = -1e9
    count = len(points)
    for i in range(count):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % count]
        ex, ey = x1 - x0, y1 - y0
        length = math.hypot(ex, ey)
        # 顺时针多边形的外法线是 (ey, -ex)
        worst = max(worst, ((x - x0) * ey - (y - y0) * ex) / length)
    return worst


def arc(x: float, y: float, cx: float, cy: float, radius: float, width: float, span: float) -> float:
    dx, dy = x - cx, y - cy
    if abs(math.atan2(dy, dx)) <= span:
        return abs(math.hypot(dx, dy) - radius) - width / 2
    ex = radius * math.cos(span)
    ey = radius * math.sin(span)
    return math.hypot(dx - ex, abs(dy) - ey) - width / 2


def coverage(distance: float) -> float:
    return min(1.0, max(0.0, 0.5 - distance))


def glyph(x: float, y: float) -> float:
    body = rounded_box(x, y, 126, 256, 40, 52, 14)
    cone = convex_polygon(x, y, [(150, 204), (248, 124), (248, 388), (150, 308)])
    waves = min(
        arc(x, y, 236, 256, 78, 30, math.radians(42)),
        arc(x, y, 236, 256, 134, 30, math.radians(42)),
        arc(x, y, 236, 256, 190, 30, math.radians(42)),
    )
    return min(body, cone, waves)


def render() -> bytes:
    rows = []
    for py in range(SIZE):
        row = bytearray([0])
        y = py + 0.5
        for px in range(SIZE):
            x = px + 0.5
            alpha = coverage(rounded_box(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 112))
            if alpha <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            red, green, blue = gradient((x + y) / (2 * SIZE))
            white = coverage(glyph(x, y))
            row += bytes((
                round(red + (255 - red) * white),
                round(green + (255 - green) * white),
                round(blue + (255 - blue) * white),
                round(alpha * 255),
            ))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def main() -> int:
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(render(), 9))
        + chunk(b"IEND", b"")
    )
    target = ROOT / "src" / "icon.png"
    target.write_bytes(png)
    print(f"{target.relative_to(ROOT)} {len(png)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
