#!/usr/bin/env python3
"""Fetch and aggregate Administrative Enforcement Agency auction datasets."""

from __future__ import annotations

import hashlib
import html
import csv
import concurrent.futures
import gzip
import io
import json
import re
import sqlite3
import ssl
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOWNLOAD_DIR = ROOT / "downloads/auction"
OUTPUT_PATH = ROOT / "data/auction/moj-executive-auctions.json"
SOURCES_PATH = ROOT / "data/auction/auction-source-urls.json"
SQLITE_PATH = ROOT / "data/auction/auction.sqlite"
SQLITE_GZ_PATH = ROOT / "data/auction/auction.sqlite.gz"

LICENSE_NAME = "政府資料開放授權條款-第1版"
LICENSE_URL = "https://data.gov.tw/licenses"
AGENCY = "法務部行政執行署"

SEED_DATASETS = [
    "https://data.gov.tw/dataset/167258",  # 112 Q4
    "https://data.gov.tw/dataset/172383",  # 113 Q4
    "https://data.gov.tw/dataset/173341",  # 114 Q1
    "https://data.gov.tw/dataset/173967",  # 114 Q2
    "https://data.gov.tw/dataset/176422",  # 114 Q4
    "https://data.gov.tw/dataset/177351",  # 115 Q1
]

OFFICIAL_LISTING_URLS = [
    "https://www.tpk.moj.gov.tw/9539/9883/9887/?Page=1&PageSize=200&type=",
]


SSL_CONTEXT = ssl._create_unverified_context()


def safe_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/:%")
    query = urllib.parse.quote(urllib.parse.unquote(parts.query), safe="=&?/:,%")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def request_headers(url: str) -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "*/*",
        "Referer": "https://www.tpk.moj.gov.tw/9539/9883/9887/?Page=1&PageSize=200&type=",
    }


def fetch_text(url: str, retries: int = 3) -> str:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(safe_url(url), headers=request_headers(url))
            with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception as error:
            last_error = error
            time.sleep(0.5 + attempt)
    raise last_error or RuntimeError(f"failed to fetch {url}")


def fetch_bytes(url: str, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(safe_url(url), headers=request_headers(url))
            with urllib.request.urlopen(req, timeout=120, context=SSL_CONTEXT) as response:
                return response.read()
        except Exception as error:
            last_error = error
            time.sleep(0.5 + attempt)
    raise last_error or RuntimeError(f"failed to fetch {url}")


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("臺", "台").replace("巿", "市")
    text = re.sub(r"[－–—─―]", "-", text)
    return re.sub(r"\s+", "", text).lower()


def normalize_address(value: object) -> str:
    text = normalize_text(value).replace("之", "-")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff-]", "", text)


def case_no_of(row: dict) -> str:
    return "-".join(
        str(row.get(key, "") or "")
        for key in ["執行案號-年度", "執行案號-案件種類代碼", "執行案號-流水號"]
        if row.get(key)
    )


def stable_id(row: dict) -> str:
    parts = [
        row.get("分署別", ""),
        row.get("股別", ""),
        row.get("標別", ""),
        case_no_of(row),
        row.get("地址", ""),
        row.get("地號", ""),
        row.get("拍定日期", ""),
        row.get("拍定金額", ""),
    ]
    return hashlib.sha1(normalize_text("|".join(map(str, parts))).encode("utf-8")).hexdigest()[:20]


def dataset_title(page: str) -> str:
    match = re.search(r"<h2[^>]*>(.*?)</h2>", page, re.S)
    return clean_text(match.group(1)) if match else ""


def link_entries(page: str, base_url: str) -> list[tuple[str, str]]:
    entries = []
    for match in re.finditer(r"<a\b([^>]*)>(.*?)</a>", page, re.I | re.S):
        attrs, label = match.groups()
        href_match = re.search(r'href=["\']([^"\']+)["\']', attrs, re.I)
        if not href_match:
            continue
        href = html.unescape(href_match.group(1))
        entries.append((urllib.parse.urljoin(base_url, href), clean_text(label)))
    return entries


