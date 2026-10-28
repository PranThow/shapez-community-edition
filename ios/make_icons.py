"""Renders the iOS app icons from the shapez logo: opaque, slate background, logo centered."""
import sys
from PIL import Image, ImageDraw

src, out = sys.argv[1], sys.argv[2]
S = 1024
bg = Image.new("RGB", (S, S))
draw = ImageDraw.Draw(bg)
top, bottom = (78, 83, 99), (44, 46, 56)
for y in range(S):
    t = y / (S - 1)
    draw.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))

logo = Image.open(src).convert("RGBA")
size = int(S * 0.66)
logo = logo.resize((size, size), Image.LANCZOS)
bg.paste(logo, ((S - size) // 2, (S - size) // 2), logo)

for name, px in {
    "AppIcon60x60@2x.png": 120,
    "AppIcon60x60@3x.png": 180,
    "AppIcon76x76@2x~ipad.png": 152,
    "AppIcon83.5x83.5@2x~ipad.png": 167,
    "AppIcon1024.png": 1024,
}.items():
    bg.resize((px, px), Image.LANCZOS).save(f"{out}/{name}", optimize=True)
