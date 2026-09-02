---
description: "Read-only Harness retrieval over a locally synchronized copy of the official Frappe documentation site."
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-frappe-docs`

English | [中文](README.zh.md)

## Summary

This package exposes bounded search, page-read, and index-status tools over official `docs.frappe.io` content. A deployment synchronizes the official sitemap and Markdown alternates into a local SQLite FTS5 index. Model calls never crawl the network, trigger synchronization, choose a host path, or write the index.

The package complements, rather than replaces, runtime evidence. Questions about the deployed site use the active Native Bench source and Frappe metadata first. The documentation index explains official framework and product behavior, and every result retains its official URL, product route, version route, language, and update date.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>

## Configuration

```yaml
- id: frappe-docs
  name: '@deepseek-ai/dsh-tool-frappe-docs'
  config:
    knowledgeRoot: /home/zyd/frappe/frappe-docs-kb
    pythonExecutable: /usr/bin/python3
    timeoutMs: 30000
```

The deployment synchronizes the corpus separately from Harness:

```sh
python3 packages/extensions/tool-frappe-docs/python/frappe_docs_kb.py \
  --knowledge-root /home/zyd/frappe/frappe-docs-kb \
  --operation sync \
  --workers 6 \
  --request-delay-ms 100
```

Synchronization reads only the official `https://docs.frappe.io/sitemap.xml` origin and each page's `.md` alternate. It records failed pages without deleting an earlier good copy, skips unchanged sitemap dates on later runs, splits Markdown by heading, and preserves source attribution. The local database is not a Frappe database and synchronization does not create or alter a DocType.

`frappe_docs_search` performs BM25 full-text retrieval with optional product, version, and language filters. `frappe_docs_get_page` reads one indexed page or heading with a caller-selected bound. `frappe_docs_status` reports corpus coverage and synchronization freshness. The generic Harness tool card is intentional because each result is already structured JSON with source links.

<a id="model-experience"></a>
## Model Experience

### Official Frappe documentation tools

#### What the model sees

The package contributes a fixed evidence-priority section and the three schemas in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-frappe-docs). Search and page results include official URLs and version metadata; no filesystem path or synchronization operation is model-selectable.

#### Token effect

The routing section is small and fixed. Search results are capped at 20 sections, and page reads are capped at 50,000 characters by schema and helper validation.

#### KV Cache effect

Mounting or unmounting the package changes the system-prompt and tool prefix. Synchronizing content does not change the prompt or schemas; only later tool results reflect the new index.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Lexical retrieval** — the first production index uses FTS5 BM25 plus product, version, and language filtering. The calling model should include English Frappe terms for Chinese questions. A multilingual embedding provider can be added later without changing the three tool schemas.
- **Documentation is not runtime truth** — current official pages can differ from the installed Native Bench versions. Answers about deployed behavior must prefer active source, site metadata, and permitted data reads.
- **Text pages only** — sitemap entries for PDF, office, image, archive, audio, and video files are excluded from the text index.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The crawler, index, retrieval, and evidence-priority decisions are recorded in the [Frappe documentation knowledge-base Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.md).

</details>
