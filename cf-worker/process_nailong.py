# -*- coding: utf-8 -*-
"""小奶图片预处理：抠白底 → 透明PNG → 统一 240x240 画布 → 输出到 public/js/nailong/
用法: python process_nailong.py
"""
import os
from PIL import Image, ImageOps

SRC = r"D:\CZSWeb\nailong"
DST = r"D:\CZSWeb\cf-worker\public\js\nailong"
SIZE = 240
os.makedirs(DST, exist_ok=True)

def remove_white_bg(img, threshold=235, feather=6):
    """把接近白色的像素变透明（带羽化过渡，边缘更自然清晰）"""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for x in range(w):
        for y in range(h):
            r, g, b, a = px[x, y]
            # 白色判定：RGB 都接近 255
            m = min(r, g, b)
            if m >= threshold:
                # 全白 → 全透明
                px[x, y] = (r, g, b, 0)
            elif m >= threshold - feather:
                # 边缘羽化：按亮度百分比渐隐，避免锯齿
                alpha = int(255 * (255 - m) / 255)
                px[x, y] = (r, g, b, alpha)
    return img

files = sorted(f for f in os.listdir(SRC) if f.lower().endswith((".jpg", ".jpeg", ".png")))
names = ["pose1", "pose2", "pose3", "pose4", "pose5", "pose6",
         "pose7", "pose8", "pose9", "pose10", "pose11", "pose12", "pose13"]
if len(files) > 13:
    print(f"警告：图片 {len(files)} 张 > 13，仅取前 13 张")
files = files[:13]

for i, f in enumerate(files):
    img = Image.open(os.path.join(SRC, f)).convert("RGBA")
    img = remove_white_bg(img)
    # 按最长边缩放到 SIZE（保持比例）
    img.thumbnail((SIZE, SIZE), Image.LANCZOS)
    # 居中画布
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ox = (SIZE - img.width) // 2
    oy = (SIZE - img.height) // 2
    canvas.paste(img, (ox, oy), img)
    out = os.path.join(DST, f"{names[i]}.png")
    canvas.save(out, "PNG")
    print(f"[OK] {f} -> {names[i]}.png ({SIZE}x{SIZE})")

print(f"\n完成，输出 {len(files)} 张透明 PNG 到 {DST}")
