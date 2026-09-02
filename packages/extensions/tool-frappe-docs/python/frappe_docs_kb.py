#!/usr/bin/env python3
"""Synchronize and query a local index of official docs.frappe.io Markdown pages."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


OFFICIAL_ORIGIN = "https://docs.frappe.io"
DEFAULT_SITEMAP = f"{OFFICIAL_ORIGIN}/sitemap.xml"
DATABASE_NAME = "frappe-docs.sqlite3"
USER_AGENT = "IONE-Harness-FrappeDocsIndexer/1.0 (+https://child.myyr.top)"
MAX_PAGE_BYTES = 2_000_000
MAX_CHUNK_CHARACTERS = 6_000
MAX_QUERY_TOKENS = 24
SYNC_SCHEMA_VERSION = "1"
SKIPPED_SUFFIXES = {
    ".7z", ".avi", ".csv", ".doc", ".docx", ".gif", ".gz", ".jpeg", ".jpg",
    ".mov", ".mp3", ".mp4", ".ods", ".odt", ".pdf", ".png", ".ppt", ".pptx",
    ".svg", ".tar", ".webm", ".webp", ".xls", ".xlsx", ".xml", ".zip",
}
LANGUAGE_SEGMENTS = {
    "ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pl",
    "pt", "ru", "th", "tr", "uk", "vi", "zh",
}


class KnowledgeBaseError(RuntimeError):
    """A bounded, user-safe documentation index failure."""


@dataclass(frozen=True)
class SitemapEntry:
    """One official documentation URL and its sitemap modification date."""

    url: str
    lastmod: str


@dataclass(frozen=True)
class FetchedPage:
    """One downloaded Markdown page ready for indexing."""

    entry: SitemapEntry
    markdown_url: str
    title: str
    space: str
    product: str
    version: str
    language: str
    updated: str
    content: str
    content_sha256: str


class RateLimiter:
    """Global request pacing shared by synchronization workers."""

    def __init__(self, delay_seconds: float) -> None:
        self.delay_seconds = max(0.0, delay_seconds)
        self._lock = threading.Lock()
        self._next_request = 0.0

    def wait(self) -> None:
        """Block until the next globally permitted request time."""
        with self._lock:
            now = time.monotonic()
            remaining = self._next_request - now
            if remaining > 0:
                time.sleep(remaining)
            self._next_request = time.monotonic() + self.delay_seconds


def utc_now() -> str:
    """Return a stable UTC timestamp for persisted synchronization metadata."""
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def connect_database(root: Path, *, create: bool) -> sqlite3.Connection:
    """Open the bounded knowledge-base database and initialize it when requested."""
    database = root / DATABASE_NAME
    if not create and not database.is_file():
        raise KnowledgeBaseError(f"documentation index is missing: {database}")
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    if create:
        initialize_schema(connection)
    return connection


def initialize_schema(connection: sqlite3.Connection) -> None:
    """Create the local documentation schema without touching a Frappe database."""
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            markdown_url TEXT NOT NULL,
            title TEXT NOT NULL,
            space TEXT NOT NULL,
            product TEXT NOT NULL,
            version TEXT NOT NULL,
            language TEXT NOT NULL,
            updated TEXT NOT NULL,
            sitemap_lastmod TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            content TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS pages_product_version ON pages(product, version, language, active);
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            heading TEXT NOT NULL,
            content TEXT NOT NULL,
            UNIQUE(page_id, ordinal)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            title,
            space,
            product,
            version,
            language,
            heading,
            content,
            url UNINDEXED,
            page_id UNINDEXED,
            chunk_id UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS sync_failures (
            url TEXT PRIMARY KEY,
            error TEXT NOT NULL,
            failed_at TEXT NOT NULL
        );
        """
    )
    set_metadata(connection, "schema_version", SYNC_SCHEMA_VERSION)
    connection.commit()


