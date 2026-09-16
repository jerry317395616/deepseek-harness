---
description: "在 Harness 中只读检索本地同步的 Frappe 官方文档。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-frappe-docs`

[English](README.md) | 中文

## 概述

检索并阅读本地同步的 Frappe 官方文档索引。部署方负责同步，优先读取 Markdown，不可用时读取同源 HTML 正文。模型调用不能爬取、同步、选择服务器路径或写入索引。结果保留官方网址、产品、版本、语言及更新日期。应结合当前 Native Bench 源码和站点元数据使用，不能用文档代替已部署系统的实际证据。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待处理工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>

## 配置

```yaml
- id: frappe-docs
  name: '@deepseek-ai/dsh-tool-frappe-docs'
  config:
    knowledgeRoot: /home/zyd/frappe/frappe-docs-kb
    pythonExecutable: /usr/bin/python3
    timeoutMs: 30000
```

部署程序在 Harness 之外单独同步文档库：

```sh
python3 packages/extensions/tool-frappe-docs/python/frappe_docs_kb.py \
  --knowledge-root /home/zyd/frappe/frappe-docs-kb \
  --operation sync \
  --workers 6 \
  --request-delay-ms 100
```

同步程序只读取官方 `https://docs.frappe.io/sitemap.xml` 来源和官方页面路径。它优先读取每个页面的 `.md` 版本；该版本不可用时，读取同一路径中的 `<article>` 或 `<main>` 正文，不索引导航、脚本、样式、页眉或页脚。同步失败会保留旧的可用页面；后续运行会按站点地图日期跳过未变化页面，并按标题切分内容、保留来源信息。本地数据库不是 Frappe 数据库，同步过程不会新增或修改 DocType。

`frappe_docs_search` 使用 BM25 全文检索，并支持产品、版本和语言筛选。`frappe_docs_get_page` 在指定上限内读取一个已索引页面或章节。`frappe_docs_status` 返回文档覆盖范围和最近同步状态。工具使用 Harness 通用卡片，因为返回值已经是包含来源链接的结构化 JSON。

<a id="model-experience"></a>
## 模型体验

### Frappe 官方文档工具

#### 模型看到的内容

本包提供固定的证据优先级提示区段，以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-frappe-docs)中的三个工具结构。搜索和页面结果包含官方链接与版本元数据；模型不能选择文件系统路径或同步操作。

#### Token 影响

路由提示较小且固定。搜索结果最多包含 20 个章节；页面读取在工具结构和辅助程序两层限制为最多 50,000 个字符。

#### KV 缓存影响

启用或停用本包会改变系统提示和工具前缀。同步文档内容不会改变提示或工具结构，只有后续工具结果会反映新索引。

## 已知限制与待处理工作
<a id="known-limitations-and-deferred-work"></a>

- **词法检索**——首个生产索引使用 FTS5 BM25，并结合产品、版本和语言筛选。中文问题应由调用模型补充对应英文 Frappe 技术词。以后可以增加多语言向量提供方，而无需修改三个工具结构。
- **文档不是运行事实**——当前官方页面可能与 Native Bench 已安装版本不同。回答部署行为时必须优先使用当前源码、站点元数据和获准的数据读取。
- **仅索引文本页面**——站点地图中的 PDF、Office、图片、压缩包、音频和视频文件不会进入文本索引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

抓取、索引、检索与证据优先级决策记录在 [Frappe 文档知识库 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.zh.md) 中。

</details>
