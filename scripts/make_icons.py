#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 favicon.ico / apple-touch-icon.png / apple-touch-icon-precomposed.png
纯标准库（zlib + struct 手写 PNG/ICO），无 PIL 依赖。

图标与 index.html 里的内联 SVG favicon 同款：
深色圆角方 + 白描边方框 + 玫瑰点 + 白色折线。

用法：python3 scripts/make_icons.py   （在仓库根目录生成三个文件）
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ---------------- PNG / ICO 封装 ----------------

def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def png_bytes(pixels, w, h):
    """pixels: 行序 RGBA 字节串列表（每行 w*4 字节）"""
    raw = b"".join(b"\x00" + row for row in pixels)
    out = b"\x89PNG\r\n\x1a\n"
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += _chunk(b"IDAT", zlib.compress(raw, 9))
    out += _chunk(b"IEND", b"")
    return out


def ico_bytes(png, size):
    """把一张 PNG 包成单帧 ICO（现代浏览器都支持 PNG-in-ICO）"""
    ico = struct.pack("<HHH", 0, 1, 1)
    ico += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32,
                       len(png), 22)
    return ico + png


# ---------------- 2D 采样 ----------------

def sd_round_rect(x, y, cx, cy, hw, hh, r):
    qx = abs(x - cx) - (hw - r)
    qy = abs(y - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(qx, qy), 0.0) - r


def sd_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = 0.0 if (vx == 0 and vy == 0) else max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    dx, dy = wx - t * vx, wy - t * vy
    return (dx * dx + dy * dy) ** 0.5


def cov(d):
    """SDF → 覆盖率（1px 抗锯齿过渡带）"""
    return max(0.0, min(1.0, 0.5 - d))


INK = (0x1D / 255, 0x1B / 255, 0x19 / 255)
PAPER = (0xF6 / 255, 0xF3 / 255, 0xEE / 255)
ROSE = (0xC0 / 255, 0x8A / 255, 0x7D / 255)


def sample(x, y):
    """返回 (r, g, b, a)，坐标系为 32×32 的设计稿"""
    # 底：圆角方（渐变近似的双色：左上深、右下稍亮）
    d = sd_round_rect(x, y, 16, 16, 16, 16, 8)
    if d > 0.5:
        return (0.0, 0.0, 0.0, 0.0)
    a = cov(d)
    t = min(1.0, max(0.0, (x + y) / 64.0))
    r = INK[0] + (0x3A / 255 - INK[0]) * t
    g = INK[1] + (0x34 / 255 - INK[1]) * t
    b = INK[2] + (0x30 / 255 - INK[2]) * t

    def over(col, alpha):
        nonlocal r, g, b
        r += (col[0] - r) * alpha
        g += (col[1] - g) * alpha
        b += (col[2] - b) * alpha

    # 白描边方框 (7..25)，线宽 2（半宽 1），圆角 3
    over(PAPER, cov(abs(sd_round_rect(x, y, 16, 16, 9, 9, 3)) - 1.0))
    # 玫瑰点 (13,13) r2
    over(ROSE, cov(((x - 13) ** 2 + (y - 13) ** 2) ** 0.5 - 2.0))
    # 白折线 (25,19)→(20,14)→(11,23)，线宽 2
    over(PAPER, cov(sd_seg(x, y, 25, 19, 20, 14) - 1.0))
    over(PAPER, cov(sd_seg(x, y, 20, 14, 11, 23) - 1.0))
    return (r, g, b, a)


def render(size, ss=3):
    scale = size / 32.0
    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            r = g = b = 0.0
            acc = 0.0
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / scale
                    y = (j + (sj + 0.5) / ss) / scale
                    cr, cg, cb, ca = sample(x, y)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    acc += ca
            if acc > 0:
                r /= acc
                g /= acc
                b /= acc
                a = acc / (ss * ss)
            else:
                r = g = b = a = 0.0
            row += bytes((round(r * 255), round(g * 255), round(b * 255), round(a * 255)))
        rows.append(bytes(row))
    return rows


def main():
    made = []
    png32 = png_bytes(render(32), 32, 32)
    p = os.path.join(ROOT, "favicon.ico")
    open(p, "wb").write(ico_bytes(png32, 32))
    made.append(p)

    png180 = png_bytes(render(180), 180, 180)
    for name in ("apple-touch-icon.png", "apple-touch-icon-precomposed.png"):
        p = os.path.join(ROOT, name)
        open(p, "wb").write(png180)
        made.append(p)

    for p in made:
        print("  ✓ %s (%d bytes)" % (p, os.path.getsize(p)))


if __name__ == "__main__":
    main()
