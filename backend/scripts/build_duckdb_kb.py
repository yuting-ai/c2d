"""Build offline DuckDB doc knowledge base into ./doc/duckdb_official.

Usage:
  python -m backend.scripts.build_duckdb_kb
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx

TARGET_DIR = Path("doc/duckdb_official")

# Use official sitemap to crawl all SQL docs for complete coverage.
SITEMAP_URL = "https://duckdb.org/docs/sitemap.xml"
SQL_DOC_PREFIX = "https://duckdb.org/docs/stable/sql/"

# Hard cap for debugging; set to None to crawl everything.
MAX_PAGES: int | None = None

USER_AGENT = "c2d-duckdb-offline-kb/0.1"


def _html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style.*?>.*?</style>", " ", text)
    # Keep code blocks (pre/code) as plain text first, so content survives tag stripping.
    text = re.sub(r"(?is)<pre><code[^>]*>(.*?)</code></pre>", r" \n \1 \n ", text)
    text = re.sub(r"(?is)<code[^>]*>(.*?)</code>", r" \1 ", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _chunk_text(text: str, chunk_size: int = 1200, overlap: int = 180) -> list[str]:
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(n, start + chunk_size)
        chunks.append(text[start:end].strip())
        if end >= n:
            break
        start = max(start + 1, end - overlap)
    return [c for c in chunks if c]


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    chunks_path = TARGET_DIR / "chunks.jsonl"

    all_chunks: list[dict] = []

    # Rebuild chunks each time; keep md snapshots for easier inspection.
    if chunks_path.exists():
        chunks_path.unlink()

    with httpx.Client(timeout=30.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        sm = client.get(SITEMAP_URL)
        sm.raise_for_status()

        xml_root = ET.fromstring(sm.text)
        urls: list[str] = []
        for node in xml_root.iter():
            if node.tag.lower().endswith("loc"):
                u = (node.text or "").strip()
                if u.startswith(SQL_DOC_PREFIX):
                    urls.append(u)

        # de-dup while preserving order
        seen: set[str] = set()
        sql_urls: list[str] = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                sql_urls.append(u)

    if not sql_urls:
        raise RuntimeError(f"No SQL docs found in sitemap: prefix={SQL_DOC_PREFIX}")

    if MAX_PAGES and MAX_PAGES > 0:
        sql_urls = sql_urls[:MAX_PAGES]

    failed: list[str] = []
    with httpx.Client(timeout=30.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        for url in sql_urls:
            try:
                resp = client.get(url)
                resp.raise_for_status()
            except Exception:
                failed.append(url)
                continue

            html = resp.text
            text = _html_to_text(html)

            # Derive a stable filename from URL.
            u = url.replace("https://duckdb.org/docs/stable/", "").strip("/")
            safe = re.sub(r"[^a-zA-Z0-9_]+", "_", u).strip("_").lower()
            md_path = TARGET_DIR / f"{safe}.md"
            if not md_path.exists():
                md_path.write_text(f"# {safe}\n\nSource: {url}\n\n{text}\n", encoding="utf-8")

            for idx, chunk in enumerate(_chunk_text(text), 1):
                all_chunks.append(
                    {
                        "source": str(md_path),
                        "url": url,
                        "title": f"{safe} #{idx}",
                        "content": chunk,
                    }
                )

    with chunks_path.open("w", encoding="utf-8") as f:
        for obj in all_chunks:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    if failed:
        print(f"Built {len(all_chunks)} chunks into {chunks_path} (failed pages: {len(failed)})")
    else:
        print(f"Built {len(all_chunks)} chunks into {chunks_path}")


if __name__ == "__main__":
    main()
