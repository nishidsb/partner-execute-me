# -*- coding: utf-8 -*-
"""从参考项目图标源生成 Ryza Assistant 全套图标（ICO + 托盘 PNG）。"""
import os
from PIL import Image, ImageDraw

SRC = r"C:\Users\username\Documents\agentatelierR\AgentAtelierR-1.0.4.1\assets\branding\app_icon_source.png"
APP = r"C:\Users\username\WorkBuddy\2026-10-18-16-02-49\ryza-assistant\app"

def rounded(img, radius_ratio=0.18):
    """圆角遮罩：小尺寸时半径按比例缩放，抗锯齿。"""
    s = img.size[0]
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(s * radius_ratio), fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out

src = Image.open(SRC).convert("RGBA")
side = min(src.size)
left, top = (src.width - side) // 2, (src.height - side) // 2
src = src.crop((left, top, left + side, top + side))  # 中心正方形裁剪

branding = os.path.join(APP, "build", "branding")
os.makedirs(branding, exist_ok=True)

# 1) 源图收进项目（后续重生成不再依赖外部路径）
src.resize((512, 512), Image.LANCZOS).save(os.path.join(branding, "app-icon-source.png"))

# 2) 托盘 / 应用内图标 PNG（圆角）
for size in (16, 32, 64, 256):
    img = rounded(src.resize((size, size), Image.LANCZOS))
    name = "icon.png" if size == 256 else f"tray-{size}.png"
    img.save(os.path.join(branding, name))
    img.save(os.path.join(APP, "src", "main", "resources", name))
    print("png", name)

# 3) exe 安装包图标：多尺寸 ICO（electron-builder 自动取各尺寸）
ico_sizes = [256, 128, 64, 48, 32, 16]
frames = [rounded(src.resize((s, s), Image.LANCZOS)) for s in ico_sizes]
frames[0].save(os.path.join(APP, "build", "icon.ico"),
               format="ICO", sizes=[(s, s) for s in ico_sizes])
print("ico ok:", os.path.join(APP, "build", "icon.ico"))
