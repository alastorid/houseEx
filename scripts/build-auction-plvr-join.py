#!/usr/bin/env python3
"""Build compact auction-to-PLVR address matches for the combined terminal."""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUCTION_PATH = ROOT / "data/auction/moj-executive-auctions.json"
PLVR_WEB_DIR = ROOT / "data/plvr/web"
OUTPUT_PATH = ROOT / "data/auction/auction-plvr-address-matches.json"
REPORT_PATH = ROOT / "data/auction/auction-plvr-join-report.json"
M2_PER_PING = 3.305785


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("臺", "台").replace("巿", "市")
    text = re.sub(r"[－–—─―]", "-", text)
    return re.sub(r"\s+", "", text).lower()


def normalize_address(value: object) -> str:
    text = normalize_text(value).replace("之", "-")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff-]", "", text)


def address_prefix(value: object) -> str:
    text = normalize_address(value)
    match = re.search(r"(.+?\d+(?:-\d+)?號)", text)
    if match:
        return match.group(1)
    match = re.search(r"(.+?\d+(?:-\d+)?地號)", text)
    if match:
        return match.group(1)
    return text


def to_number(value: object) -> float:
    try:
        return float(str(value or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def parse_plvr_date(value: object) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 5:
        return ""
    year_len = len(digits) - 4
    year = int(digits[:year_len])
    if year < 1911:
        year += 1911
    return f"{year:04d}-{digits[year_len:year_len+2]}-{digits[year_len+2:year_len+4]}"


def case_no_of(row: dict) -> str:
    return "-".join(
        str(row.get(key, "") or "")
        for key in ["執行案號-年度", "執行案號-案件種類代碼", "執行案號-流水號"]
        if row.get(key)
    )


def auction_id(row: dict) -> str:
    if row.get("_auction_id"):
        return str(row["_auction_id"])
    parts = [row.get("分署別", ""), row.get("股別", ""), row.get("標別", ""), case_no_of(row), row.get("地址", ""), row.get("地號", ""), row.get("拍定日期", ""), row.get("拍定金額", "")]
    return hashlib.sha1(normalize_text("|".join(map(str, parts))).encode("utf-8")).hexdigest()[:20]


def plvr_id(record: dict, index: int) -> str:
    values = record.get("values") or {}
    parts = [record.get("_source_id", ""), record.get("_file", ""), index, values.get("編號", ""), values.get("土地位置建物門牌", ""), values.get("交易年月日", ""), values.get("總價元", "")]
    return hashlib.sha1(normalize_text("|".join(map(str, parts))).encode("utf-8")).hexdigest()[:20]


def plvr_summary(record: dict, index: int) -> dict:
    values = record.get("values") or {}
    total = to_number(values.get("總價元"))
    building_m2 = to_number(values.get("建物移轉總面積平方公尺"))
    land_m2 = to_number(values.get("土地移轉總面積平方公尺"))
    unit_m2 = to_number(values.get("單價元平方公尺"))
    return {
        "transactionId": plvr_id(record, index),
        "city": record.get("city_name", ""),
        "district": values.get("鄉鎮市區", ""),
        "address": values.get("土地位置建物門牌", ""),
        "normalizedAddress": normalize_address(values.get("土地位置建物門牌", "")),
        "transactionDate": parse_plvr_date(values.get("交易年月日")),
        "totalPrice": total,
        "unitPricePing": unit_m2 * M2_PER_PING if unit_m2 else 0,
        "buildingAreaPing": building_m2 / M2_PER_PING if building_m2 else 0,
        "landAreaPing": land_m2 / M2_PER_PING if land_m2 else 0,
        "buildingType": values.get("建物型態", ""),
        "transactionTarget": values.get("交易標的", ""),
        "sourceBatch": record.get("_source_id", ""),
        "raw": values,
    }


def read_auction_rows() -> list[dict]:
    payload = json.load(open(AUCTION_PATH, encoding="utf-8-sig"))
    return payload.get("rows", payload) if isinstance(payload, dict) else payload


def main() -> int:
    auction_rows = read_auction_rows()
    exact = defaultdict(list)
    prefix = defaultdict(list)
    auctions = {}
    for row in auction_rows:
        aid = auction_id(row)
        auctions[aid] = {
            "auctionId": aid,
            "city": row.get("縣市", ""),
            "district": row.get("鄉鎮區", ""),
            "address": row.get("地址", ""),
            "landNo": row.get("地號", ""),
            "soldDate": row.get("拍定日期", ""),
            "soldPrice": to_number(row.get("拍定金額")),
            "floorPrice": to_number(row.get("拍賣底價")),
            "type": row.get("拍賣類別", ""),
            "round": row.get("拍次", ""),
            "branch": row.get("分署別", ""),
            "caseNo": case_no_of(row),
            "url": row.get("網址", ""),
        }
        addr = normalize_address(row.get("地址", ""))
        stem = address_prefix(row.get("地址", ""))
        if addr:
            exact[addr].append(aid)
        if stem:
            prefix[stem].append(aid)

    matches = defaultdict(list)
    scanned = 0
    for path in sorted(PLVR_WEB_DIR.glob("*.json.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        for index, record in enumerate(payload.get("records", [])):
            values = record.get("values") or {}
            address = values.get("土地位置建物門牌", "")
            if not address:
                continue
            scanned += 1
            addr = normalize_address(address)
            stem = address_prefix(address)
            candidates = []
            if addr in exact:
                candidates.append((90, "normalized_address", exact[addr]))
            if stem in prefix:
                candidates.append((70, "address_prefix", prefix[stem]))
            if not candidates:
                continue
            summary = plvr_summary(record, index)
            for confidence, method, auction_ids in candidates:
                for aid in auction_ids:
                    bucket = matches[aid]
                    if summary["transactionId"] in {item["transactionId"] for item in bucket}:
                        continue
                    bucket.append({**summary, "confidence": confidence, "matchMethod": method})

    combined_rows = []
    for aid, plvr_matches in matches.items():
        plvr_matches.sort(key=lambda item: (item["confidence"], item["transactionDate"], item["totalPrice"]), reverse=True)
        combined_rows.append({**auctions[aid], "plvrMatchCount": len(plvr_matches), "plvrMatches": plvr_matches[:120]})
    combined_rows.sort(key=lambda item: (item["plvrMatchCount"], item["soldDate"], item["soldPrice"]), reverse=True)

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    result = {
        "generatedAt": generated_at,
        "source": {
            "auction": "法務部行政執行署「已拍定不動產資料」",
            "plvr": "內政部不動產交易實價登錄 Open Data",
            "license": "政府資料開放授權條款-第1版",
            "licenseUrl": "https://data.gov.tw/licenses",
        },
        "auctionCount": len(auction_rows),
        "plvrScannedCount": scanned,
        "matchedAuctionCount": len(combined_rows),
        "rows": combined_rows,
    }
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {key: result[key] for key in ["generatedAt", "auctionCount", "plvrScannedCount", "matchedAuctionCount", "source"]}
    report["outputBytes"] = OUTPUT_PATH.stat().st_size
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
