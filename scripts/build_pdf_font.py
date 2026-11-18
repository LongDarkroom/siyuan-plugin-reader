#!/usr/bin/env python3
"""构建 PDF 用的 TrueType 字体（2026-11-17，双语对照 PDF 导出）。

产物（随插件分发，见 assets/fonts/）：
    REwordSerifSC-PDF.ttf     思源宋体 → TrueType(glyf) 轮廓、pin wght=400

## 为什么需要单独一个 TTF
生成 PDF 时字体必须嵌进 PDF。pdf-lib + fontkit 对**输入格式**有硬要求：

| 格式 | 能否 embed | 能否 subset | 备注 |
|------|-----------|------------|------|
| .ttf (glyf) | ✓ | ✓ | 本脚本的目标 |
| .otf/.ttc (CFF) | ✓ | ✓ | 嵌成 CIDFontType0，**Chrome 画不出来** |
| .woff2 | ✓ | ✗ | fontkit 报 `glyph._decode is not a function` |

现有 `REwordSerifSC-VF.woff2` 是 **CFF2 轮廓**（sfnt tag = `OTTO`）——两不沾：
既不能 subset，嵌进 PDF 后又是 Chrome 画不出的那一种。

## 为什么 CFF2 → glyf 要手工转
PDF.js / 浏览器渲染 CFF2 没问题，但 PDF 字体嵌入要求 glyf（TrueType）轮廓。
fontTools 没有现成的 otf2ttf 脚本（CFF2 更是可变字体专有格式），只能自己走：

  ① 可变字体先 pin 成静态实例（instancer.instantiateVariableFont(wght=400)）
     —— 不 pin 的话默认实例可能是 Thin，正文大小的发丝笔画看起来像渲染 bug；
     而且 CFF2 是 VF 专有格式，pdf-lib 根本认不了。
  ② 取字形集后丢掉 CFF2 表（此时字形数据已在内存里）。
  ③ Cu2QuPen 把 cubic 轮廓转成 quadratic（glyf 只支持二次曲线），
     灌进 TTGlyphPen 得到 glyf 字形。
  ④ 补齐 maxp / loca / head.indexToLocFormat 等表，sfnt 版本号改成
     `\x00\x01\x00\x00`（TrueType）——**不改的话读取方仍按 CFF 处理**。

## 用法
    python3 scripts/build_pdf_font.py \
        --src assets/fonts/REwordSerifSC-VF.woff2 \
        --out assets/fonts/REwordSerifSC-PDF.ttf

依赖：pip install fonttools brotli
（仓库里另有 build_builtin_fonts.py 负责生成 woff2；两者串联：
   思源原字体 → woff2（阅读器用） → TTF（PDF 用））
"""

from __future__ import annotations

import argparse
import os
import sys
import time

try:
    from fontTools.ttLib import TTFont, newTable
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.pens.cu2quPen import Cu2QuPen
except ImportError:
    sys.exit("需要 fontTools：pip install --user fonttools brotli")


def build(src: str, dst: str, weight: int = 400, max_err: float = 1.0) -> None:
    t0 = time.time()
    f = TTFont(src)

    # ① 可变字体 pin 成静态实例（必须在取字形集之前，否则 fvar 的默认实例可能不是 400）
    if "fvar" in f:
        from fontTools.varLib.instancer import instantiateVariableFont

        f = instantiateVariableFont(f, {"wght": weight}, updateFontNames=True, inplace=True)
        print(f"→ pinned wght={weight}")

    # ② 先取字形集（数据在内存里），再丢掉 CFF 表
    glyph_set = f.getGlyphSet()
    order = f.getGlyphOrder()
    for tag in ("CFF2", "CFF "):
        if tag in f:
            del f[tag]

    # ③ cubic → quadratic，灌进 glyf
    glyf_glyphs = {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        cu = Cu2QuPen(pen, max_err=max_err, reverse_direction=True)
        try:
            glyph_set[name].draw(cu)
        except Exception:
            pass  # 单个字形画不出来不该毁掉整份字体，留空字形即可
        glyf_glyphs[name] = pen.glyph()
        if (i + 1) % 3000 == 0:
            print(f"  … {i + 1}/{len(order)}", flush=True)

    glyf = newTable("glyf")
    glyf.glyphs = glyf_glyphs
    f["glyf"] = glyf
    f["loca"] = newTable("loca")

    f["maxp"].numGlyphs = len(glyf_glyphs)
    f["maxp"].tableVersion = 0x00010000
    for attr, val in (
        ("maxPoints", 0),
        ("maxContours", 0),
        ("maxCompositePoints", 0),
        ("maxCompositeContours", 0),
        ("maxZones", 2),
        ("maxTwilightPoints", 0),
        ("maxStorage", 0),
        ("maxFunctionDefs", 0),
        ("maxInstructionDefs", 0),
        ("maxStackElements", 0),
        ("maxSizeOfInstructions", 0),
        ("maxComponentElements", 0),
        ("maxComponentDepth", 0),
    ):
        setattr(f["maxp"], attr, val)
    # 复合字形（.notdef 等）转成简单轮廓：清掉 components
    for g in glyf_glyphs.values():
        g.components = []

    f["head"].indexToLocFormat = 0
    f.flavor = None
    f.save(dst)

    # ④ 兜底：fontTools 可能仍写回 woff2 flavor（"wOF2"），直接改文件头
    with open(dst, "r+b") as fh:
        head = fh.read(4)
        if head != b"\x00\x01\x00\x00":
            fh.seek(0)
            fh.write(b"\x00\x01\x00\x00")
            print("→ 文件头已改为 TrueType sfnt")

    size_mb = os.path.getsize(dst) / 1048576
    print(f"→ {dst}  {size_mb:.2f} MB  {time.time() - t0:.0f}s")

    # 自检：必须是 glyf + TrueType sfnt，不能残留 CFF
    check = TTFont(dst)
    has_glyf = "glyf" in check
    has_cff = ("CFF " in check) or ("CFF2" in check)
    with open(dst, "rb") as fh:
        tag = fh.read(4)
    print(f"→ 自检: glyf={has_glyf} CFF={has_cff} sfnt={tag!r}")
    if not has_glyf or has_cff or tag != b"\x00\x01\x00\x00":
        sys.exit("字体转换自检未过：pdf-lib 需要 glyf 轮廓 + TrueType sfnt")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="源字体（woff2 / ttf / otf）")
    ap.add_argument("--out", required=True, help="输出 TTF")
    ap.add_argument("--weight", type=int, default=400, help="可变字体 pin 的字重")
    ap.add_argument("--max-err", type=float, default=1.0, help="cu2qu 转换误差上限（字体单位）")
    args = ap.parse_args()
    build(args.src, args.out, args.weight, args.max_err)


if __name__ == "__main__":
    main()
