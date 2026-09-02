# Agent Note: Official Frappe documentation knowledge base

Status: implemented

English | [中文](2026-09-02-frappe-docs-knowledge-base.zh.md)

## Problem

Harness can inspect the active Native Bench source and permitted Frappe data, but official framework and product guidance still depends on live web search. That path is not deterministic, does not preserve a synchronized version inventory, and can mix current public documentation with the deployed application's runtime behavior. Copying the complete documentation site into the system prompt would create an unbounded, unstable model prefix.

## Decision

The `@deepseek-ai/dsh-tool-frappe-docs` package reads a deployment-owned local knowledge base. A separate operator command synchronizes the official `docs.frappe.io` sitemap into SQLite. It prefers each text page's Markdown alternate and falls back to same-origin HTML `<article>` or `<main>` text when that alternate is unavailable; navigation, scripts, styles, headers, and footers are excluded. The index stores title, product route, version route, language, update date, canonical source URL, page content, and heading-bounded chunks. FTS5 BM25 search supports optional product, version, and language filters. Failed refreshes retain an earlier good page, and incremental synchronization skips unchanged sitemap dates.

The model receives three read-only operations: bounded search, bounded page or heading retrieval, and index status. No tool can trigger synchronization, choose the knowledge-base path, crawl another origin, or write the index. Search and page results preserve official source URLs and version metadata. The generic tool card renders the structured result without a package-specific Client contribution.

The prompt contribution establishes an evidence order. Deployed behavior and business calculations use `/home/zyd/frappe/native-bench/apps` first, then current Frappe metadata and permitted records. Official documentation explains framework and product rules after those sources, and an answer must identify version differences rather than treating current public documentation as runtime truth.

The `@deepseek-ai/dsh-ione-frappe-docs` Bundle carries a disabled patch row. A deployment enables it only after synchronizing an index and supplies the absolute knowledge-base path. The index is not a Frappe database and does not create or modify a DocType.

## Consequences

- Frappe, ERPNext, Education, HR, CRM, Desk, Bench, API, and other official product questions can use one locally searchable corpus with original links and update metadata.
- Model context stays bounded because pages enter a request only through explicit search and page tools.
- Chinese questions should include or derive English Frappe terminology in the first version because retrieval is lexical. A later multilingual embedding provider can complement FTS5 without changing the tool schemas.
- A scheduled operator process can refresh the corpus without restarting Harness; later tool calls read the updated SQLite index.
- Runtime source and site evidence remain authoritative for the deployed system, so the knowledge base cannot justify a data or schema mutation.

## Alternatives considered

- **Copy the site into the system prompt** — rejected because the corpus is too large and would invalidate the stable prompt prefix on every update.
- **Use live web search for every documentation question** — rejected because availability, ranking, version inventory, and citations vary per request.
- **Let the model synchronize the index** — rejected because crawling is an operator lifecycle with network load and persistent writes, not a model-facing read capability.
- **Store the corpus in a Frappe DocType** — rejected because documentation retrieval does not need application schema changes and the Native Bench policy forbids adding or modifying DocTypes.
