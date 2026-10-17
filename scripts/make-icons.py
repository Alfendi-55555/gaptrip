# 앱 아이콘과 공유 미리보기 이미지(OG) 만들기 — 디자인을 바꿀 때만 손으로 실행
#   python scripts/make-icons.py
# 필요: Pillow, 맑은 고딕(Windows 기본 글꼴). 결과는 icons/ 에 저장.
import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'icons')
CLAY = (178, 65, 15)
INK = (29, 27, 24)
MUTED = (92, 87, 79)
BG = (247, 245, 240)
WHITE = (255, 255, 255)
FONT_DIR = 'C:/Windows/Fonts'


def mark(size, rounded=True):
    """점토색 바탕 + 한쪽이 트인 고리 + 틈에 놓인 점 (favicon.svg와 같은 모양)"""
    s = 4  # 크게 그린 뒤 줄여서 가장자리를 매끄럽게
    S = size * s
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 14 / 64), fill=CLAY)
    else:
        d.rectangle([0, 0, S, S], fill=CLAY)
    c = S / 2
    r = S * 18 / 64
    w = int(S * 6 / 64)
    d.arc([c - r, c - r, c + r, c + r], start=0, end=270, fill=WHITE, width=w)
    # 둥근 끝
    for ang in (0, 270):
        x = c + r * math.cos(math.radians(ang)) - w / 2 * math.cos(math.radians(ang))
        y = c + r * math.sin(math.radians(ang)) - w / 2 * math.sin(math.radians(ang))
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)
    dot_r = S * 5 / 64
    dx, dy = c + r * math.cos(math.radians(-45)), c + r * math.sin(math.radians(-45))
    d.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def og():
    W, H = 1200, 630
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    bold = ImageFont.truetype(os.path.join(FONT_DIR, 'malgunbd.ttf'), 96)
    mid = ImageFont.truetype(os.path.join(FONT_DIR, 'malgun.ttf'), 40)
    small = ImageFont.truetype(os.path.join(FONT_DIR, 'malgun.ttf'), 30)
    icon = mark(176)
    img.paste(icon, (96, 120), icon)
    d.text((96, 330), '틈새 나들이', font=bold, fill=INK)
    d.text((100, 460), '돌아올 시간까지 계산해서, 지금 다녀올 수 있는 곳만', font=mid, fill=INK)
    d.text((100, 530), '서울 공공데이터 기반 · 한국외대 주변', font=small, fill=MUTED)
    d.rectangle([0, H - 14, W, H], fill=CLAY)
    return img


os.makedirs(OUT, exist_ok=True)
mark(180, rounded=False).save(os.path.join(OUT, 'apple-touch-icon.png'))  # iOS가 모서리를 직접 둥글게 함
mark(192).save(os.path.join(OUT, 'icon-192.png'))
mark(512).save(os.path.join(OUT, 'icon-512.png'))
og().save(os.path.join(OUT, 'og.png'), optimize=True)
print('icons/: apple-touch-icon.png, icon-192.png, icon-512.png, og.png')
