#!/usr/bin/env python3
"""生成 BandTOTP-NEXT 的品牌素材。

输出:
  src/common/logo.png   96x96 快应用图标（同时用于关于页）
  docs/cover.png        1500x1000（3:2）README 封面

用法: python tools/generate-brand-assets.py
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

FONT_BOLD = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
FONT_REGULAR = [
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
FONT_MONO = [
    "C:/Windows/Fonts/consolab.ttf",
    "C:/Windows/Fonts/consola.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
]

BG_CENTER = (16, 48, 40)
BG_EDGE = (4, 10, 8)
ACCENT = (0, 229, 155)
ACCENT_LIGHT = (124, 255, 224)
ACCENT_DARK = (0, 200, 130)
TEXT_MAIN = (240, 255, 250)
TEXT_SOFT = (156, 199, 186)
TEXT_DIM = (108, 155, 141)


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def _rounded_rect_path(x: float, y: float, w: float, h: float, r: float) -> str:
    return (
        f"M{x + r},{y} H{x + w - r} "
        f"A{r},{r} 0 0 1 {x + w},{y + r} V{y + h - r} "
        f"A{r},{r} 0 0 1 {x + w - r},{y + h} H{x + r} "
        f"A{r},{r} 0 0 1 {x},{y + h - r} V{y + r} "
        f"A{r},{r} 0 0 1 {x + r},{y} Z"
    )


def _radial_glow(width: int, height: int, cx: float, cy: float, radius: float, strength: float) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    d = np.hypot(xx - cx, yy - cy) / radius
    return np.exp(-(d**2) * 2.6) * strength


def render_icon(px: int = 96, supersample: int = 8) -> Image.Image:
    """绘制图标：深色圆底 + 手环 + 6 位码点 + 倒计时环。"""
    n = px * supersample
    k = n / 96.0

    def s(v: float) -> float:
        return v * k

    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    cx = cy = n / 2.0
    radius = np.hypot(xx - cx, yy - cy) / (n / 2.0)
    t = np.clip(radius, 0, 1) ** 1.7

    c0 = np.array(BG_CENTER, dtype=np.float32)
    c1 = np.array(BG_EDGE, dtype=np.float32)
    color = c0[None, None, :] * (1 - t[..., None]) + c1[None, None, :] * t[..., None]

    glow = _radial_glow(n, n, n * 0.38, n * 0.27, n * 0.66, 0.62)
    color += glow[..., None] * np.array([0, 150, 110], dtype=np.float32)
    color = np.clip(color, 0, 255)

    alpha = np.where(radius <= 1.0, 255, 0).astype(np.uint8)
    base = Image.fromarray(np.dstack([color, alpha]).astype(np.uint8), "RGBA")

    def layer() -> tuple[Image.Image, ImageDraw.ImageDraw]:
        img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        return img, ImageDraw.Draw(img)

    # 外缘细环
    img, d = layer()
    d.ellipse([s(1.0), s(1.0), s(95.0), s(95.0)], outline=(70, 170, 140, 90), width=max(1, int(s(0.9))))
    base = Image.alpha_composite(base, img)

    # 倒计时轨道与进度弧
    img, d = layer()
    ring = [s(8.4), s(8.4), s(87.6), s(87.6)]
    d.ellipse(ring, outline=(24, 74, 60, 150), width=max(1, int(s(1.4))))
    start, end = -90.0, 170.0
    d.arc(ring, start=start, end=end, fill=(*ACCENT, 205), width=max(1, int(s(1.6))))
    rr = (s(87.6) - s(8.4)) / 2.0
    mid = (s(87.6) + s(8.4)) / 2.0
    for angle in (start, end):
        ax = mid + rr * math.cos(math.radians(angle))
        ay = mid + rr * math.sin(math.radians(angle))
        cap = s(0.8)
        d.ellipse([ax - cap, ay - cap, ax + cap, ay + cap], fill=(*ACCENT, 205))
    base = Image.alpha_composite(base, img)

    # 表带
    img, d = layer()
    for top in (16.0, 58.0):
        d.rounded_rectangle(
            [s(38.0), s(top), s(58.0), s(top + 22.0)],
            radius=s(8.0),
            fill=(15, 58, 47, 255),
            outline=(36, 112, 90, 255),
            width=max(1, int(s(1.0))),
        )
    base = Image.alpha_composite(base, img)

    # 表盘描边（渐变）
    outer = [s(29.5), s(24.0), s(66.5), s(72.0)]
    inset = s(3.4)
    inner = [outer[0] + inset, outer[1] + inset, outer[2] - inset, outer[3] - inset]
    stroke_mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(stroke_mask)
    md.rounded_rectangle(outer, radius=s(13.0), fill=255)
    md.rounded_rectangle(inner, radius=s(13.0) - inset * 0.7, fill=0)

    gy, gx = np.mgrid[0:n, 0:n].astype(np.float32)
    grad_t = np.clip((gx + gy) / (2 * n), 0, 1)[..., None]
    grad_rgb = (
        np.array(ACCENT_LIGHT, dtype=np.float32) * (1 - grad_t)
        + np.array(ACCENT_DARK, dtype=np.float32) * grad_t
    )
    grad_alpha = np.full((n, n, 1), 255, dtype=np.float32)
    grad = Image.fromarray(np.dstack([grad_rgb, grad_alpha]).astype(np.uint8), "RGBA")
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    img.paste(grad, (0, 0), stroke_mask)
    base = Image.alpha_composite(base, img)

    # 表盘内部
    img, d = layer()
    d.rounded_rectangle(inner, radius=max(1, s(13.0) - inset * 0.7), fill=(5, 14, 11, 255))
    base = Image.alpha_composite(base, img)

    # 六位验证码点阵
    img, d = layer()
    dot = s(3.2)
    for row_y in (42.6, 53.4):
        for col_x in (40.8, 48.0, 55.2):
            d.ellipse(
                [s(col_x) - dot, s(row_y) - dot, s(col_x) + dot, s(row_y) + dot],
                fill=(*TEXT_MAIN, 255),
            )
    base = Image.alpha_composite(base, img)

    return base.resize((px, px), Image.LANCZOS)


def render_cover(width: int = 1500, height: int = 1000) -> Image.Image:
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    t = (yy / height)[..., None]
    top = np.array([6, 13, 11], dtype=np.float32)
    bottom = np.array([9, 27, 22], dtype=np.float32)
    color = top * (1 - t) + bottom * t

    glow_a = _radial_glow(width, height, width * 0.12, -height * 0.05, width * 0.62, 0.30)
    color += glow_a[..., None] * np.array([0, 190, 130], dtype=np.float32)
    glow_b = _radial_glow(width, height, width * 0.94, height * 1.02, width * 0.55, 0.22)
    color += glow_b[..., None] * np.array([0, 160, 100], dtype=np.float32)

    dots = ((xx % 48) < 1.4) & ((yy % 48) < 1.4)
    color[dots] += 12
    color = np.clip(color, 0, 255)

    cover = Image.fromarray(np.dstack([color, np.full((height, width), 255)]).astype(np.uint8), "RGBA")

    # 背景光斑
    halo = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse([width * 0.60, height * 0.10, width * 0.98, height * 0.82], fill=(0, 210, 140, 26))
    halo = halo.filter(ImageFilter.GaussianBlur(90))
    cover = Image.alpha_composite(cover, halo)

    icon = render_icon(132, supersample=6)
    cover.alpha_composite(icon, (96, 74))

    f_title = font(FONT_BOLD, 68)
    f_sub = font(FONT_REGULAR, 30)
    f_head = font(FONT_BOLD, 64)
    f_lead = font(FONT_REGULAR, 32)
    f_tag = font(FONT_REGULAR, 24)
    f_note = font(FONT_REGULAR, 25)
    f_quote = font(FONT_BOLD, 32)
    f_foot = font(FONT_REGULAR, 22)
    f_mono = font(FONT_MONO, 46)
    f_small = font(FONT_REGULAR, 22)

    d = ImageDraw.Draw(cover)
    d.text((258, 92), "BandTOTP-NEXT", font=f_title, fill=TEXT_MAIN)
    d.text((262, 180), "手环上的 Aegis TOTP 验证器", font=f_sub, fill=(111, 216, 180))

    d.text((96, 300), "把验证码戴在手腕上", font=f_head, fill=TEXT_MAIN)
    d.text((98, 396), "Aegis 备份一次导入，验证码随腕查看", font=f_lead, fill=TEXT_SOFT)

    tags = [
        ["Aegis 加密备份", "SHA1 / SHA256 / SHA512"],
        ["1 ~ 10 位验证码", "逐条选择同步"],
    ]
    for row, items in enumerate(tags):
        x = 98.0
        y = 486.0 + row * 62.0
        for label in items:
            bbox = d.textbbox((0, 0), label, font=f_tag)
            tw = bbox[2] - bbox[0]
            pill = [x, y, x + tw + 44, y + 46]
            d.rounded_rectangle(pill, radius=23, fill=(10, 44, 36, 255), outline=(26, 92, 74, 255), width=2)
            d.text((x + 22, y + 22), label, font=f_tag, fill=(142, 232, 200), anchor="lm")
            x = pill[2] + 16

    d.text((98, 640), "解密全程在手机端完成 · 无网络权限 · 不上传任何数据", font=f_note, fill=TEXT_DIM)

    d.rounded_rectangle([96, 782, 100, 854], radius=2, fill=(*ACCENT, 255))
    d.text((122, 790), "无需云端", font=f_quote, fill=(111, 216, 180))
    d.text((122, 830), "无需账号 · 数据只在你手里", font=f_note, fill=TEXT_DIM)

    # 手环主视觉：屏幕按手环端真实列表页布局绘制
    cx = 1150
    sw, sh = 200, 510
    s = sw / 192.0
    screen_top = 195
    screen_left = cx - sw / 2
    screen_bottom = screen_top + sh

    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse([cx - 150, 855, cx + 150, 902], fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    cover = Image.alpha_composite(cover, shadow)

    d = ImageDraw.Draw(cover)

    # 表带
    for top in (70, 725):
        d.rounded_rectangle(
            [cx - 65, top, cx + 65, top + 165],
            radius=50,
            fill=(10, 42, 34, 255),
            outline=(30, 96, 78, 255),
            width=2,
        )

    # 表体
    d.rounded_rectangle(
        [cx - 123, 170, cx + 123, 740],
        radius=88,
        fill=(6, 17, 14, 255),
        outline=(36, 116, 94, 255),
        width=3,
    )
    d.rounded_rectangle(
        [cx - 112, 182, cx + 112, 728],
        radius=80,
        outline=(18, 62, 50, 255),
        width=2,
    )

    # 屏幕内容：按 192x490 的设计稿 1:1 还原列表布局
    scr = Image.new("RGBA", (sw, sh), (0, 0, 0, 255))
    sd = ImageDraw.Draw(scr)

    def X(v: float) -> float:
        return (v - 96) * s + sw / 2

    def Y(v: float) -> float:
        return v * s

    f_card_name = font(FONT_BOLD, round(23 * s))
    f_card_usr = font(FONT_REGULAR, round(16 * s))
    f_card_remain = font(FONT_REGULAR, round(14 * s))
    f_card_otp = font(FONT_MONO, round(31 * s))

    cards = [
        ("GitHub", "octocat", "483921", "18s"),
        ("Google", "me@gmail.com", "704268", "24s"),
        ("AWS", "root@prod", "915407", "9s"),
        ("Steam", "player_one", "K7M2Q", "27s"),
    ]
    for i, (name, usr, otp, remain) in enumerate(cards):
        top = Y(86 + i * 120)
        sd.rounded_rectangle(
            [X(3), top, X(189), top + Y(112)],
            radius=Y(24),
            fill=(28, 28, 30, 255),
        )
        sd.text((X(14), top + Y(8)), name, font=f_card_name, fill=(255, 255, 255, 255))
        sd.text((X(14), top + Y(40)), usr, font=f_card_usr, fill=(142, 142, 147, 255))
        sd.text(
            (X(182), top + Y(44)),
            remain,
            font=f_card_remain,
            fill=(142, 142, 147, 255),
            anchor="ra",
        )
        sd.text((X(14), top + Y(71)), otp, font=f_card_otp, fill=(255, 255, 255, 255))

    # 顶部信息按钮：白色椭圆 + 深色 i
    info_box = [X(45), Y(6), X(147), Y(78)]
    sd.ellipse(info_box, fill=(255, 255, 255, 255))
    icx = (info_box[0] + info_box[2]) / 2
    sd.ellipse([icx - 4 * s, Y(15), icx + 4 * s, Y(23)], fill=(32, 32, 32, 255))
    sd.rounded_rectangle([icx - 3 * s, Y(28), icx + 3 * s, Y(62)], radius=3 * s, fill=(32, 32, 32, 255))

    # 底部渐变遮罩
    fade = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fade)
    fade_h = int(Y(86))
    for i in range(fade_h):
        alpha = int(255 * (i / max(1, fade_h - 1)))
        fd.line([(0, sh - fade_h + i), (sw, sh - fade_h + i)], fill=(0, 0, 0, alpha))
    scr = Image.alpha_composite(scr, fade)

    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=54, fill=255)
    cover.paste(scr, (int(screen_left), screen_top), mask)
    d = ImageDraw.Draw(cover)
    d.rounded_rectangle(
        [screen_left, screen_top, screen_left + sw, screen_bottom],
        radius=54,
        outline=(20, 64, 52, 255),
        width=2,
    )

    # 页脚
    d.line([96, 906, width - 96, 906], fill=(20, 60, 49, 255), width=2)
    d.text((96, 932), "github.com/ymh0000123/BandTOTP-NEXT", font=f_foot, fill=TEXT_DIM, anchor="lt")
    d.text(
        (width - 96, 932),
        "MIT License · based on leset0ng/BandTOTP-Band",
        font=f_foot,
        fill=(79, 122, 108),
        anchor="rt",
    )

    return cover


def main() -> None:
    DOCS.mkdir(exist_ok=True)

    icon = render_icon(96, supersample=8)
    icon.save(ROOT / "src" / "common" / "logo.png", optimize=True)
    print(f"icon: {icon.size} -> src/common/logo.png")

    cover = render_cover(1500, 1000)
    cover.convert("RGB").save(DOCS / "cover.png", optimize=True)
    print(f"cover: {cover.size} -> docs/cover.png")


if __name__ == "__main__":
    main()