def set_metadata(connection: sqlite3.Connection, key: str, value: str) -> None:
    """Persist one synchronization metadata value."""
    connection.execute(
        "INSERT INTO metadata(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def get_metadata(connection: sqlite3.Connection) -> dict[str, str]:
    """Return every synchronization metadata value."""
    return {str(row["key"]): str(row["value"]) for row in connection.execute("SELECT key, value FROM metadata")}


def official_url(value: str) -> str:
    """Normalize and enforce the official documentation origin."""
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or parsed.netloc != "docs.frappe.io":
        raise KnowledgeBaseError("only https://docs.frappe.io pages may be indexed")
    if parsed.username is not None or parsed.password is not None or parsed.port is not None:
        raise KnowledgeBaseError("documentation URL contains unsupported authority fields")
    path = re.sub(r"/{2,}", "/", parsed.path or "/").rstrip("/") or "/"
    return urllib.parse.urlunsplit(("https", "docs.frappe.io", path, "", ""))


def fetch_bytes(url: str, *, timeout: float, max_bytes: int, limiter: RateLimiter | None = None) -> bytes:
    """Fetch one bounded official resource with deployment-owned request headers."""
    normalized = official_url(url)
    if limiter is not None:
        limiter.wait()
    request = urllib.request.Request(normalized, headers={"User-Agent": USER_AGENT, "Accept": "text/markdown, application/xml;q=0.9"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length is not None and int(content_length) > max_bytes:
            raise KnowledgeBaseError("documentation response exceeds its byte limit")
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise KnowledgeBaseError("documentation response exceeds its byte limit")
    return data


def read_sitemap(url: str, *, timeout: float) -> list[SitemapEntry]:
    """Download and validate the official sitemap URL set."""
    data = fetch_bytes(url, timeout=timeout, max_bytes=5_000_000)
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise KnowledgeBaseError("official sitemap is not valid XML") from error
    namespace = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    entries: list[SitemapEntry] = []
    seen: set[str] = set()
    for node in root.findall("s:url", namespace):
        location = node.findtext("s:loc", default="", namespaces=namespace).strip()
        if not location:
            continue
        normalized = official_url(location)
        suffix = Path(urllib.parse.unquote(urllib.parse.urlsplit(normalized).path)).suffix.lower()
        if suffix in SKIPPED_SUFFIXES or normalized in seen:
            continue
        seen.add(normalized)
        lastmod = node.findtext("s:lastmod", default="", namespaces=namespace).strip()
        entries.append(SitemapEntry(normalized, lastmod[:40]))
    if not entries:
        raise KnowledgeBaseError("official sitemap did not contain indexable pages")
    return entries


def parse_frontmatter(markdown: str) -> tuple[dict[str, str], str]:
    """Parse the simple scalar frontmatter emitted by docs.frappe.io Markdown pages."""
    if not markdown.startswith("---\n"):
        return {}, markdown.strip()
    end = markdown.find("\n---\n", 4)
    if end == -1:
        return {}, markdown.strip()
    metadata: dict[str, str] = {}
    for line in markdown[4:end].splitlines():
        key, separator, raw_value = line.partition(":")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", key.strip()):
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        metadata[key.strip().lower()] = value[:2_000]
    return metadata, markdown[end + 5 :].strip()


def infer_route_metadata(url: str) -> tuple[str, str, str]:
    """Infer product, version and language from a canonical documentation route."""
    segments = [urllib.parse.unquote(segment) for segment in urllib.parse.urlsplit(url).path.split("/") if segment]
    product = segments[0].lower() if segments else "root"
    version = next((segment.lower() for segment in segments if re.fullmatch(r"v\d+(?:\.\d+)?", segment, re.IGNORECASE)), "")
    language = next((segment.lower() for segment in segments if segment.lower() in LANGUAGE_SEGMENTS), "")
    return product[:80], version[:40], language[:20]


def fetch_page(entry: SitemapEntry, *, timeout: float, limiter: RateLimiter) -> FetchedPage:
    """Fetch one Markdown alternate and derive its searchable metadata."""
    markdown_url = f"{entry.url}.md"
    data = fetch_bytes(markdown_url, timeout=timeout, max_bytes=MAX_PAGE_BYTES, limiter=limiter)
    try:
        markdown = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise KnowledgeBaseError("documentation Markdown is not UTF-8") from error
    metadata, content = parse_frontmatter(markdown.replace("\r\n", "\n"))
    if len(content) < 20:
        raise KnowledgeBaseError("documentation Markdown has no useful content")
    product, version, language = infer_route_metadata(entry.url)
    title = metadata.get("title", "").strip() or route_title(entry.url)
    space = metadata.get("space", "").strip() or product
    return FetchedPage(
        entry=entry,
        markdown_url=markdown_url,
        title=title[:500],
        space=space[:200],
        product=product,
        version=version,
        language=language,
        updated=metadata.get("updated", "")[:40],
        content=content,
        content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
    )


def route_title(url: str) -> str:
    """Produce a readable fallback title from the final route segment."""
    path = urllib.parse.unquote(urllib.parse.urlsplit(url).path).rstrip("/")
    final = path.rsplit("/", 1)[-1] or "Frappe Documentation"
    return re.sub(r"[-_]+", " ", final).strip().title()


def split_chunks(title: str, content: str) -> list[tuple[str, str]]:
    """Split Markdown by headings and bounded paragraph groups while preserving code blocks."""
    sections: list[tuple[str, list[str]]] = []
    heading = title
    lines: list[str] = []
    in_fence = False
    for line in content.splitlines():
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_fence = not in_fence
        match = None if in_fence else re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if match is not None:
            if any(value.strip() for value in lines):
                sections.append((heading, lines))
            heading = re.sub(r"\s+#+$", "", match.group(1)).strip()[:500] or title
            lines = [line]
        else:
            lines.append(line)
    if any(value.strip() for value in lines):
        sections.append((heading, lines))

    chunks: list[tuple[str, str]] = []
    for section_heading, section_lines in sections:
        section = "\n".join(section_lines).strip()
        if len(section) <= MAX_CHUNK_CHARACTERS:
            chunks.append((section_heading, section))
            continue
        paragraphs = re.split(r"\n{2,}", section)
        current: list[str] = []
        size = 0
        for paragraph in paragraphs:
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if current and size + len(paragraph) + 2 > MAX_CHUNK_CHARACTERS:
                chunks.append((section_heading, "\n\n".join(current)))
                current = []
                size = 0
            if len(paragraph) <= MAX_CHUNK_CHARACTERS:
                current.append(paragraph)
                size += len(paragraph) + 2
            else:
                for start in range(0, len(paragraph), MAX_CHUNK_CHARACTERS):
                    part = paragraph[start : start + MAX_CHUNK_CHARACTERS]
                    if current:
                        chunks.append((section_heading, "\n\n".join(current)))
                        current = []
                        size = 0
                    chunks.append((section_heading, part))
        if current:
            chunks.append((section_heading, "\n\n".join(current)))
    return [(heading_value, body) for heading_value, body in chunks if body.strip()]


def existing_lastmods(connection: sqlite3.Connection) -> dict[str, str]:
    """Return active sitemap dates keyed by official URL."""
    return {
        str(row["url"]): str(row["sitemap_lastmod"])
        for row in connection.execute("SELECT url, sitemap_lastmod FROM pages WHERE active = 1")
    }


def upsert_page(connection: sqlite3.Connection, page: FetchedPage, fetched_at: str) -> bool:
    """Replace one changed page and its search rows; return whether content changed."""
    row = connection.execute("SELECT id, content_sha256 FROM pages WHERE url = ?", (page.entry.url,)).fetchone()
    changed = row is None or str(row["content_sha256"]) != page.content_sha256
    connection.execute(
        """
        INSERT INTO pages(
            url, markdown_url, title, space, product, version, language, updated,
            sitemap_lastmod, content_sha256, content, fetched_at, active
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(url) DO UPDATE SET
            markdown_url = excluded.markdown_url,
            title = excluded.title,
            space = excluded.space,
            product = excluded.product,
            version = excluded.version,
            language = excluded.language,
            updated = excluded.updated,
            sitemap_lastmod = excluded.sitemap_lastmod,
            content_sha256 = excluded.content_sha256,
            content = excluded.content,
            fetched_at = excluded.fetched_at,
            active = 1
        """,
        (
            page.entry.url, page.markdown_url, page.title, page.space, page.product,
            page.version, page.language, page.updated, page.entry.lastmod,
            page.content_sha256, page.content, fetched_at,
        ),
    )
    page_id = int(connection.execute("SELECT id FROM pages WHERE url = ?", (page.entry.url,)).fetchone()["id"])
    if changed:
        chunk_ids = [int(value["id"]) for value in connection.execute("SELECT id FROM chunks WHERE page_id = ?", (page_id,))]
        for chunk_id in chunk_ids:
            connection.execute("DELETE FROM chunks_fts WHERE chunk_id = ?", (str(chunk_id),))
        connection.execute("DELETE FROM chunks WHERE page_id = ?", (page_id,))
        for ordinal, (heading, content) in enumerate(split_chunks(page.title, page.content)):
            cursor = connection.execute(
                "INSERT INTO chunks(page_id, ordinal, heading, content) VALUES(?, ?, ?, ?)",
                (page_id, ordinal, heading, content),
            )
            chunk_id = int(cursor.lastrowid)
            connection.execute(
                "INSERT INTO chunks_fts(title, space, product, version, language, heading, content, url, page_id, chunk_id) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    page.title, page.space, page.product, page.version, page.language,
                    heading, content, page.entry.url, str(page_id), str(chunk_id),
                ),
            )
    connection.execute("DELETE FROM sync_failures WHERE url = ?", (page.entry.url,))
    return changed


def record_failure(connection: sqlite3.Connection, url: str, error: BaseException, failed_at: str) -> None:
    """Persist one bounded fetch failure without deleting a previous good page."""
    message = re.sub(r"[\r\n]+", " ", str(error))[:500]
    connection.execute(
        "INSERT INTO sync_failures(url, error, failed_at) VALUES(?, ?, ?) "
        "ON CONFLICT(url) DO UPDATE SET error = excluded.error, failed_at = excluded.failed_at",
        (url, message, failed_at),
    )


def synchronize(
    root: Path,
    *,
    sitemap_url: str,
    workers: int,
    request_delay_ms: int,
    timeout: float,
    full: bool,
) -> dict[str, Any]:
    """Synchronize official Markdown pages into the local search index."""
    started_at = utc_now()
    entries = read_sitemap(sitemap_url, timeout=timeout)
    connection = connect_database(root, create=True)
    try:
        known = existing_lastmods(connection)
        targets = entries if full else [entry for entry in entries if known.get(entry.url) != entry.lastmod]
        active_urls = {entry.url for entry in entries}
        connection.execute("UPDATE pages SET active = 0")
        connection.executemany("UPDATE pages SET active = 1 WHERE url = ?", ((url,) for url in active_urls))
        set_metadata(connection, "sync_started_at", started_at)
        set_metadata(connection, "sitemap_url", official_url(sitemap_url))
        set_metadata(connection, "sitemap_page_count", str(len(entries)))
        connection.commit()

        limiter = RateLimiter(request_delay_ms / 1_000)
        changed = 0
        succeeded = 0
        failed = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(fetch_page, entry, timeout=timeout, limiter=limiter): entry
                for entry in targets
            }
            for completed, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                entry = futures[future]
                timestamp = utc_now()
                try:
                    page = future.result()
                    changed += int(upsert_page(connection, page, timestamp))
                    succeeded += 1
                except (KnowledgeBaseError, OSError, urllib.error.URLError, ValueError) as error:
                    record_failure(connection, entry.url, error, timestamp)
                    failed += 1
                if completed % 50 == 0:
                    connection.commit()
                if completed % 100 == 0 or completed == len(targets):
                    print(
                        f"frappe-docs sync: {completed}/{len(targets)} fetched, "
                        f"{succeeded} succeeded, {failed} failed",
                        file=sys.stderr,
                        flush=True,
                    )
        finished_at = utc_now()
        set_metadata(connection, "last_sync_finished_at", finished_at)
        set_metadata(connection, "last_sync_succeeded", str(succeeded))
        set_metadata(connection, "last_sync_failed", str(failed))
        set_metadata(connection, "last_sync_changed", str(changed))
        connection.commit()
        counts = index_counts(connection)
        return {
            "started_at": started_at,
            "finished_at": finished_at,
            "sitemap_pages": len(entries),
            "requested": len(targets),
            "skipped_unchanged": len(entries) - len(targets),
            "succeeded": succeeded,
            "failed": failed,
            "changed": changed,
            **counts,
        }
    finally:
        connection.close()


def search_terms(query: str) -> list[str]:
    """Build a safe FTS query vocabulary from user text."""
    values = re.findall(r"[\w]+", query, flags=re.UNICODE)
    terms: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.casefold().strip("_")
        if len(normalized) < 2 or normalized in seen:
            continue
        seen.add(normalized)
        terms.append(normalized)
        if len(terms) >= MAX_QUERY_TOKENS:
            break
    if not terms:
        raise KnowledgeBaseError("search query has no indexable terms")
    return terms


def fts_expression(terms: Iterable[str]) -> str:
    """Quote normalized tokens so model input cannot introduce FTS operators."""
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)


