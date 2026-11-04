---
name: reader
description: 用于读取思源 RE 阅读器中正在阅读的书籍内容（一章一次）、在当前章定位原文、划线/写备注、查看已有批注的 MCP 工具。
---

# RE 阅读器技能 (reader)

RE 阅读器是思源里的独立电子书阅读器（EPUB/MOBI/AZW3/FB2/TXT/MD）。
本技能让你读取用户**当前正在读的那一章**，并可在这一章里划线、写备注。

> 本期不支持 PDF 与漫画（CBZ）：读取会返回 `unsupported_format`。

## 铁律

1. **先 `get_state`**：确认有书打开、`textCapable=true`、当前 `sectionIndex` 与 `chapterTitle`。
2. **一次只读一章**：`get_chapter` 只返回当前章（或指定 `sectionIndex`）。要总结全书，请逐章调用，不要臆造未读内容。
3. **超长续读**：结果里 `truncated=true` 时，用 `nextFromPara` 作为下一次的 `fromPara` 继续读，直到读完该章。
4. **引用必须逐字**：`quote` 只能从 `get_chapter` 返回的 `paragraphs[].text` 里复制一段连续文字（≤300 字）。不要改写、拼接或加省略号。
5. **先预演再写入**：`annotate` 默认 `dryRun=true`，只回报定位结果。把预演结果给用户确认后，才用 `dryRun=false` 落库。
6. **只写当前章**：`annotate` 只能作用于 `get_state.sectionIndex` 指向的章节；要标别的章，先请用户翻过去。
7. 单次最多 30 条批注；颜色用 `#rrggbb`，不传则沿用用户上次使用的颜色。

## Actions

### 1. `get_state`
无参数。返回当前书状态：

```json
{
  "ok": true,
  "bookId": "...",
  "title": "书名",
  "format": "epub",
  "textCapable": true,
  "sectionIndex": 3,
  "totalSections": 20,
  "chapterTitle": "第三章 ...",
  "annotationCount": 5
}
```

### 2. `get_chapter`
读取一章正文（段落数组）。

- **sectionIndex**（数字，可选）：章节序号，0 起；缺省为当前章。
- **fromPara**（数字，可选）：续读起点，填上次返回的 `nextFromPara`。
- **maxChars**（数字，可选）：字符预算，默认 12000，上限 40000。

返回 `paragraphs: [{ i, text }]`、`totalParagraphs`、`truncated`、`nextFromPara`。
`i` 是段落在本章内的序号，续读时用 `nextFromPara` 而不是自行推算。

### 3. `locate`
在当前章定位一段原文，只读不写。

- **quote**（字符串，必填）：从正文逐字复制的连续片段（≤300 字）。
- **sectionIndex**（数字，可选）：缺省为当前章。

返回首个命中的 `cfi`、`excerpt` 与最多 5 个 `candidates`。
返回 `quote_not_found` 时，换一段更长/更有辨识度的连续原文重试。

### 4. `annotate`
划线/写备注。默认只预演。

- **items**（数组，必填，≤30 条）：每项：
  - **quote**（字符串，必填）：原文片段，≤300 字。
  - **note**（字符串，可选）：备注。
  - **style**（字符串，可选）：`highlight`（荧光，默认）、`solid`（实线）、`wavy`（波浪）。
  - **color**（字符串，可选）：`#rrggbb`。
- **dryRun**（布尔值，可选）：默认 `true` 预演；用户确认后传 `false` 写入。
- **sectionIndex**（数字，可选）：必须等于当前章，否则报 `section_not_active`。

返回 `results[]`，每条含 `ok`、`quote`、`cfi`、`excerpt`；写入成功时附 `id`。
单条失败不影响其余条目，逐条检查 `ok`。

### 5. `list_annotations`
列出一本书已有的批注。

- **bookId**（字符串，可选）：缺省为当前书。
- **origin**（字符串，可选）：`manual` 人工 / `ai` AI 写入。

最多返回 200 条：`id`、`quote`、`note`、`style`、`color`、`origin`、`cfi`、`createdAt`。

## 典型流程

### 总结当前章
```json
{ "action": "get_state" }
```
```json
{ "action": "get_chapter", "maxChars": 12000 }
```
若 `truncated=true`，继续：
```json
{ "action": "get_chapter", "fromPara": 37 }
```

### 给一段原文划线并写备注（先预演）
```json
{
  "action": "annotate",
  "items": [
    {
      "quote": "这是一段从 get_chapter 结果里逐字复制的原文。",
      "note": "作者在这里提出了核心观点。",
      "style": "highlight"
    }
  ]
}
```
用户确认后：
```json
{
  "action": "annotate",
  "dryRun": false,
  "items": [
    {
      "quote": "这是一段从 get_chapter 结果里逐字复制的原文。",
      "note": "作者在这里提出了核心观点。",
      "style": "highlight"
    }
  ]
}
```

## 错误码

| 错误码 | 含义 / 处理 |
| --- | --- |
| `no_reader_open` | 没有打开的书，请用户在 RE 阅读器里打开一本 |
| `unsupported_format` | PDF/CBZ 暂不支持；仅 EPUB/MOBI/AZW3/FB2/TXT/MD |
| `no_chapter` | 章节未定位，等书加载完成 |
| `section_not_active` | 目标章节不是当前章，请用户先翻过去 |
| `quote_not_found` | 当前章找不到该原文，换更完整的一段 |
| `quote_too_long` | quote 超过 300 字，截取一段连续文字 |
| `invalid_args` | 参数缺失或格式不对 |
| `timeout` | 阅读器没响应（窗口可能不在前台） |

所有失败结果都带 `message`（中文说明），可直接转述给用户。
