#!/usr/bin/env python3
"""生成「中文字体候选对比样张」——单文件 HTML，字体子集内嵌。

只含样张用到的字符，因此单文件很小；字体本身是 GB2312 全集子集。
用法：python3 scripts/build_font_specimen.py
产出：docs/demo/font-specimen.html
"""
import base64
import pathlib
import tempfile

from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path("/tmp/fontprobe")  # 调研时下载的源字体
OUT = ROOT / "docs" / "demo" / "font-specimen.html"

TITLE = "春江花月夜"
BODY = "春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。"
MIX = "The quick brown fox jumps over 0123456789"
RARE = "魑魅魍魉 · 饕餮 · 耄耋 · 龃龉 · 踟蹰"

# (显示名, css 类别, 源文件, 授权, 全量 MB, 一级 MB, 覆盖, 一句话点评)
FONTS = [
    ("思源宋体", "serif", ROOT / "assets/fonts/REwordSerifSC-VF.woff2",
     "OFL 1.1", "4.08", "1.30", "7546/7546", "已内置 · 衬线正文默认（可变字重）"),
    ("思源黑体", "sans", ROOT / "assets/fonts/REwordSansSC-Regular.woff2",
     "OFL 1.1", "1.95", "1.10", "7546/7546", "已内置 · 无衬线正文默认"),
    ("霞鹜文楷", "kai", SRC / "LXGWWenKaiGB-Regular.ttf",
     "OFL 1.1", "1.56", "0.84", "7546/7546", "新增 · 人文楷书，瘦长秀气"),
    ("楷体（Fandol）", "kai", SRC / "fandol/FandolKai-Regular.otf",
     "GPLv3+例外", "3.41", "1.80", "7542/7546", "新增 · 传统印刷楷体，端正方正"),
    ("仿宋（Fandol）", "fang", SRC / "fandol/FandolFang-Regular.otf",
     "GPLv3+例外", "3.34", "1.73", "7542/7546", "新增 · 横细竖粗，公文体"),
    ("马善政楷书", "xing", SRC / "MaShanZheng-Regular.ttf",
     "OFL 1.1", "3.08", "1.63", "6989/7546", "候选 · 毛笔楷书带行意，正文可读"),
    ("志莽行书", "xing", SRC / "ZhiMangXing.ttf",
     "OFL 1.1", "2.18", "1.17", "6989/7546", "备选 · 连笔行书，适合标题"),
]

ALL_TEXT = TITLE + BODY + MIX + RARE + "字体预览中文测试常用字"


def make_subset(src: pathlib.Path, text: str) -> str:
    """裁剪到样张用到的字符 → base64。已是 woff2 的直接读。"""
    if src.suffix == ".woff2":
        return base64.b64encode(src.read_bytes()).decode()
    f = TTFont(str(src))
    o = subset.Options()
    o.flavor = "woff2"
    o.layout_features = ["*"]
    o.name_IDs = [1, 2, 3, 4, 6]
    o.desubroutinize = False
    s = subset.Subsetter(options=o)
    s.populate(text=text)
    s.subset(f)
    f.flavor = "woff2"
    tmp = pathlib.Path(tempfile.mkdtemp()) / "s.woff2"
    f.save(str(tmp))
    return base64.b64encode(tmp.read_bytes()).decode()


def main() -> int:
    faces, cards = [], []
    for idx, (name, kind, path, lic, full, lv1, cov, note) in enumerate(FONTS):
        if not path.exists():
            print(f"跳过（源文件不存在）：{name} → {path}")
            continue
        fam = f"SP{idx}"
        b64 = make_subset(path, ALL_TEXT)
        faces.append(
            f'@font-face{{font-family:"{fam}";src:url(data:font/woff2;base64,{b64}) '
            f'format("woff2");font-display:block;}}'
        )
        cards.append(f"""
  <section class="row">
    <header>
      <h2 style="font-family:'{fam}'">{name}</h2>
      <span class="lic">{lic}</span>
      <span class="note">{note}</span>
    </header>
    <div class="sample" style="font-family:'{fam}', serif">
      <p class="t">{TITLE}</p>
      <p class="b">{BODY}</p>
      <p class="m">{MIX}　{RARE}</p>
    </div>
    <footer>
      <span><i>GB2312 全字符</i><b>{full} MB</b></span>
      <span><i>一级 3755 字</i><b>{lv1} MB</b></span>
      <span><i>字符覆盖</i><b>{cov}</b></span>
    </footer>
  </section>""")

    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>中文字体候选对比 · 6 款 + 2 个行楷备选</title>
<style>
{''.join(faces)}
:root {{
  --bg: #fbfaf8; --surface: #fff; --line: #e8e4de; --line-soft: #f0ece6;
  --text: #23211e; --text-2: #57524a; --muted: #8a8378; --accent: #9a5b3c;
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0; padding: 40px 48px 56px; background: var(--bg); color: var(--text);
  font-family: -apple-system, "PingFang SC", sans-serif; -webkit-font-smoothing: antialiased;
}}
.lede {{ max-width: 980px; margin: 0 auto 30px; }}
.lede h1 {{ font-size: 22px; margin: 0 0 10px; letter-spacing: .01em; }}
.lede p {{ margin: 0 0 6px; font-size: 13px; line-height: 1.85; color: var(--muted); }}
.lede b {{ color: var(--text); font-weight: 600; }}
.lede .warn {{ color: var(--accent); }}
.row {{
  max-width: 980px; margin: 0 auto 16px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
}}
.row header {{
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding: 13px 22px 11px; border-bottom: 1px solid var(--line-soft);
  background: linear-gradient(#fdfcfa, #faf8f5);
}}
.row header h2 {{ font-size: 19px; margin: 0; font-weight: 400; letter-spacing: .02em; }}
.lic {{
  font-size: 10px; padding: 2px 7px; border-radius: 20px;
  background: #eee9e2; color: #6f6659; letter-spacing: .02em;
}}
.note {{ font-size: 11.5px; color: var(--muted); margin-left: auto; }}
.sample {{ padding: 20px 22px 18px; }}
.sample p {{ margin: 0; }}
.t {{ font-size: 40px; line-height: 1.3; letter-spacing: .12em; margin-bottom: 12px !important; }}
.b {{ font-size: 19px; line-height: 1.95; letter-spacing: .02em; }}
.m {{ font-size: 14px; line-height: 1.9; color: var(--text-2); margin-top: 10px !important; }}
footer {{
  display: flex; gap: 26px; padding: 10px 22px 12px;
  border-top: 1px solid var(--line-soft); background: #fcfbf9;
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
}}
footer i {{ font-style: normal; margin-right: 6px; }}
footer b {{ color: var(--text-2); font-weight: 600; }}
</style></head>
<body>
<div class="lede">
  <h1>中文字体候选 · 同文对照</h1>
  <p>同一段文字在 7 款候选下的<strong>真实渲染</strong>（不是示意图）。
  前两款已内置；中间三款是这次要补的<b>文楷 / 楷体 / 仿宋</b>；末两款是<b>行楷</b>的两个候选。</p>
  <p class="warn">体积 = 裁到该字符集并转 woff2 后的大小。6 款全量合计 15.7 MB，一级字合计 8.4 MB。</p>
  <p>最低一行是缺字测试：<b>魑魅魍魉 饕餮 耄耋 龃龉 踟蹰</b> —— 若某个字显示为方框，
  说明该字体不含此字，正文里会回退成另一款字体。</p>
</div>
{''.join(cards)}
</body></html>"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"输出 {OUT.relative_to(ROOT)}  ({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