def source_kind(url: str, label: str = "") -> str:
    value = urllib.parse.unquote((urllib.parse.urlparse(url).path + " " + label).lower())
    if ".json" in value:
        return "json"
    if ".csv" in value:
        return "csv"
    if ".zip" in value:
        return "zip"
    if ".xml" in value:
        return "xml"
    return "binary"


def auction_post_title(page: str) -> str:
    for tag in ("h1", "h2", "h3"):
        match = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", page, re.S | re.I)
        if match:
            title = clean_text(match.group(1))
            if "已拍定不動產" in title:
                return title
    match = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
    return clean_text(match.group(1)) if match else ""


def discover_official_listing_sources() -> list[dict]:
    cached_by_post_url: dict[str, dict] = {}
    if SOURCES_PATH.exists():
        try:
            cached_payload = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
            for source in cached_payload.get("sources", []):
                dataset_url = source.get("datasetUrl")
                resource_url = source.get("resourceUrl")
                if dataset_url and resource_url:
                    cached_by_post_url[dataset_url] = {
                        "datasetTitle": source.get("datasetTitle", ""),
                        "datasetUrl": dataset_url,
                        "resourceUrl": resource_url,
                        "label": source.get("label", ""),
                        "format": source.get("format") or source_kind(resource_url, source.get("label", "")),
                        "license": LICENSE_NAME,
                        "licenseUrl": LICENSE_URL,
                    }
        except Exception as error:
            print(f"ignore stale source cache: {error}", file=sys.stderr)

    post_by_url: dict[str, str] = {}
    for listing_url in OFFICIAL_LISTING_URLS:
        page = fetch_text(listing_url)
        for href, label in link_entries(page, listing_url):
            if "/9539/9883/9887/" not in href or "/post" not in href:
                continue
            if "已拍定不動產" not in label and "所屬分署已拍定不動產" not in label:
                continue
            post_by_url[href] = re.sub(r"^\d+\s*", "", label).strip()

    def inspect_post(item: tuple[str, str]) -> dict | None:
        post_url, list_title = item
        try:
            page = fetch_text(post_url)
        except Exception as error:
            print(f"skip {post_url}: {error}", file=sys.stderr)
            return None
        title = auction_post_title(page) or list_title
        candidates = []
        for href, label in link_entries(page, post_url):
            parsed = urllib.parse.urlparse(href)
            if not parsed.netloc.endswith("moj.gov.tw"):
                continue
            kind = source_kind(href, label)
            if kind not in {"json", "csv", "zip"}:
                continue
            if "不動產" not in urllib.parse.unquote(href + label):
                continue
            candidates.append((kind, href, label or kind.upper()))
        if not candidates:
            return None
        priority = {"json": 0, "csv": 1, "zip": 2}
        kind, href, label = sorted(candidates, key=lambda item: (priority.get(item[0], 9), item[1]))[0]
        return {
            "datasetTitle": title,
            "datasetUrl": post_url,
            "resourceUrl": href,
            "label": label,
            "format": kind,
            "license": LICENSE_NAME,
            "licenseUrl": LICENSE_URL,
        }

    resource_by_url: dict[str, dict] = {}
    uncached_posts = []
    for post_url, list_title in sorted(post_by_url.items()):
        cached = cached_by_post_url.get(post_url)
        if cached:
            cached["datasetTitle"] = list_title or cached["datasetTitle"]
            resource_by_url[cached["resourceUrl"]] = cached
        else:
            uncached_posts.append((post_url, list_title))
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        for source in executor.map(inspect_post, uncached_posts):
            if source:
                resource_by_url[source["resourceUrl"]] = source
    return sorted(resource_by_url.values(), key=lambda item: (item["datasetTitle"], item["resourceUrl"]))