def search(connection: sqlite3.Connection, arguments: dict[str, Any]) -> dict[str, Any]:
    """Search active documentation chunks with BM25 and metadata filters."""
    query = require_string(arguments, "query", 500)
    terms = search_terms(query)
    limit = require_integer(arguments, "limit", default=8, minimum=1, maximum=20)
    product = optional_string(arguments, "product", 80).casefold()
    version = optional_string(arguments, "version", 80).casefold()
    language = optional_string(arguments, "language", 80).casefold()
    conditions = ["chunks_fts MATCH ?", "pages.active = 1"]
    parameters: list[Any] = [fts_expression(terms)]
    for column, value in (("pages.product", product), ("pages.version", version), ("pages.language", language)):
        if value:
            conditions.append(f"{column} = ?")
            parameters.append(value)
    parameters.append(limit)
    rows = connection.execute(
        f"""
        SELECT
            pages.title,
            pages.url,
            pages.space,
            pages.product,
            pages.version,
            pages.language,
            pages.updated,
            pages.sitemap_lastmod,
            chunks.heading,
            snippet(chunks_fts, 6, '【', '】', ' … ', 36) AS excerpt,
            bm25(chunks_fts, 5.0, 2.5, 2.5, 1.5, 1.0, 3.0, 1.0) AS rank
        FROM chunks_fts
        JOIN pages ON pages.id = CAST(chunks_fts.page_id AS INTEGER)
        JOIN chunks ON chunks.id = CAST(chunks_fts.chunk_id AS INTEGER)
        WHERE {' AND '.join(conditions)}
        ORDER BY rank ASC, pages.updated DESC, pages.url ASC
        LIMIT ?
        """,
        parameters,
    ).fetchall()
    results = []
    for row in rows:
        results.append({
            "title": row["title"],
            "heading": row["heading"],
            "product": row["product"],
            "space": row["space"],
            "version": row["version"] or None,
            "language": row["language"] or None,
            "updated": row["updated"] or row["sitemap_lastmod"] or None,
            "url": row["url"],
            "excerpt": row["excerpt"],
            "relevance": round(-float(row["rank"]), 6),
        })
    metadata = get_metadata(connection)
    return {
        "query": query,
        "terms": terms,
        "filters": {
            "product": product or None,
            "version": version or None,
            "language": language or None,
        },
        "results": results,
        "result_count": len(results),
        "last_sync_finished_at": metadata.get("last_sync_finished_at"),
    }


