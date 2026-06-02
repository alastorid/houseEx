#!/usr/bin/env python3
"""Build a compact auction-to-business-registration address join.

The source business registration dataset is large, so the web app should not
ship it whole. This script scans the official CSV and publishes only records
that match auction addresses.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUCTION_PATH = ROOT / "data/auction/moj-executive-auctions.json"
DOWNLOAD_DIR = ROOT / "downloads/business"
ZIP_PATH = DOWNLOAD_DIR / "BGMOPEN1.zip"
OUTPUT_PATH = ROOT / "data/auction/business-address-matches.json"
REPORT_PATH = ROOT / "data/auction/business-address-join-report.json"

DATASET_URL = "https://data.gov.tw/dataset/9400"
DOWNLOAD_URL = "https://eip.fia.gov.tw/data/BGMOPEN1.zip"
LICENSE_URL = "https://data.gov.tw/licenses"
LICENSE_NAME = "政府資料開放授權條款-第1版"
ATTRIBUTION = "財政部財政資訊中心「營業稅稅籍登記資料集」"


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("臺", "台").replace("巿", "市")
    text = re.sub(r"[－–—─―]", "-", text)
    text = re.sub(r"\s+", "", text)
    return text.lower()


def normalize_address(value: object) -> str:
    text = normalize_text(value).replace("之", "-")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff-]", "", text)


def address_prefix(value: str) -> str:
    """Return an address stem suitable for floor/suffix-insensitive matching."""
    text = normalize_address(value)
    if not text:
        return ""
    match = re.search(r"(.+?\d+(?:-\d+)?號)", text)
    if match:
        return match.group(1)
    match = re.search(r"(.+?\d+(?:-\d+)?地號)", text)
    if match:
        return match.group(1)
    return text


def case_no_of(row: dict) -> str:
    return "-".join(
        str(row.get(key, "") or "")
        for key in ["執行案號-年度", "執行案號-案件種類代碼", "執行案號-流水號"]
        if row.get(key)
    )


def stable_id(row: dict, index: int) -> str:
    if row.get("_auction_id"):
        return str(row["_auction_id"])
    parts = [
        row.get("分署別", ""),
        row.get("股別", ""),
        row.get("標別", ""),
        case_no_of(row),
        row.get("地址", ""),
        row.get("地號", ""),
        row.get("拍定日期", ""),
        row.get("拍定金額", ""),
        index,
    ]
    return normalize_text("|".join(map(str, parts)))


def read_json(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def ensure_download() -> None:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if ZIP_PATH.exists() and ZIP_PATH.stat().st_size > 1_000_000:
        return
    print(f"Downloading {DOWNLOAD_URL}", file=sys.stderr)
    urllib.request.urlretrieve(DOWNLOAD_URL, ZIP_PATH)


def main() -> int:
    ensure_download()
    auction_payload = read_json(AUCTION_PATH)
    auction_rows = auction_payload.get("rows", auction_payload) if isinstance(auction_payload, dict) else auction_payload
    auction_exact: dict[str, list[dict]] = defaultdict(list)
    auction_prefix: dict[str, list[dict]] = defaultdict(list)

    for index, row in enumerate(auction_rows):
        address = row.get("地址", "")
        item = {
            "auctionId": stable_id(row, index),
            "auctionIndex": index,
            "city": row.get("縣市", ""),
            "district": row.get("鄉鎮區", ""),
            "address": address,
            "landNo": row.get("地號", ""),
            "soldDate": row.get("拍定日期", ""),
            "soldPrice": row.get("拍定金額", ""),
        }
        exact = normalize_address(address)
        prefix = address_prefix(address)
        if exact:
            auction_exact[exact].append(item)
        if prefix:
            auction_prefix[prefix].append(item)

    matches_by_auction_id: dict[str, list[dict]] = defaultdict(list)
    scanned = 0
    matched_business_ids: set[str] = set()
    method_counts: dict[str, int] = defaultdict(int)
    sample_no_address: list[dict] = []

    with zipfile.ZipFile(ZIP_PATH) as archive:
        csv_name = archive.namelist()[0]
        with archive.open(csv_name) as raw_file:
            text_file = (line.decode("utf-8-sig", errors="replace") for line in raw_file)
            reader = csv.DictReader(text_file)
            for row in reader:
                address = row.get("營業地址", "")
                if not row.get("統一編號") or not address:
                    if len(sample_no_address) < 3:
                        sample_no_address.append(row)
                    continue
                scanned += 1
                exact = normalize_address(address)
                prefix = address_prefix(address)
                candidates: list[tuple[int, str, list[dict]]] = []
                if exact in auction_exact:
                    candidates.append((90, "normalized_address", auction_exact[exact]))
                if prefix in auction_prefix:
                    candidates.append((70, "address_prefix", auction_prefix[prefix]))
                if not candidates:
                    continue

                business = {
                    "businessId": row.get("統一編號", ""),
                    "businessName": row.get("營業人名稱", ""),
                    "businessAddress": address,
                    "normalizedAddress": exact,
                    "capital": row.get("資本額", ""),
                    "setupDate": row.get("設立日期", ""),
                    "organization": row.get("組織別名稱", ""),
                    "usesInvoice": row.get("使用統一發票", ""),
                    "industryCode": row.get("行業代號", ""),
                    "industryName": row.get("名稱", ""),
                    "industryCode1": row.get("行業代號1", ""),
                    "industryName1": row.get("名稱1", ""),
                    "raw": row,
                }
                for confidence, method, auctions in candidates:
                    method_counts[method] += 1
                    for auction in auctions:
                        payload = {
                            **business,
                            "confidence": confidence,
                            "matchMethod": method,
                        }
                        bucket = matches_by_auction_id[auction["auctionId"]]
                        key = (payload["businessId"], payload["matchMethod"])
                        if key not in {(item["businessId"], item["matchMethod"]) for item in bucket}:
                            bucket.append(payload)
                            matched_business_ids.add(payload["businessId"])

    for bucket in matches_by_auction_id.values():
        bucket.sort(key=lambda item: (-item["confidence"], item["businessId"]))

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    zip_hash = hashlib.sha256(ZIP_PATH.read_bytes()).hexdigest()
    result = {
        "generatedAt": generated_at,
        "source": {
            "dataset": ATTRIBUTION,
            "datasetUrl": DATASET_URL,
            "downloadUrl": DOWNLOAD_URL,
            "license": LICENSE_NAME,
            "licenseUrl": LICENSE_URL,
            "attribution": ATTRIBUTION,
            "zipSha256": zip_hash,
        },
        "join": {
            "methods": [
                {"name": "normalized_address", "confidence": 90},
                {"name": "address_prefix", "confidence": 70},
            ],
            "note": "Only records matched to auction addresses are included; the full dataset 9400 CSV is not shipped to the browser.",
        },
        "auctionCount": len(auction_rows),
        "businessCountScanned": scanned,
        "matchedAuctionCount": len(matches_by_auction_id),
        "matchedBusinessCount": len(matched_business_ids),
        "matchesByAuctionId": dict(sorted(matches_by_auction_id.items())),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "generatedAt": generated_at,
        "auctionCount": len(auction_rows),
        "businessCountScanned": scanned,
        "matchedAuctionCount": len(matches_by_auction_id),
        "matchedBusinessCount": len(matched_business_ids),
        "methodCounts": dict(method_counts),
        "outputBytes": OUTPUT_PATH.stat().st_size,
        "source": result["source"],
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