def discover_data_gov_sources(max_pages: int = 80) -> list[dict]:
    seen_pages: set[str] = set()
    queue = deque(SEED_DATASETS)
    resource_by_url: dict[str, dict] = {}
    while queue and len(seen_pages) < max_pages:
        page_url = queue.popleft()
        if page_url in seen_pages:
            continue
        seen_pages.add(page_url)
        try:
            page = fetch_text(page_url)
        except Exception as error:
            print(f"skip {page_url}: {error}", file=sys.stderr)
            continue
        title = dataset_title(page)
        if "行政執行署" not in title or "已拍定不動產" not in title:
            continue
        for href, label in link_entries(page, page_url):
            if re.search(r"/dataset/\d+", href) and href not in seen_pages:
                queue.append(href)
            parsed = urllib.parse.urlparse(href)
            if not parsed.netloc.endswith("moj.gov.tw"):
                continue
            kind = source_kind(href, label)
            if kind != "json":
                continue
            resource_by_url[href] = {
                "datasetTitle": title,
                "datasetUrl": page_url,
                "resourceUrl": href,
                "label": label or "JSON",
                "format": kind,
                "license": LICENSE_NAME,
                "licenseUrl": LICENSE_URL,
            }
        time.sleep(0.1)
    return sorted(resource_by_url.values(), key=lambda item: (item["datasetTitle"], item["resourceUrl"]))


def discover_sources() -> list[dict]:
    by_title: dict[str, dict] = {}
    for source in discover_official_listing_sources():
        by_title[source["datasetTitle"]] = source
    if by_title:
        return sorted(by_title.values(), key=lambda item: (item["datasetTitle"], item["resourceUrl"]))
    for source in discover_data_gov_sources():
        by_title.setdefault(source["datasetTitle"], source)
    return sorted(by_title.values(), key=lambda item: (item["datasetTitle"], item["resourceUrl"]))


def decode_json_bytes(raw: bytes):
    text = raw.decode("utf-8-sig", errors="replace")
    return json.loads(text)


