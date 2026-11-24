# 大模型网页翻译（LLM Webpage Translator）

一个基于大模型 API 的 Chrome 扩展（Manifest V3），支持**整页翻译、划词翻译、悬浮输入框翻译**，兼容 **OpenAI** 与 **Anthropic（Messages）** 两种协议。目标语言可配置，默认**简体中文**。

## 功能特性

### 整页翻译
- 在原位替换页面文字，**一键还原原文**（保留页面原有 DOM 结构与样式）。
- **视口懒加载**：滚动到哪翻到哪，长页面也能快速看到首屏结果。
- **保留行内格式**：链接、加粗、图片等在翻译后仍然有效，链接可正常点击（通过 `<tpN>` 占位标记在本地隐藏、翻译后按编号拼回原节点）。
- **串行批量请求** + 结果缓存，稳定优先，避免触发限流。
- 对不支持标记的异常返回会自动重试、必要时降级为纯文本，保证不破坏页面。

### 划词翻译
- 选中文本后出现一个小「译」按钮，**点击才翻译**（主动触发，不打扰阅读）。
- 结果卡片展示原文与译文，支持复制。

### 悬浮输入框翻译
- 右下角悬浮按钮打开面板，输入/粘贴文字即可翻译（`Ctrl+Enter` 触发）。

## 支持的协议

| 协议 | 端点 | 认证 |
| --- | --- | --- |
| OpenAI 兼容 | `POST {baseURL}/chat/completions` | `Authorization: Bearer <apiKey>` |
| Anthropic | `POST {baseURL}/v1/messages` | `x-api-key` + `anthropic-version` |

`baseURL` 会自动归一化：可填到 `.../v1`，也可直接填到 `.../chat/completions` 或 `.../messages` 都会被正确处理。

## 安装（开发者模式加载）

1. 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目目录

## 配置

打开扩展的选项页（扩展详情 → 扩展程序选项），填写：

- **协议**：OpenAI 兼容 / Anthropic
- **Base URL**：例如 `https://api.openai.com/v1`、`https://your-proxy/v1`、`http://localhost:8790`
- **API Key**
- **模型**：例如 `gpt-4o-mini`、`claude-3-5-sonnet-...`
- **目标语言**：默认 `简体中文`
- 可用「测试连接」验证配置

## 使用

- **整页翻译 / 还原**：快捷键 `Alt+Shift+T`，或点击右下角面板里的「整页翻译 / 还原原文」。
- **划词翻译**：选中文本 → 点击旁边的小「译」按钮。
- **悬浮框翻译**：点击右下角悬浮按钮，输入文本后 `Ctrl+Enter`。

## 本地开发 / Mock 服务

无需真实 API，可用内置 mock 联调（模拟 OpenAI 兼容与 Anthropic 两种端点）：

```bash
node scripts/mock-llm.js [port] [mode]
```

- `port` 默认 `8790`
- `mode` 默认 `ok`，可选：

| mode | 用途 |
| --- | --- |
| `ok` | 正常返回（保留 `<tpN>` 标记，译文带 `[mock]` 前缀） |
| `dropmarkers` | 故意丢弃标记，验证校验/重试/回退 |
| `misalign` | 编号错位，验证对齐处理 |
| `missing` | 缺最后一段，验证缺失重试 |
| `slow` | 延迟 5 秒返回，验证超时与懒加载 |
| `nonjson` | 返回非 JSON，验证 `BAD_RESPONSE` |

把设置页的 Base URL 填成 `http://localhost:8790` 即可；也可用 URL 前缀临时切换模式，例如 `http://localhost:8790/slow`。

## 目录结构

```
manifest.json          # MV3 扩展清单
background.js          # Service Worker：调用大模型、协议适配、缓存、错误处理
content/ui.js          # 页面内 UI（Shadow DOM 隔离）：悬浮按钮/面板/划词卡片
content/content.js     # 内容脚本：候选块收集、序列化、懒加载、批量、重建/还原
options/               # 选项页（HTML/CSS/JS）
scripts/mock-llm.js    # 本地 mock 服务（开发用）
```

## 工作原理（简述）

1. **采集**：递归扫描页面，取「块级叶子」作为翻译候选；夹在块之间的裸文本用 `<span>` 临时包裹；跳过脚本/代码/输入框、隐藏元素、以及与目标语言相同的文本。
2. **序列化**：把行内元素替换成 `<tpN>…</tpN>` 占位标记，只在本地保留其 DOM 节点；超长块在句子边界切分。
3. **调用**：把带编号 `[[i]]` 的文本批量发给大模型，要求返回 JSON `{"t":[{"i":1,"t":"译文"}]}`，`i` 与输入一一对应、`<tpN>` 原样保留。
4. **回填**：按编号把译文拼回，并复用原始行内节点重建，链接/事件监听不丢失；打上 `data-tp-translated` 标记。
5. **还原**：通过事先保存的 DOM 快照把每个元素恢复原状。

## 隐私说明

- API Key 仅保存在浏览器本地 `chrome.storage.local`，**不会上传到本扩展以外的任何地方**。
- 待翻译的**文本内容会发送到你配置的模型 API**，请据此选择合适的服务与网络环境。
- 扩展不收集、不上报任何使用数据。

## 已知限制

- 仅处理扩展注入时刻已存在的静态 DOM；页面后续动态新增的内容、或写在元素属性（如 `placeholder`/`title`/`alt`）里的文本不在翻译范围内。
- 为保证稳定性，请求采用串行方式（同一时刻一个请求）。
