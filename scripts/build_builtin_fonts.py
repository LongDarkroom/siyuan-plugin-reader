#!/usr/bin/env python3
"""构建阅读器内置中文字体（2026-11-13，2026-11-14 改为可变字重）。

产物（随插件分发，见 assets/fonts/）：
    REwordSerifSC-VF.woff2        思源宋体 子集（保留 wght 轴 250–900）
    REwordSansSC-Regular.woff2    思源黑体 子集（源文件若为 VF，则输出 -VF）

## 为什么宋体保留字重轴
单字重静态字体下，CSS 只能把 100–500 全映射到 400、600–900 全交给浏览器
合成粗体（实测墨迹逐档不变），字重滑块形同虚设，书里的粗体标题也是糊的。
保留 wght 轴后 250–900 是真实连续字重；代价是体积从 2.4 MB 涨到 4.1 MB
（仍远小于 3 档静态的 7.2 MB）。

## 为什么是「子集」而不是原字体
思源宋体 VF 原文件 53 MB / 思源黑体单字重 OTF 16 MB，直接塞进插件包不可接受。
实测（本机 macOS，fontTools 4.68）：

| 形态                          | 体积   |
|-------------------------------|--------|
| VF 全量转 woff2               | 11 MB  |
| VF → 400 静态实例（OTF）      | 26 MB  |
| 400 静态子集 → woff2          | 2.4 MB |
| 500 / 700 静态子集 → woff2    | 各 2.4 MB |
| **VF 子集（保留 wght）→ woff2** | **4.1 MB** |

本脚本采用 **GB2312 全字符**（6763 汉字 + 682 符号，覆盖日常阅读 99.9%）。

## 为什么名字表要改
两款字体都是 SIL OFL 1.1，且版权行声明了**保留字体名 'Source'**
（"with Reserved Font Name 'Source'"）。OFL 规定：修改版（**子集化就是修改**）
不得继续使用保留字体名 ⇒ 这里把 name 表里的 family / full / PostScript 名
统一改成自有名 `REword Serif SC` / `REword Sans SC`，与 CSS 的 @font-face 族名一致。
**可变字体的命名实例（nameID 267–279，如 `SourceHanSerifSCVF-Bold`）也带保留名，
必须一起替换**，否则 OFL 义务没守住。
许可原文随包分发（assets/fonts/LICENSE-SourceHan*.txt），并保留 Adobe 版权声明。

## 用法
    python3 scripts/build_builtin_fonts.py \\
        --serif ~/Library/Fonts/SourceHanSerifSC-VF.otf \\
        --sans  /path/to/SourceHanSansSC-Regular.otf

    # 只重建宋体（黑体源文件不在手边时）
    python3 scripts/build_builtin_fonts.py --serif ~/Library/Fonts/SourceHanSerifSC-VF.otf

依赖：`pip install fonttools brotli`（建议用 venv）。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

try:
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover
    sys.exit("需要 fontTools：pip install --user fonttools brotli")


# ---------------------------------------------------------------- 字符集

def build_charset() -> str:
    """ASCII + 常用中西文标点 + GB2312 全字符（符号区 + 一级二级汉字）。"""
    chars: list[str] = []
    # ASCII 可打印
    chars += [chr(c) for c in range(0x20, 0x7F)]
    # 排版常用：引号、破折号、省略号、书名号、间隔号等（GB2312 已含大部分，这里补全角/半角缺口）
    chars += list(
        "“”‘’—…·、。《》〈〉「」『』【】（）？！；：,.!?;:()[]{}<>%‰°±×÷"
        "≈≠≤≥→←↑↓●○◆◇■□★☆§¶†‡•"
    )
    # GB2312：0xA1-0xA9 符号区，0xB0-0xF7 汉字区
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    # 去重且保序
    seen: set[str] = set()
    out: list[str] = []
    for ch in chars:
        if ch not in seen:
            seen.add(ch)
            out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------- 名字表

def rename_font(path: str, family: str, ps_name: str, variable: bool = False) -> None:
    """把 name 表改成自有名（去掉 OFL 保留名 'Source' / 中文「思源」）。

    可变字体多出两类记录：
      · nameID 267–279：命名实例名（`SourceHanSerifSCVF-Bold` 等）；
      · nameID 25：可变字体 PostScript 名前缀（本机源文件没有，兼容保留）。
    两类都带保留名，不能漏。版权行（nameID 0）必须原样保留做归属声明。
    """
    font = TTFont(path)
    table = font["name"]
    internal_family = f"{family} VF" if variable else family

    # 一、通用替换：所有非版权行里的保留名。覆盖命名实例/STAT 名称等
    #    现有分支没枚举到的记录，避免漏网。
    for rec in list(table.names):
        if rec.nameID == 0:
            continue
        try:
            s = str(rec)
            if "Source Han" in s or "SourceHan" in s:
                rec.string = s.replace("Source Han", "REword").replace("SourceHan", "REword")
        except Exception:
            pass

    # 二、显式覆盖关键记录，保证与 CSS 族名/PS 名一致。
    for rec in list(table.names):
        nid = rec.nameID
        if nid == 0:
            continue
        if nid in (1, 16, 18, 20, 21):
            new = internal_family
        elif nid in (2, 17, 22):
            # VF 的默认实例是 250（ExtraLight），nameID 2/17 保持源文件原值；
            # 静态字体统一标 Regular。
            if variable:
                continue
            new = "Regular"
        elif nid == 4:
            new = f"{family} VF" if variable else f"{family} Regular"
        elif nid == 3:
            new = f"{ps_name}; subset of SIL OFL font"
        elif nid == 6:
            new = ps_name
        elif nid == 25:
            new = ps_name
        else:
            continue
        # 保留原平台/编码/语言，只换字符串内容（JP/CN/KR 各语言的记录都覆盖掉）
        try:
            rec.string = new
        except Exception:
            pass
    # CFF（非 CFF2）的 PostScript 名（FontName）也要换，否则 PDF/字体管理器里露旧名
    try:
        cff = font["CFF "]
        cff.cff.fontNames = [ps_name]
    except Exception:
        pass
    font.save(path)


# ---------------------------------------------------------------- 主流程

def is_variable(src: str) -> bool:
    font = TTFont(src, lazy=True)
    v = "fvar" in font
    font.close()
    return v


def build_one(
    src: str,
    out_path: str,
    family: str,
    ps_name: str,
    charset: str,
    workdir: str,
    variable: bool,
) -> None:
    print(f"→ {os.path.basename(src)} ⇒ {os.path.basename(out_path)}")

    charfile = os.path.join(workdir, "charset.txt")
    with open(charfile, "w", encoding="utf-8") as fh:
        fh.write(charset)

    subset = os.path.join(workdir, "subset.otf")
    print(f"  · 子集化（{len(charset)} 字符{'，保留 wght 轴' if variable else ''}）…")
    subprocess.run(
        [
            sys.executable, "-m", "fontTools.subset", src,
            f"--text-file={charfile}",
            f"--output-file={subset}",
            # 竖排（vert/vrt2）与标点压缩（palt）必须保留：竖排模式与中西混排全靠它们
            "--layout-features=kern,liga,vert,vrt2,locl,palt",
            "--drop-tables+=DSIG",
            "--no-hinting",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )

    print("  · 重写名字表（OFL 保留字体名）…")
    rename_font(subset, family, ps_name, variable)

    print("  · 转 woff2 …")
    subprocess.run(
        [sys.executable, "-m", "fontTools.ttLib.woff2", "compress", subset, "-o", out_path],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    size = os.path.getsize(out_path) / 1024 / 1024
    print(f"  ✓ {os.path.basename(out_path)}  {size:.2f} MB")


def names_for(kind: str, variable: bool) -> tuple[str, str, str]:
    """(输出文件名, PostScript 名, CSS 族名)"""
    fam = "Serif" if kind == "serif" else "Sans"
    family = f"REword {fam} SC"
    if variable:
        return f"REword{fam}SC-VF.woff2", f"REword{fam}SCVF", family
    return f"REword{fam}SC-Regular.woff2", f"REword{fam}SC-Regular", family


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serif", required=True, help="思源宋体源文件（推荐 VF；静态 OTF/TTF 也可）")
    ap.add_argument("--sans", help="思源黑体源文件（省略则只重建宋体，保留现有黑体产物）")
    ap.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "fonts"),
    )
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    charset = build_charset()
    print(f"字符集：{len(charset)} 个字符")

    def workdir(tmp: str, name: str) -> str:
        path = os.path.join(tmp, name)
        os.makedirs(path, exist_ok=True)
        return path

    with tempfile.TemporaryDirectory() as tmp:
        serif_vf = is_variable(args.serif)
        out_name, ps_name, family = names_for("serif", serif_vf)
        build_one(
            args.serif,
            os.path.join(args.out, out_name),
            family=family,
            ps_name=ps_name,
            charset=charset,
            workdir=workdir(tmp, "serif"),
            variable=serif_vf,
        )
        if args.sans:
            sans_vf = is_variable(args.sans)
            out_name, ps_name, family = names_for("sans", sans_vf)
            build_one(
                args.sans,
                os.path.join(args.out, out_name),
                family=family,
                ps_name=ps_name,
                charset=charset,
                workdir=workdir(tmp, "sans"),
                variable=sans_vf,
            )
        else:
            print("（未传 --sans，黑体产物保持不变）")

    total = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out) if f.endswith(".woff2"))
    print(f"\n合计 {total / 1024 / 1024:.2f} MB → {args.out}")


if __name__ == "__main__":
    main()
