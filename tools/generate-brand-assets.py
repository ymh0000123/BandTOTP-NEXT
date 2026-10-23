#!/usr/bin/env python3
"""生成 BandTOTP-NEXT 的品牌素材。

输出:
  src/common/logo.png   96x96 快应用图标（同时用于关于页）
  docs/cover.webp       2400x1600（3:2）README / 资源页头图

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


def render_cover(width: int = 2400, height: int = 1600, ss: int = 2) -> Image.Image:
    """3:2 资源页头图。

    以「大字号品牌名 + 两行标语」为主体，标签与页脚信息压缩为单行，
    保证在资源页缩小展示时仍能一眼读出名称与核心能力。
    绘制走 2x 超采样细节层，缩放后边缘与文字更锐利。
    """
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    t = (yy / height)[..., None]
    top = np.array([6, 13, 11], dtype=np.float32)
    bottom = np.array([9, 27, 22], dtype=np.float32)
    color = top * (1 - t) + bottom * t

    color += _radial_glow(width, height, width * 0.08, -height * 0.05, width * 0.60, 0.26)[..., None] * np.array(
        [0, 190, 130], dtype=np.float32
    )
    color += _radial_glow(width, height, width * 0.78, height * 0.50, width * 0.46, 0.30)[..., None] * np.array(
        [0, 165, 112], dtype=np.float32
    )

    grid = 52
    dots = ((xx % grid) < 1.5) & ((yy % grid) < 1.5)
    color[dots] += 14
    color = np.clip(color, 0, 255)

    cover = Image.fromarray(
        np.dstack([color, np.full((height, width), 255, dtype=np.float32)]).astype(np.uint8), "RGBA"
    )

    # 手环背后的柔光，把视线压到主体上
    halo = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([1830 - 360, 800 - 500, 1830 + 360, 800 + 500], fill=(0, 214, 148, 30))
    cover = Image.alpha_composite(cover, halo.filter(ImageFilter.GaussianBlur(120)))

    # ---- 细节层 ----
    layer = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def pt(x: float, y: float) -> tuple[float, float]:
        return (x * ss, y * ss)

    def fnt(size: float, bold: bool = True) -> ImageFont.FreeTypeFont:
        return font(FONT_BOLD if bold else FONT_REGULAR, int(round(size * ss)))

    def box(x0, y0, x1, y1, r, fill=None, outline=None, w=0.0) -> None:
        d.rounded_rectangle(
            [x0 * ss, y0 * ss, x1 * ss, y1 * ss],
            radius=r * ss,
            fill=fill,
            outline=outline,
            width=int(round(w * ss)),
        )

    def text(x, y, s, size, fill, bold=True, anchor="la") -> None:
        d.text(pt(x, y), s, font=fnt(size, bold), fill=fill, anchor=anchor)

    # 手环主视觉
    cx = 1830.0
    bw, bh = 424.0, 976.0
    bx0, by0 = cx - bw / 2, 312.0
    bx1, by1 = cx + bw / 2, by0 + bh

    for band_top, band_bottom in ((58.0, 392.0), (1208.0, 1542.0)):
        box(cx - 104, band_top, cx + 104, band_bottom, 72, fill=(9, 38, 31, 255), outline=(27, 88, 72, 255), w=3)

    box(bx0, by0, bx1, by1, 155, fill=(7, 18, 15, 255), outline=(47, 138, 110, 255), w=4)
    box(bx0 + 9, by0 + 9, bx1 - 9, by1 - 9, 147, outline=(19, 63, 51, 255), w=3)

    sw_, sh_ = 372.0, 888.0
    sx0, sy0 = cx - sw_ / 2, by0 + 44
    sx1, sy1 = sx0 + sw_, sy0 + sh_
    box(sx0, sy0, sx1, sy1, 54, fill=(0, 0, 0, 255), outline=(17, 58, 47, 255), w=2)

    cards = [
        ("GitHub", "483 921", "18s"),
        ("Google", "704 268", "24s"),
        ("Steam", "K7M2Q", "27s"),
    ]
    f_otp = font(FONT_MONO, int(round(62 * ss)))
    for i, (name, otp, remain) in enumerate(cards):
        card_top = sy0 + 34 + i * 252
        card_x = sx0 + 16
        box(card_x, card_top, card_x + 340, card_top + 230, 44, fill=(27, 27, 29, 255))
        text(card_x + 24, card_top + 20, name, 36, (255, 255, 255, 255))
        text(card_x + 316, card_top + 30, remain, 26, (140, 140, 146, 255), bold=False, anchor="ra")
        d.text(pt(card_x + 24, card_top + 76), otp, font=f_otp, fill=(255, 255, 255, 255))

    # 列表底部渐隐（独立叠加层做真正的 alpha 混合，跟随屏幕圆角收边）
    fade_top = sy0 + 618
    fh = int((sy1 - fade_top) * ss)
    fade_img = Image.new("RGBA", (int(sw_ * ss), fh), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fade_img)
    rr = 54.0
    for i in range(fh):
        yf = fade_top + i / ss
        dy = yf - (sy1 - rr)
        inset = rr - math.sqrt(max(0.0, rr * rr - dy * dy)) if dy > 0 else 0.0
        alpha = int(255 * (i / max(1, fh - 1)) ** 0.85)
        fd.rectangle([inset * ss + 4, i, (sw_ - inset) * ss - 4, i + 1], fill=(0, 0, 0, alpha))
    layer.alpha_composite(fade_img, (int(sx0 * ss), int(fade_top * ss)))

    # ---- 文案 ----
    text(336, 268, "BandTOTP-NEXT", 112, (*TEXT_MAIN, 255))
    text(340, 404, "手环上的 Aegis TOTP 验证器", 46, (111, 216, 180, 255), bold=False)

    text(150, 636, "把验证码", 150, (*TEXT_MAIN, 255))
    text(150, 808, "戴在手腕上", 150, (*TEXT_MAIN, 255))

    text(154, 1002, "Aegis 备份一次导入，验证码抬手即看", 50, (*TEXT_SOFT, 255), bold=False)

    pills = ["小米手环 9", "Aegis 加密备份", "1 ~ 10 位验证码", "无网络权限"]
    max_pill_w = 1180.0
    size = 38.0
    while True:
        f_pill = fnt(size, bold=False)
        total = sum(d.textlength(p, font=f_pill) / ss + 64 for p in pills) + 24 * (len(pills) - 1)
        if total <= max_pill_w or size <= 30:
            break
        size -= 2

    px_x = 150.0
    pill_y, pill_h = 1092.0, 84.0
    for label_txt in pills:
        tw = d.textlength(label_txt, font=f_pill) / ss
        pw = tw + 64
        box(px_x, pill_y, px_x + pw, pill_y + pill_h, pill_h / 2, fill=(10, 44, 36, 236), outline=(28, 96, 78, 255), w=2)
        d.text(pt(px_x + 32, pill_y + pill_h / 2), label_txt, font=f_pill, fill=(142, 232, 200, 255), anchor="lm")
        px_x += pw + 24

    # 页脚
    d.line([pt(150, 1372), pt(1370, 1372)], fill=(26, 70, 57, 255), width=max(1, int(2 * ss)))
    foot_l = "github.com/ymh0000123/BandTOTP-NEXT"
    foot_r = "MIT License · based on leset0ng/BandTOTP-Band"
    fs = 34.0
    while fs > 22:
        f_foot = fnt(fs, bold=False)
        if d.textlength(foot_l, font=f_foot) / ss + d.textlength(foot_r, font=f_foot) / ss + 48 <= 1220:
            break
        fs -= 2
    text(150, 1394, foot_l, fs, (*TEXT_DIM, 255), bold=False)
    text(1370, 1394, foot_r, fs, (79, 122, 108, 255), bold=False, anchor="ra")

    cover = Image.alpha_composite(cover, layer.resize((width, height), Image.LANCZOS))

    icon = render_icon(156, supersample=6)
    cover.alpha_composite(icon, (150, 262))

    return cover


def main() -> None:
    DOCS.mkdir(exist_ok=True)

    icon = render_icon(96, supersample=8)
    icon.save(ROOT / "src" / "common" / "logo.png", optimize=True)
    print(f"icon: {icon.size} -> src/common/logo.png")

    cover = render_cover(2400, 1600)
    cover.convert("RGB").save(DOCS / "cover.webp", quality=88, method=6)
    print(f"cover: {cover.size} -> docs/cover.webp")


if __name__ == "__main__":
    main()