def decode_csv_bytes(raw: bytes) -> list[dict]:
    for encoding in ("utf-8-sig", "utf-8", "cp950", "big5"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    sample = text[:4096]
    dialect = csv.Sniffer().sniff(sample) if "," in sample else csv.excel
    return [dict(row) for row in csv.DictReader(io.StringIO(text), dialect=dialect)]


def decode_rows(raw: bytes, kind: str) -> list[dict]:
    if kind == "zip":
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = archive.namelist()
            for extension, nested_kind in ((".json", "json"), (".csv", "csv")):
                for name in names:
                    if name.lower().endswith(extension):
                        return decode_rows(archive.read(name), nested_kind)
        return []
    if kind == "csv":
        return decode_csv_bytes(raw)
    data = decode_json_bytes(raw)
    if isinstance(data, dict):
        rows = next((value for value in data.values() if isinstance(value, list)), [])
    else:
        rows = data
    return rows if isinstance(rows, list) else []


def number_value(value: object) -> float | None:
    text = normalize_text(value).replace(",", "")
    if not text:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def build_sqlite(rows: list[dict]) -> None:
    if SQLITE_PATH.exists():
        SQLITE_PATH.unlink()
    if SQLITE_GZ_PATH.exists():
        SQLITE_GZ_PATH.unlink()
    conn = sqlite3.connect(SQLITE_PATH)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute(
        """
        CREATE TABLE auction_sales (
          auction_id TEXT PRIMARY KEY,
          city TEXT,
          district TEXT,
          full_address TEXT,
          normalized_address TEXT,
          land_no TEXT,
          auction_type TEXT,
          auction_round TEXT,
          sold_date TEXT,
          sold_price REAL,
          floor_price REAL,
          branch TEXT,
          case_no TEXT,
          source_title TEXT,
          source_url TEXT,
          resource_url TEXT,
          raw_json TEXT NOT NULL
        )
        """
    )
    conn.executemany(
        """
        INSERT OR REPLACE INTO auction_sales VALUES (
          :auction_id, :city, :district, :full_address, :normalized_address,
          :land_no, :auction_type, :auction_round, :sold_date, :sold_price,
          :floor_price, :branch, :case_no, :source_title, :source_url,
          :resource_url, :raw_json
        )
        """,
        [
            {
                "auction_id": row.get("_auction_id"),
                "city": row.get("縣市", ""),
                "district": row.get("鄉鎮區", ""),
                "full_address": row.get("地址", ""),
                "normalized_address": row.get("_normalized_address", ""),
                "land_no": row.get("地號", ""),
                "auction_type": row.get("拍賣類別", ""),
                "auction_round": row.get("拍次", ""),
                "sold_date": row.get("拍定日期", ""),
                "sold_price": number_value(row.get("拍定金額")),
                "floor_price": number_value(row.get("拍賣底價")),
                "branch": row.get("分署別", ""),
                "case_no": case_no_of(row),
                "source_title": row.get("_auction_source_title", ""),
                "source_url": row.get("_auction_source_url", ""),
                "resource_url": row.get("_auction_resource_url", ""),
                "raw_json": json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            }
            for row in rows
        ],
    )
    for sql in (
        "CREATE INDEX idx_auction_city_district ON auction_sales(city, district)",
        "CREATE INDEX idx_auction_address ON auction_sales(normalized_address)",
        "CREATE INDEX idx_auction_date ON auction_sales(sold_date)",
        "CREATE INDEX idx_auction_price ON auction_sales(sold_price)",
    ):
        conn.execute(sql)
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    with SQLITE_PATH.open("rb") as src, gzip.open(SQLITE_GZ_PATH, "wb", compresslevel=9) as dst:
        dst.write(src.read())


def main() -> int:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    sources = discover_sources()
    rows_by_id: dict[str, dict] = {}
    source_stats = []
    for source in sources:
        resource_url = source["resourceUrl"]
        kind = source.get("format") or source_kind(resource_url, source.get("label", ""))
        filename = hashlib.sha1(resource_url.encode("utf-8")).hexdigest()[:12] + f".{kind}"
        target = DOWNLOAD_DIR / filename
        if target.exists() and target.stat().st_size > 0:
            raw = target.read_bytes()
        else:
            print(f"download {resource_url}", file=sys.stderr)
            raw = fetch_bytes(resource_url)
            target.write_bytes(raw)
        rows = decode_rows(raw, kind)
        added = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            item = dict(row)
            item["_auction_source_title"] = source["datasetTitle"]
            item["_auction_source_url"] = source["datasetUrl"]
            item["_auction_resource_url"] = resource_url
            item["_license"] = LICENSE_NAME
            item["_license_url"] = LICENSE_URL
            item["_normalized_address"] = normalize_address(item.get("地址", ""))
            item["_auction_id"] = stable_id(item)
            if item["_auction_id"] not in rows_by_id:
                rows_by_id[item["_auction_id"]] = item
                added += 1
        source_stats.append({**source, "downloadBytes": len(raw), "rowCount": len(rows), "addedRows": added})

    rows = sorted(rows_by_id.values(), key=lambda item: (item.get("拍定日期", ""), item.get("縣市", ""), item.get("_auction_id", "")), reverse=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": {
            "agency": AGENCY,
            "license": LICENSE_NAME,
            "licenseUrl": LICENSE_URL,
            "attribution": "法務部行政執行署「已拍定不動產資料」",
        },
        "sourceCount": len(sources),
        "rowCount": len(rows),
        "sources": source_stats,
        "rows": rows,
    }
    build_sqlite(rows)
    payload["sqlite"] = {
        "path": "data/auction/auction.sqlite.gz",
        "compressedBytes": SQLITE_GZ_PATH.stat().st_size,
        "uncompressedBytes": SQLITE_PATH.stat().st_size,
        "hash": hashlib.sha256(SQLITE_GZ_PATH.read_bytes()).hexdigest(),
    }
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SOURCES_PATH.write_text(json.dumps(payload | {"rows": []}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"sourceCount": len(sources), "rowCount": len(rows), "outputBytes": OUTPUT_PATH.stat().st_size, "sqliteGzipBytes": SQLITE_GZ_PATH.stat().st_size}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
