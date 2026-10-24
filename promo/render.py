# -*- coding: utf-8 -*-
"""DevDock promo v2: editorial typography + real UI screenshots (rounded, soft shadow,
enter animation), rendered with Pillow and piped straight into ffmpeg (no audio track).

Run:  python render.py
Out:  promo/devdock-promo.mp4  +  promo/frames/frame-0N-*.png
"""
import os, sys, functools, subprocess
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W, H = 1920, 1080
FPS = 30
BG = (245, 244, 238)
INK = (25, 25, 25)
ACC = (217, 119, 87)
STONE = (184, 178, 167)
BORDER = (227, 223, 214)          # #E3DFD6 hairline around screenshots

F_CN = "C:/Windows/Fonts/msyhbd.ttc"
F_CNR = "C:/Windows/Fonts/msyh.ttc"
F_GEO = "C:/Windows/Fonts/georgia.ttf"
F_GEB = "C:/Windows/Fonts/georgiab.ttf"
F_MONO = "C:/Windows/Fonts/consola.ttf"

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
OUT = os.path.join(HERE, "frames_raw")
FRAMES = os.path.join(HERE, "frames")
FFMPEG = r"C:\ffmpeg-8.0.1-essentials_build\bin\ffmpeg.exe"
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"
MP4 = os.path.join(HERE, "devdock-promo.mp4")

# ---- screenshot composition (identical rule for every shot in the film) ----
MAX_W, MAX_H = 1180, 614        # content box (max 1180x640 per brief)
BAND_TOP, BAND_BOT = 376, 990   # shot band; bottom air = 90px
CX, CY = W // 2, (BAND_TOP + BAND_BOT) // 2
RADIUS = 12                     # 12px corners
SHADOW_ALPHA = 0.14             # 14% black
SHADOW_BLUR = 13                # gaussian radius (12-18)
SHADOW_DY = 7                   # offset down 6-10px
PAD = 60                        # room for blur + offset inside the asset canvas
SS = 2                          # supersample factor for the asset
MAX_UPSCALE = 2.2               # keep small shots from turning to mush


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
    base = Image.new("RGBA", (W, H), BG + (255,))
    return Image.alpha_composite(base, layer).convert("RGB")


LEFT = 300
RIGHT = 1620
BOT = 980


# ------------------------------------------------------------------ screenshots
@functools.lru_cache(maxsize=16)
def shot_asset(name):
    """Scale a shot into the 1180x640 box, round the corners, build a soft shadow."""
    src = Image.open(os.path.join(SHOTS, name + ".png")).convert("RGB")
    sw, sh = src.size
    cap = MAX_UPSCALE if sw < 700 else 1e9
    s = min(MAX_W / sw, MAX_H / sh, cap)
    dw, dh = int(round(sw * s)), int(round(sh * s))

    cw, ch = (dw + 2 * PAD) * SS, (dh + 2 * PAD) * SS
    big = src.resize((dw * SS, dh * SS), Image.LANCZOS)

    mask = Image.new("L", (cw, ch), 0)
    md = ImageDraw.Draw(mask)
    x0, y0 = PAD * SS, PAD * SS
    md.rounded_rectangle([x0, y0, x0 + dw * SS - 1, y0 + dh * SS - 1],
                         radius=RADIUS * SS, fill=255)

    content = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    content.paste(big, (x0, y0))
    content.putalpha(mask)
    bd = ImageDraw.Draw(content)
    bd.rounded_rectangle([x0 + 0.5, y0 + 0.5, x0 + dw * SS - 1.5, y0 + dh * SS - 1.5],
                         radius=RADIUS * SS, outline=BORDER + (255,), width=SS)

    blurred = mask.filter(ImageFilter.GaussianBlur(radius=SHADOW_BLUR * SS))
    shifted = ImageChops.offset(blurred, 0, SHADOW_DY * SS)
    shadow = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    shadow.putalpha(shifted.point(lambda v: int(v * SHADOW_ALPHA)))

    return {"content": content, "shadow": shadow, "size": (cw, ch),
            "dw": dw, "dh": dh}


def blit_shot(base, name, alpha, scale, dy, shadow_strength):
    """alpha 0-1, scale 1.0 = resting size, dy = extra downward px."""
    a = shot_asset(name)
    tw = max(1, int(round(a["size"][0] / SS * scale)))
    th = max(1, int(round(a["size"][1] / SS * scale)))
    content = a["content"].resize((tw, th), Image.LANCZOS)
    shadow = a["shadow"].resize((tw, th), Image.LANCZOS)

    def mul_alpha(img, f):
        if f >= 0.999:
            return img
        ch = list(img.split())
        ch[3] = ch[3].point(lambda v: int(v * f))
        return Image.merge("RGBA", ch)

    shadow = mul_alpha(shadow, alpha * shadow_strength)
    content = mul_alpha(content, alpha)

    canvas = shadow.copy()
    canvas.alpha_composite(content)
    left = int(round(CX - tw / 2.0))
    top = int(round(CY - th / 2.0 + dy + 0))
    base.paste(canvas, (left, top), canvas)


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
    return compose(ly)


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
    return compose(ly)


