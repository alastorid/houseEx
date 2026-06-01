#!/usr/bin/env python3
"""Report community names and address clusters that are not discoverable."""

from __future__ import annotations

import json
import re
import sqlite3
import gzip
import tempfile
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def normalize(value: object) -> str:
    text = str(value or "").replace(" ", "")
    text = "".join(chr(ord(ch) - 0xFEE0) if "０" <= ch <= "９" else ch for ch in text)
    return text.replace("員林鎮", "員林市")


def address_cluster(address: str) -> str:
    text = normalize(address)
    match = re.search(r"(.+?(?:路|街|大道|巷))(\d+)號", text)
    if match:
        number = int(match.group(2))
        bucket = number // 20 * 20
        return f"{match.group(1)}{bucket}-{bucket + 19}號"
    return text[:18] or "unknown"


def main() -> int:
    city_dir = ROOT / "data/db/district/changhua"
    db_paths = list(city_dir.glob("*.sqlite"))
    tmp_path = None
    if not db_paths:
        gz_paths = list(city_dir.glob("*.sqlite.gz"))
        if gz_paths:
            tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
            tmp_path = Path(tmp.name)
            tmp.close()
            with gzip.open(gz_paths[0], "rb") as src, tmp_path.open("wb") as dst:
                dst.write(src.read())
            db_paths = [tmp_path]
    if not db_paths:
        print(f"No sqlite files found in {city_dir}")
        return 1
    db_path = db_paths[0]
    conn = sqlite3.connect(db_path)
    present_missing = conn.execute(
        """
        SELECT t.community_name, COUNT(*) AS tx_count, MIN(t.city), MIN(t.district),
               MIN(t.full_address), MAX(t.transaction_date)
        FROM transactions t
        LEFT JOIN communities c
          ON c.city = t.city AND c.community_name = t.community_name
        WHERE t.community_name <> '' AND c.community_id IS NULL
        GROUP BY t.community_name
        ORDER BY tx_count DESC, t.community_name
        LIMIT 100
        """
    ).fetchall()

    blank_rows = conn.execute(
        """
        SELECT city, district, full_address, transaction_date, total_price, source_batch
        FROM transactions
        WHERE community_name = ''
        """
    ).fetchall()
    clusters: dict[tuple[str, str, str], dict] = {}
    for city, district, address, date, price, source in blank_rows:
        key = (city, district, address_cluster(address))
        item = clusters.setdefault(
            key,
            {
                "city": city,
                "district": district,
                "addressCluster": key[2],
                "transactionCount": 0,
                "sampleAddresses": Counter(),
                "latestTransactionDate": "",
                "sourceBatches": Counter(),
            },
        )
        item["transactionCount"] += 1
        item["sampleAddresses"][normalize(address)] += 1
        item["latestTransactionDate"] = max(item["latestTransactionDate"], date or "")
        item["sourceBatches"][source or ""] += 1

    top_blank_clusters = sorted(clusters.values(), key=lambda item: item["transactionCount"], reverse=True)[:100]
    for item in top_blank_clusters:
        item["sampleAddresses"] = [address for address, _ in item["sampleAddresses"].most_common(8)]
        item["sourceBatches"] = dict(item["sourceBatches"].most_common(8))

    report = {
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "cityDb": db_path.as_posix(),
        "communitiesPresentInTransactionsButMissingFromSearchableIndex": [
            {
                "communityName": name,
                "transactionCount": count,
                "city": city,
                "district": district,
                "sampleAddress": address,
                "latestTransactionDate": latest,
            }
            for name, count, city, district, address, latest in present_missing
        ],
        "blankCommunityNameAddressClusters": top_blank_clusters,
    }
    out = ROOT / "data/db/community-gap-report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    print(f"named missing: {len(present_missing)}")
    print(f"blank-name clusters: {len(top_blank_clusters)}")
    conn.close()
    if tmp_path:
        tmp_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