def normalize_page_reference(value: str) -> str:
    """Convert one official URL or site-relative route to a canonical URL."""
    stripped = value.strip()
    if not stripped:
        raise KnowledgeBaseError("page must not be empty")
    if "://" in stripped:
        return official_url(stripped.removesuffix(".md"))
    return official_url(f"{OFFICIAL_ORIGIN}/{stripped.lstrip('/').removesuffix('.md')}")


def get_page(connection: sqlite3.Connection, arguments: dict[str, Any]) -> dict[str, Any]:
    """Read one indexed page or heading with a caller-selected output bound."""
    page = normalize_page_reference(require_string(arguments, "page", 1_000))
    heading = optional_string(arguments, "heading", 300)
    max_characters = require_integer(arguments, "max_characters", default=20_000, minimum=1_000, maximum=50_000)
    row = connection.execute(
        "SELECT * FROM pages WHERE url = ? AND active = 1",
        (page,),
    ).fetchone()
    if row is None:
        aliases = connection.execute(
            "SELECT * FROM pages WHERE markdown_url = ? AND active = 1",
            (f"{page}.md",),
        ).fetchone()
        row = aliases
    if row is None:
        raise KnowledgeBaseError("page is not present in the synchronized official documentation index")
    content = str(row["content"])
    selected_heading: str | None = None
    if heading:
        chunk = connection.execute(
            "SELECT heading, content FROM chunks WHERE page_id = ? AND heading = ? COLLATE NOCASE ORDER BY ordinal LIMIT 1",
            (int(row["id"]), heading),
        ).fetchone()
        if chunk is None:
            chunk = connection.execute(
                "SELECT heading, content FROM chunks WHERE page_id = ? AND heading LIKE ? ESCAPE '\\' ORDER BY ordinal LIMIT 1",
                (int(row["id"]), f"%{escape_like(heading)}%"),
            ).fetchone()
        if chunk is None:
            raise KnowledgeBaseError("heading is not present on the indexed page")
        selected_heading = str(chunk["heading"])
        content = str(chunk["content"])
    truncated = len(content) > max_characters
    if truncated:
        content = content[:max_characters].rstrip() + "\n\n[内容已按字符上限截断]"
    return {
        "title": row["title"],
        "heading": selected_heading,
        "product": row["product"],
        "space": row["space"],
        "version": row["version"] or None,
        "language": row["language"] or None,
        "updated": row["updated"] or row["sitemap_lastmod"] or None,
        "url": row["url"],
        "content": content,
        "truncated": truncated,
    }