# ------------------------------------------------------ scenes 3-6: shot + copy
def scene_shot(t, idx, label, headline, desc_lines, shots):
    """shots: [(t_in, name, t_out_or_None)] -- one visible at a time."""
    base = Image.new("RGB", (W, H), BG)
    for t_in, name, t_out in shots:
        if t < t_in:
            continue
        e = ease((t - t_in) / 1.0)
        op = e
        if t_out is not None and t > t_out:
            op *= (1 - ease((t - t_out) / 0.3))
        if op <= 0.001:
            continue
        blit_shot(base, name, op,
                  scale=0.98 + 0.02 * e,     # 1.00 -> 1.02 worth of growth, max 2%
                  dy=14 * (1 - e),           # 14px -> 0
                  shadow_strength=0.60 + 0.40 * e)

    ly = new_layer()
    d = ImageDraw.Draw(ly)

    a0 = ease((t - 0.10) / 0.70)
    d.text((LEFT, 92), idx, font=font(F_GEB, 28), fill=ACC + (int(255 * a0),))
    draw_tracked(d, (LEFT + 62, 102), label, font(F_CNR, 19), STONE, 3, int(255 * a0))
    rule(d, LEFT + 62, 140, int(600 * ease((t - 0.15) / 1.3)), 1, STONE, int(150 * a0))

    g = ease((t - 0.30) / 1.0)
    rule(d, LEFT, 178, int(120 * g), 3, ACC)

    a1 = ease((t - 0.35) / 0.95)
    dy = int(14 * (1 - a1))
    d.text((LEFT, 206 + dy), headline, font=font(F_CN, 64), fill=INK + (int(255 * a1),))

    a2 = ease((t - 0.90) / 1.0)
    dy2 = int(10 * (1 - a2))
    text_block(d, (LEFT, 306 + dy2), desc_lines, font(F_CNR, 27), STONE, int(255 * a2), 46)

    return Image.alpha_composite(base.convert("RGBA"), ly).convert("RGB")


# ------------------------------------------------------------- scene 7: one core
def scene_same(t):
    ly = new_layer()
    d = ImageDraw.Draw(ly)

    a0 = ease((t - 0.05) / 0.7)
    d.text((LEFT, 320), "05", font=font(F_GEB, 30), fill=ACC + (int(255 * a0),))
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
    return compose(ly)


# ---------------------------------------------------------------- scene 8: close
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
    return compose(ly)


SCENES = [
    (4.6, "open", scene_open),
    (5.2, "friction", scene_friction),
    (8.0, "accounts", lambda t: scene_shot(
        t, "01", "多 账 号", "多账号，下拉即切",
        ["账号卡片带头像、昵称与权限范围；切换后所有面板立刻跟随，不用重启。"],
        [(1.05, "account-card", None)])),
    (8.0, "cards", lambda t: scene_shot(
        t, "02", "仓 库 视 图", "仓库一眼看完",
        ["卡片视图带语言占比条与 star、fork；列表与卡片两种密度随时切换。"],
        [(1.05, "cards", None)])),
    (9.4, "push", lambda t: scene_shot(
        t, "03", "推 送 前 审 查", "推送前先过一遍",
        ["规则扫描必跑，抓令牌、私钥与本机路径；模型审查按勾选的项目可选。"],
        [(1.05, "push-tab", 3.90), (4.25, "review", None)])),
    (7.0, "manage", lambda t: scene_shot(
        t, "04", "仓 库 管 理", "仓库管理在一处",
        ["概览指标、topics、语言与许可，在一个弹窗里改完。"],
        [(1.05, "manage", None)])),
    (6.0, "same", scene_same),
    (6.2, "close", scene_close),
]

NAMES = [n for _, n, _ in SCENES]
START = []
_s = 0.0
for dur, _, _ in SCENES:
    START.append(_s)
    _s += dur
TOTAL = _s
START_T = dict(zip(NAMES, START))
XF = 0.32


def frame_at(t):
    i = 0
    for k in range(len(SCENES)):
        if t >= START[k] - 1e-9:
            i = k
    dur, _, fn = SCENES[i]
    cur = fn(min(t - START[i], dur))
    if i > 0 and (t - START[i]) < XF:
        pdur, _, pfn = SCENES[i - 1]
        prev = pfn(pdur)
        cur = Image.blend(prev, cur, ease((t - START[i]) / XF))
    return cur


# ---------------------------------------------------------------- frame stills
STILLS = [
    ("frame-01-open.png", lambda: START_T["open"] + 2.9),
    ("frame-02-accounts.png", lambda: START_T["accounts"] + 5.4),
    ("frame-03-cards.png", lambda: START_T["cards"] + 5.4),
    ("frame-04-push.png", lambda: START_T["push"] + 3.3),
    ("frame-05-review.png", lambda: START_T["push"] + 8.1),
    ("frame-06-close.png", lambda: START_T["close"] + 4.6),
]


def extract_stills():
    os.makedirs(FRAMES, exist_ok=True)
    for name, tb in STILLS:
        ts = tb()
        out = os.path.join(FRAMES, name)
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", "%.3f" % ts,
                        "-i", MP4, "-frames:v", "1", out], check=True)
        print("still %-26s t=%.2fs" % (name, ts))


def main():
    total_frames = int(round(TOTAL * FPS))
    print("total %.2fs, %d frames" % (TOTAL, total_frames))
    print("scenes:", ", ".join("%s@%.2f" % (n, s) for n, s in zip(NAMES, START)))

    cmd = [FFMPEG, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
           "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
           "-pix_fmt", "yuv420p", "-r", str(FPS), "-movflags", "+faststart", MP4]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for k in range(total_frames):
        img = frame_at(k / float(FPS))
        p.stdin.write(img.tobytes())
        if k % 150 == 0:
            print("frame", k, "/", total_frames)
    p.stdin.close()
    rc = p.wait()
    if rc != 0:
        raise SystemExit("ffmpeg failed: %d" % rc)
    print("encoded", MP4)
    extract_stills()
    print("done")


if __name__ == "__main__":
    main()
