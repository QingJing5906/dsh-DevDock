# -*- coding: utf-8 -*-
"""DevDock promo: pure-typography motion piece rendered with Pillow -> ffmpeg."""
import os, sys, math, functools
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
BG = (245, 244, 238)
INK = (25, 25, 25)
ACC = (217, 119, 87)
STONE = (184, 178, 167)

F_CN = "C:/Windows/Fonts/msyhbd.ttc"
F_CNR = "C:/Windows/Fonts/msyh.ttc"
F_GEO = "C:/Windows/Fonts/georgia.ttf"
F_GEB = "C:/Windows/Fonts/georgiab.ttf"
F_MONO = "C:/Windows/Fonts/consola.ttf"

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frames_raw")
os.makedirs(OUT, exist_ok=True)


@functools.lru_cache(maxsize=64)
def font(path, size):
    return ImageFont.truetype(path, size)


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(p):
    p = clamp(p)
    return 1 - (1 - p) ** 3


def track_width(fnt, text, tracking):
    if not text:
        return 0
    return sum(fnt.getlength(c) for c in text) + tracking * (len(text) - 1)


def draw_tracked(d, xy, text, fnt, color, tracking=0, alpha=255):
    x, y = xy
    for c in text:
        d.text((x, y), c, font=fnt, fill=(color[0], color[1], color[2], alpha))
        x += fnt.getlength(c) + tracking


def text_block(d, xy, lines, fnt, color, alpha=255, line_h=None, tracking=0):
    lh = line_h or int(fnt.size * 1.4)
    for i, line in enumerate(lines):
        if tracking:
            draw_tracked(d, (xy[0], xy[1] + i * lh), line, fnt, color, tracking, alpha)
        else:
            d.text((xy[0], xy[1] + i * lh), line, font=fnt, fill=(color[0], color[1], color[2], alpha))


def rule(d, x, y, w, h, color, alpha=255):
    if w <= 0:
        return
    d.rectangle([x, y, x + w, y + h - 1], fill=(color[0], color[1], color[2], alpha))