def escape_like(value: str) -> str:
    """Escape one value for a parameterized LIKE pattern."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def index_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Return active page, chunk and current failure counts."""
    pages = int(connection.execute("SELECT COUNT(*) FROM pages WHERE active = 1").fetchone()[0])
    chunks = int(
        connection.execute(
            "SELECT COUNT(*) FROM chunks JOIN pages ON pages.id = chunks.page_id WHERE pages.active = 1"
        ).fetchone()[0]
    )
    failures = int(connection.execute("SELECT COUNT(*) FROM sync_failures").fetchone()[0])
    return {"indexed_pages": pages, "indexed_chunks": chunks, "failed_pages": failures}


def status(connection: sqlite3.Connection) -> dict[str, Any]:
    """Describe index coverage without exposing a host filesystem path."""
    products = [
        {"product": row["product"], "pages": int(row["pages"])}
        for row in connection.execute(
            "SELECT product, COUNT(*) AS pages FROM pages WHERE active = 1 GROUP BY product ORDER BY pages DESC, product"
        )
    ]
    languages = [
        {"language": row["language"] or "unspecified", "pages": int(row["pages"])}
        for row in connection.execute(
            "SELECT language, COUNT(*) AS pages FROM pages WHERE active = 1 GROUP BY language ORDER BY pages DESC, language"
        )
    ]
    return {
        **index_counts(connection),
        "products": products,
        "languages": languages,
        "metadata": get_metadata(connection),
        "source_origin": OFFICIAL_ORIGIN,
        "read_only": True,
    }


