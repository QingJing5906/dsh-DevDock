import subprocess, sys, os

script = r'''
from PIL import Image, ImageDraw

S = 512          # 输出尺寸
G = 24.0         # viewBox 单位
k = S / G        # 单位 -> 像素

def px(v):
    return v * k

img = Image.new("RGBA", (S, S), (255, 255, 255, 0))
d = ImageDraw.Draw(img)

# 深色圆角底
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=px(8), fill=(13, 17, 23, 255))

w = int(px(3.1) * 1.0)  # 描边宽度

# 粗体 D：竖干 + 半圆碗（与 icon.svg 的 path 同几何）
d.line([(px(10), px(7.5)), (px(10), px(24.5))], fill=(255, 255, 255, 255), width=w)
d.line([(px(10), px(7.5)), (px(16.2), px(7.5))], fill=(255, 255, 255, 255), width=w)
d.line([(px(10), px(24.5)), (px(16.2), px(24.5))], fill=(255, 255, 255, 255), width=w)
# 半圆碗：圆心在 (16.2, 16)，半径 8.5，从 -90° 到 +90°
box = [px(16.2) - px(8.5), px(16) - px(8.5), px(16.2) + px(8.5), px(16) + px(8.5)]
d.arc(box, start=-90, end=90, fill=(255, 255, 255, 255), width=w)

# 蓝点
r = px(2.6)
d.ellipse([px(25.4) - r, px(24.2) - r, px(25.4) + r, px(24.2) + r], fill=(47, 123, 246, 255))

img.save(sys.argv[1])
print("wrote", sys.argv[1])
'''

open(os.path.join(os.environ.get('TEMP', '.'), '_icon_preview.py'), 'w', encoding='utf-8').write(script)
subprocess.run([sys.executable, os.path.join(os.environ.get('TEMP', '.'), '_icon_preview.py'),
                r'D:\360MoveData\Users\向崇华\Desktop\github管理插件\dsh-push\tests\_icon_preview.png'],
               check=True)

# 同时缩小到 16px 看看低分辨率下还认不认得出
from PIL import Image
big = Image.open(r'D:\360MoveData\Users\向崇华\Desktop\github管理插件\dsh-push\tests\_icon_preview.png')
small = big.resize((16, 16), Image.LANCZOS).resize((128, 128), Image.NEAREST)
small.save(r'D:\360MoveData\Users\向崇华\Desktop\github管理插件\dsh-push\tests\_icon_16px.png')
print("16px simulation written")
