#!/usr/bin/env python3
"""Fetch and aggregate Administrative Enforcement Agency auction datasets."""

from __future__ import annotations

import hashlib
import html
import json
import re
import ssl
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOWNLOAD_DIR = ROOT / "downloads/auction"
OUTPUT_PATH = ROOT / "data/auction/moj-executive-auctions.json"
SOURCES_PATH = ROOT / "data/auction/auction-source-urls.json"

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


SSL_CONTEXT = ssl._create_unverified_context()


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120, context=SSL_CONTEXT) as response:
        return response.read()


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


def discover_sources(max_pages: int = 80) -> list[dict]:
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
            if ".json" not in parsed.path.lower():
                continue
            resource_by_url[href] = {
                "datasetTitle": title,
                "datasetUrl": page_url,
                "resourceUrl": href,
                "label": label or "JSON",
                "license": LICENSE_NAME,
                "licenseUrl": LICENSE_URL,
            }
        time.sleep(0.1)
    return sorted(resource_by_url.values(), key=lambda item: (item["datasetTitle"], item["resourceUrl"]))


def decode_json_bytes(raw: bytes):
    text = raw.decode("utf-8-sig", errors="replace")
    return json.loads(text)


def main() -> int:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    sources = discover_sources()
    rows_by_id: dict[str, dict] = {}
    source_stats = []
    for source in sources:
        resource_url = source["resourceUrl"]
        filename = hashlib.sha1(resource_url.encode("utf-8")).hexdigest()[:12] + ".json"
        target = DOWNLOAD_DIR / filename
        if target.exists() and target.stat().st_size > 0:
            raw = target.read_bytes()
        else:
            print(f"download {resource_url}", file=sys.stderr)
            raw = fetch_bytes(resource_url)
            target.write_bytes(raw)
        data = decode_json_bytes(raw)
        if isinstance(data, dict):
            rows = next((value for value in data.values() if isinstance(value, list)), [])
        else:
            rows = data
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
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SOURCES_PATH.write_text(json.dumps(payload | {"rows": []}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"sourceCount": len(sources), "rowCount": len(rows), "outputBytes": OUTPUT_PATH.stat().st_size}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
