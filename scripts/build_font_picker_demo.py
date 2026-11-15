#!/usr/bin/env python3
"""
构建字体设置交互 Demo（docs/demo/font-picker-demo.html）
--------------------------------------------------------------
做三件事：
  1. 扫描模板里所有用到的字符（含 JS 里动态拼的中文标签）；
  2. 从 assets/fonts/ 的两份内置字体裁出「只含这些字」的微型子集
     （GB2312 全量各 2MB+，demo 只用得上一两百字，裁完各 ~20KB）；
  3. base64 内嵌进 @font-face，产出**单文件** HTML —— 双击即可打开，
     不依赖本地 http 服务，也不会被 file:// 的字体跨域策略拦住。

用法：python3 scripts/build_font_picker_demo.py
"""

from __future__ import annotations

import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "docs" / "demo" / "_template.html"
OUTPUT = ROOT / "docs" / "demo" / "font-picker-demo.html"
FONT_SERIF = ROOT / "assets" / "fonts" / "REwordSerifSC-VF.woff2"
FONT_SANS = ROOT / "assets" / "fonts" / "REwordSansSC-Regular.woff2"

# 保底字符：即使模板里没出现，也确保字体名、标点、数字有字形
EXTRA = (
    "自动内置系统当前未安装已移除与上方相同已自动剔除可选顶项"
    "衬线体中文名搜移动选择关闭本机安装默认随插件分发删除保留精简全留"
    "宋黑楷仿苹方霞鹜文思源冬青微软雅黑"
    "他们坐在讲台上读书为什么没有人说话横细竖粗带书写笔意介两者之间均匀同一句四款种表情"
    "纸上得来终觉浅窗外的光线斜斜落下来把页照发亮字与之距离决定阅读呼吸画粗细气质"
    "→·—、。，；：？！（）《》「」"
)


def collect_text() -> str:
    src = TEMPLATE.read_text(encoding="utf-8")
    # 模板里写的是 __SERIF_B64__ 占位符，不含真实 base64，可以直接全文扫描
    chars = {c for c in src if ord(c) > 127}
    chars.update(EXTRA)
    body = "".join(sorted(chars))
    ascii_part = "".join(chr(i) for i in range(0x20, 0x7F))
    # 实体渲染出来的字符
    ascii_part += "\u2014\u2018\u2019\u201c\u201d\u2026\u00a0"
    return ascii_part + body


def make_subset(src: pathlib.Path, text: str) -> bytes:
    """就地裁子集，产物直接留在内存里（不落临时文件，避免清理麻烦）。"""
    import io

    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(str(src))
    opts = subset.Options()
    # 保留排版特性：竖排/比例标点对中文有意义，kern/liga 保住西文观感
    opts.layout_features = ["kern", "liga", "clig", "calt", "palt", "vert", "vrt2"]
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.drop_tables += ["DSIG"]

    ss = subset.Subsetter(options=opts)
    ss.populate(text=text)
    ss.subset(font)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def main() -> int:
    for p in (TEMPLATE, FONT_SERIF, FONT_SANS):
        if not p.exists():
            print(f"[!] 缺少文件：{p}", file=sys.stderr)
            return 1

    text = collect_text()
    serif_bytes = make_subset(FONT_SERIF, text)
    sans_bytes = make_subset(FONT_SANS, text)

    html = TEMPLATE.read_text(encoding="utf-8")
    html = html.replace("__SERIF_B64__", base64.b64encode(serif_bytes).decode())
    html = html.replace("__SANS_B64__", base64.b64encode(sans_bytes).decode())

    OUTPUT.write_text(html, encoding="utf-8")

    print(f"字符数        : {len(text)}")
    print(f"思源宋体子集  : {len(serif_bytes)/1024:.1f} KB  (原 {FONT_SERIF.stat().st_size/1024:.0f} KB)")
    print(f"思源黑体子集  : {len(sans_bytes)/1024:.1f} KB  (原 {FONT_SANS.stat().st_size/1024:.0f} KB)")
    print(f"输出          : {OUTPUT.relative_to(ROOT)}  ({OUTPUT.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