def new_layer():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def compose(layer):
    base = Image.new("RGB", (W, H), BG)
    base.paste(Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB"), (0, 0))
    return base


LEFT = 300
RIGHT = 1620
BOT = 980


# ---------------------------------------------------------------- scene 1: open
def scene_open(t):
    ly = new_layer()
    d = ImageDraw.Draw(ly)
    a = ease((t - 0.05) / 0.9)
    draw_tracked(d, (LEFT, 300), "DEV DOCK  /  GITHUB · GIT", font(F_CNR, 21), STONE, 4, int(255 * a))

    a1 = ease((t - 0.35) / 0.9)
    dy = int(12 * (1 - a1))
    text_block(d, (LEFT, 356 + dy), ["研发账号与服务", "一个面板管完"], font(F_CN, 96), INK, int(255 * a1), 132)

    g = ease((t - 1.1) / 1.0)
    rule(d, LEFT, 654, int(168 * g), 3, ACC)

    a2 = ease((t - 1.6) / 1.0)
    d.text((LEFT, 712), "在 DeepSeek Harness 里，账号、凭据、推送与版本树收在一处", font=font(F_CNR, 33), fill=INK + (int(255 * a2),))

    a3 = ease((t - 2.4) / 0.9)
    w = track_width(font(F_GEB, 26), "DevDock", 1)
    draw_tracked(d, (RIGHT - w, BOT - 30), "DevDock", font(F_GEB, 26), STONE, 1, int(255 * a3))
    return ly


# ------------------------------------------------------------- scene 2: friction
def scene_friction(t):
    ly = new_layer()
    d = ImageDraw.Draw(ly)
    a0 = ease((t - 0.05) / 0.8)
    draw_tracked(d, (LEFT, 320), "现 状", font(F_CNR, 20), STONE, 3, int(255 * a0))

    rows = [
        (0.35, "切仓库要开浏览器"),
        (1.35, "令牌散落在配置文件里"),
        (2.35, "推送前没人再看一眼"),
    ]
    for i, (t0, txt) in enumerate(rows):
        a = ease((t - t0) / 0.85)
        dy = int(14 * (1 - a))
        y = 408 + i * 116 + dy
        rule(d, LEFT, y + 18, int(30 * ease((t - t0) / 0.6)), 2, STONE, int(255 * a))
        d.text((LEFT + 58, y), txt, font=font(F_CN, 58), fill=INK + (int(255 * a),))

    a1 = ease((t - 3.7) / 1.0)
    rule(d, LEFT, 830, int(120 * a1), 1, STONE, int(200 * a1))
    d.text((LEFT, 860), "成本不在推送本身，在来回切换之间", font=font(F_CNR, 30), fill=STONE + (int(255 * a1),))
    return ly


# ------------------------------------------------------- scenes 3-5: highlights
def scene_highlight(t, idx, label, keyword, desc_lines):
    ly = new_layer()
    d = ImageDraw.Draw(ly)

    a0 = ease((t - 0.1) / 0.7)
    d.text((LEFT, 340), idx, font=font(F_GEB, 30), fill=ACC + (int(255 * a0),))
    draw_tracked(d, (LEFT + 62, 350), label, font(F_CNR, 20), STONE, 3, int(255 * a0))
    rule(d, LEFT + 62, 388, int(560 * ease((t - 0.2) / 1.4)), 1, STONE, int(150 * a0))

    g = ease((t - 0.55) / 1.1)
    rule(d, LEFT, 436, int(150 * g), 3, ACC)

    a1 = ease((t - 0.5) / 0.95)
    dy = int(12 * (1 - a1))
    f = font(F_CN, 88)
    d.text((LEFT, 482 + dy), keyword, font=f, fill=INK + (int(255 * a1),))

    a2 = ease((t - 1.15) / 1.05)
    dy2 = int(10 * (1 - a2))
    text_block(d, (LEFT, 650 + dy2), desc_lines, font(F_CNR, 32), STONE, int(255 * a2), 52)
    return ly


# ------------------------------------------------------------- scene 6: one core
def scene_same(t):
    ly = new_layer()
    d = ImageDraw.Draw(ly)

    a0 = ease((t - 0.05) / 0.7)
    d.text((LEFT, 320), "04", font=font(F_GEB, 30), fill=ACC + (int(255 * a0),))
    draw_tracked(d, (LEFT + 62, 330), "人 和 AI", font(F_CNR, 20), STONE, 3, int(255 * a0))
    rule(d, LEFT + 62, 368, int(560 * ease((t - 0.2) / 1.3)), 1, STONE, int(150 * a0))

    a1 = ease((t - 0.45) / 0.95)
    dy = int(12 * (1 - a1))
    text_block(d, (LEFT, 400 + dy), ["同一套能力", "界面和智能体都能用"], font(F_CN, 80), INK, int(255 * a1), 112)

    a2 = ease((t - 1.3) / 1.0)
    rule(d, LEFT, 676, int(120 * a2), 3, ACC)
    a3 = ease((t - 1.5) / 1.0)
    d.text((LEFT, 726), "界面上的操作，与模型工具", font=font(F_CNR, 32), fill=STONE + (int(255 * a3),))
    x = LEFT + font(F_CNR, 32).getlength("界面上的操作，与模型工具")
    d.text((x, 726), " github_link ", font=font(F_MONO, 31), fill=ACC + (int(255 * a3),))
    x += font(F_MONO, 31).getlength(" github_link ")
    d.text((x, 726), "，走的是同一条链路", font=font(F_CNR, 32), fill=STONE + (int(255 * a3),))

    a4 = ease((t - 2.6) / 1.0)
    d.text((LEFT, 806), "同一份账号与凭据，同一套推送与审查", font=font(F_CNR, 28), fill=STONE + (int(255 * a4),))
    return ly


# ---------------------------------------------------------------- scene 7: close
def scene_close(t):
    ly = new_layer()
    d = ImageDraw.Draw(ly)

    a0 = ease((t - 0.05) / 0.9)
    dy = int(12 * (1 - a0))
    d.text((LEFT, 300 + dy), "DevDock", font=font(F_GEB, 104), fill=INK + (int(255 * a0),))

    a1 = ease((t - 0.6) / 0.9)
    rule(d, LEFT, 470, int(168 * a1), 3, ACC)

    a2 = ease((t - 1.0) / 1.0)
    d.text((LEFT, 520), "在 DeepSeek Harness 里管理研发账号与服务", font=font(F_CNR, 32), fill=STONE + (int(255 * a2),))

    a3 = ease((t - 1.7) / 1.0)
    cmd = "dsh plugin --profile desktop add dsh-harness-push"
    d.text((LEFT, 618), cmd, font=font(F_MONO, 34), fill=INK + (int(255 * a3),))
    rule(d, LEFT, 688, int(1040 * ease((t - 1.9) / 1.2)), 1, STONE, int(170 * a3))

    a4 = ease((t - 2.8) / 1.0)
    d.text((LEFT, 736), "当前模块 GitHub / Git（npm: dsh-harness-push）；后续接入 Cloudflare 与 npm",
           font=font(F_CNR, 28), fill=STONE + (int(255 * a4),))
    return ly


SCENES = [
    (5.0, scene_open),
    (6.0, scene_friction),
    (7.0, lambda t: scene_highlight(t, "01", "多 账 号", "多账号，下拉即切",
                                    ["账号卡片显示头像、昵称与权限范围；切换后所有面板立刻跟随，", "不用重启。其它账号也看不到令牌原文。"])),
    (7.0, lambda t: scene_highlight(t, "02", "推 送 前 审 查", "推送前过一遍",
                                    ["规则扫描必跑，抓令牌、私钥与本机路径；模型审查按勾选的项目可选。", "发现阻断级问题只警告，不阻止推送。"])),
    (7.0, lambda t: scene_highlight(t, "03", "记 忆 与 版 本 树", "每条分支都记得",
                                    ["记住上次推送到哪个仓库、哪个 ref，回到分支自动带出。", "提交图带 lane 连线与 ref 标签，任意节点可检出、打标签。"])),
    (7.0, scene_same),
    (7.0, scene_close),
]

START = []
_s = 0.0
for dur, _ in SCENES:
    START.append(_s)
    _s += dur
TOTAL = _s
XF = 0.32


def frame_at(t):
    i = 0
    for k in range(len(SCENES)):
        if t >= START[k] - 1e-9:
            i = k
    dur, fn = SCENES[i]
    cur = compose(fn(min(t - START[i], dur)))
    if i > 0 and (t - START[i]) < XF:
        pdur, pfn = SCENES[i - 1]
        prev = compose(pfn(pdur))
        cur = Image.blend(prev, cur, ease((t - START[i]) / XF))
    return cur


def main():
    n = int(round(TOTAL * FPS))
    print("total %.2fs, %d frames" % (TOTAL, n))
    for k in range(n):
        img = frame_at(k / float(FPS))
        img.save(os.path.join(OUT, "f%05d.png" % k), optimize=False)
        if k % 150 == 0:
            print("frame", k)
    print("done")


if __name__ == "__main__":
    main()