def require_string(arguments: dict[str, Any], field: str, maximum: int) -> str:
    """Read one bounded single-line string from a process input object."""
    value = arguments.get(field)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or re.search(r"[\r\n\0]", value):
        raise KnowledgeBaseError(f"{field} must be one non-empty string of at most {maximum} characters")
    return value.strip()


def optional_string(arguments: dict[str, Any], field: str, maximum: int) -> str:
    """Read one optional bounded single-line string."""
    value = arguments.get(field)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > maximum or re.search(r"[\r\n\0]", value):
        raise KnowledgeBaseError(f"{field} must be one string of at most {maximum} characters")
    return value.strip()


def require_integer(arguments: dict[str, Any], field: str, *, default: int, minimum: int, maximum: int) -> int:
    """Read one bounded integer, rejecting booleans and fractional values."""
    value = arguments.get(field, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise KnowledgeBaseError(f"{field} must be an integer from {minimum} to {maximum}")
    return value


def read_payload(max_input_bytes: int) -> dict[str, Any]:
    """Read and validate the one-shot JSON helper request."""
    data = sys.stdin.buffer.read(max_input_bytes + 1)
    if len(data) > max_input_bytes:
        raise KnowledgeBaseError("request exceeds its input byte limit")
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KnowledgeBaseError("request is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict) or set(payload) != {"arguments"} or not isinstance(payload["arguments"], dict):
        raise KnowledgeBaseError("request must contain one arguments object")
    return payload["arguments"]


def emit(value: dict[str, Any], max_output_bytes: int) -> None:
    """Write one bounded JSON response to stdout."""
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > max_output_bytes:
        raise KnowledgeBaseError("response exceeds its output byte limit")
    sys.stdout.buffer.write(encoded)


def parse_args() -> argparse.Namespace:
    """Parse deployment-owned helper and synchronization options."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--knowledge-root", required=True)
    parser.add_argument("--operation", required=True, choices=("search", "get_page", "status", "sync"))
    parser.add_argument("--max-input-bytes", type=int, default=64_000)
    parser.add_argument("--max-output-bytes", type=int, default=1_000_000)
    parser.add_argument("--sitemap-url", default=DEFAULT_SITEMAP)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--request-delay-ms", type=int, default=100)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--full", action="store_true")
    return parser.parse_args()


def safe_root(value: str) -> Path:
    """Require an absolute knowledge-base directory without resolving a missing leaf."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise KnowledgeBaseError("knowledge root must be an absolute path")
    return path.resolve()


def main() -> int:
    """Run one synchronization or model-facing read operation."""
    args = parse_args()
    try:
        root = safe_root(args.knowledge_root)
        if args.operation == "sync":
            if not 1 <= args.workers <= 16:
                raise KnowledgeBaseError("workers must be from 1 to 16")
            if not 25 <= args.request_delay_ms <= 10_000:
                raise KnowledgeBaseError("request delay must be from 25 to 10000 milliseconds")
            result = synchronize(
                root,
                sitemap_url=args.sitemap_url,
                workers=args.workers,
                request_delay_ms=args.request_delay_ms,
                timeout=args.timeout_seconds,
                full=args.full,
            )
            emit({"ok": True, "result": result}, args.max_output_bytes)
            return 0

        arguments = read_payload(args.max_input_bytes)
        connection = connect_database(root, create=False)
        try:
            if args.operation == "search":
                result = search(connection, arguments)
            elif args.operation == "get_page":
                result = get_page(connection, arguments)
            else:
                if arguments:
                    raise KnowledgeBaseError("status does not accept arguments")
                result = status(connection)
        finally:
            connection.close()
        emit({"ok": True, "result": result}, args.max_output_bytes)
        return 0
    except (KnowledgeBaseError, OSError, sqlite3.Error, urllib.error.URLError, ValueError) as error:
        message = re.sub(r"[\r\n]+", " ", str(error))[:1_000]
        try:
            emit({"ok": False, "error": message}, args.max_output_bytes)
        except KnowledgeBaseError:
            print("frappe-docs: response limit is too small", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
