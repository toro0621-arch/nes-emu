# アプリのアイコン（十字キーと赤い丸ボタン）を作る。public/icons/ に出力
#   python3 scripts/make-icons.py
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
BG = (22, 22, 29)
PANEL = (58, 58, 74)
RED = (224, 82, 76)
RED_SHADOW = (143, 42, 38)


def draw(size: int, safe: float, rounded: bool) -> Image.Image:
    """safe: 絵を収める範囲（maskable は外側が切られるので小さめ）"""
    s = size * 4  # 大きく描いて縮小し、ふちを滑らかにする
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.22, fill=BG)
    else:
        d.rectangle((0, 0, s, s), fill=BG)

    u = s * safe / 10  # 絵の 1 単位
    cx, cy = s / 2, s / 2

    # 十字キー（左）
    px, py, arm = cx - 2.4 * u, cy, 0.85 * u
    for x0, y0, x1, y1 in [
        (px - arm, py - 2.6 * u, px + arm, py + 2.6 * u),
        (px - 2.6 * u, py - arm, px + 2.6 * u, py + arm),
    ]:
        d.rounded_rectangle((x0, y0, x1, y1), radius=0.45 * u, fill=PANEL)

    # A / B（右、斜めに並べる）
    r = 1.15 * u
    for bx, by in [(cx + 1.7 * u, cy + 1.0 * u), (cx + 3.6 * u, cy - 1.0 * u)]:
        d.ellipse((bx - r, by - r + 0.25 * u, bx + r, by + r + 0.25 * u), fill=RED_SHADOW)
        d.ellipse((bx - r, by - r, bx + r, by + r), fill=RED)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, 0.74, True).save(OUT / 'icon-192.png')
    draw(512, 0.74, True).save(OUT / 'icon-512.png')
    # maskable：OS が丸や角丸に切り抜くので、背景を全面に塗り、絵は中央 80% に収める
    draw(512, 0.62, False).save(OUT / 'maskable-512.png')
    # iOS のホーム画面用（iOS が角を丸めるので四角のまま）
    draw(180, 0.74, False).convert('RGB').save(OUT / 'apple-touch-icon.png')
    draw(64, 0.74, True).save(OUT / 'favicon.png')
    print('wrote', ', '.join(sorted(p.name for p in OUT.iterdir())))


if __name__ == '__main__':
    main()
