# RE 阅读器（siyuan-plugin-reader）

思源笔记的**独立 EPUB / PDF 阅读器**，对标 [Readest](https://readest.com/) 阅读体验。
从 [`siyuan-plugin-reword`](https://github.com/LongDarkroom/siyuan-plugin-reword)（RE word 词汇助手）
拆出，与主插件**并行安装、互不依赖**。

## 功能

- **书架**：分组、标签、封面、状态（未读/在读/读完）、评分、收藏、进度记忆
- **阅读**：EPUB（foliate-js 原生渲染）、PDF（PDF.js 固定版式 + 文本层标注）、TXT / MD
- **划词查词**：离线 MDX 词典引擎（`.mdx` / `.csv`）+ 在线词典兜底
- **AI 译文**：多引擎翻译 + 整章预翻译 + 双语对照（参考 Readest 双语架构）
- **批注标注**：高亮 / 直线段 / 波浪线，Apple Pencil 墨迹，墨迹持久化
- **朗读 TTS**：system / 有道 / Edge / 讯飞多引擎，连续朗读 + 句子高亮
- **阅读统计**：时长累计、连续天数、热力图、Top 书
- **PDF 能力**：大纲 / 页码跳转、缩放、矩形框选标注

## 安装

1. 把本目录放到思源工作空间 `data/plugins/siyuan-plugin-reader/`
2. `npm install && npm run build`（或直接用发版包）
3. 在思源「设置 → 数据与文件 → 第三方插件」中启用

### 词典导入（重要）

**本插件不含词典实包**（约 77 MB，需自行获取）：

- 方式一：插件内「设置 → 词典 → 导入词典包」，选择 `.mdx` / `.csv` 文件
- 方式二：手动把词典文件放入插件的 `dict/` 目录，重启思源

未导入词典时，划词查词会走在线词典。

### 与 RE word 主插件的关系

本插件已从主插件**完全独立**：批注与翻译缓存均落在本插件自身的存储目录
（`hiword-annotations.json` 等，走 `loadData/saveData`），不依赖主插件，跨插件桥
`src/bridge/client.ts` 已删除。

- **批注**：本插件本地持久化。首次启动时若本插件批注库为空、而主插件
  `siyuan-plugin-reword` 残存 `hiword-annotations.json`，会一次性迁移过来（仅一次）。
- **词典 / 查词**：词典实包与清单均在本插件 `dict/` 与 petal 目录，完全独立。
- 仍会调用主插件的功能（仅降级提示、不影响主体）：词典卡「加入词库」☆/★、划词
  「AI 精读」、词典弹窗「侧边栏查词」—— 这三项需主插件提供面板支撑，未安装时给出
  可见提示而非白屏。

## 开发

```bash
npm install
npm run build     # vite build + copy-dist
npm test          # 行为测试（5 个文件）
npm run verify    # tsc --noEmit + svelte-check
```

### 目录结构

```
src/
├── index.ts              插件入口（addTab / addTopBar / addCommand 同步注册）
├── reader/               阅读器主体（303 文件，含 vendor/foliate-js 13 MB）
│   ├── ReaderView.svelte    主阅读视图（12k 行，PDF/EPUB 双模式）
│   ├── BookshelfView.svelte 书架
│   ├── reader-dock.ts      书架+设置+字体+页签的控制器
│   ├── reader-settings.ts  阅读设置（主题/字体/边距/排版）
│   ├── reader-style.ts     样式生成器
│   └── vendor/foliate-js   EPUB 渲染内核（第三方）
├── dict/                 查词引擎 + DictManager（导入接口）
├── translate/            翻译引擎（6 个 provider + 缓存 + 术语表）
├── ai/                   AI 译文（ai-settings + ai-client + 设置面板）
├── annotation/           批注（本地类型/常量 + 本地持久化 store）
├── core/ i18n/ siyuan/ ui/ utils/ license/   基础模块
└── index.less            全局样式（令牌 + reader-ui + 词典/批注区块）
```

## 与主插件的差异（切分适配）

| 方面 | 主插件 | 本插件 |
|---|---|---|
| 挂载 | dock 组合栏的一个 feature | 独立主区页签 + 顶栏图标 + 命令 |
| 批注 | 数据持有方，store 走 `loadData/saveData` | 同样本地持久化，已从主插件独立（首启自动迁移老数据） |
| 词典 | 词典面板 + 词库联动 | 仅阅读器划词查词 + 自带导入入口 |
| AI | AI 精读对话（`ai-panel` 4.6k 行等） | 仅 AI 译文（`ai-settings` + `ai-client`） |

## 许可

MIT（沿用主插件）
