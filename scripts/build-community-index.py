#!/usr/bin/env python3
"""Build lightweight city-level community indexes from PLVR web shards."""

from __future__ import annotations

import argparse
import gzip
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def to_number(value: object) -> float:
    try:
        return float(str(value or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def tw_date(value: object) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(digits) < 6:
        return ""
    year = int(digits[:-4]) + 1911
    return f"{year:04d}-{digits[-4:-2]}-{digits[-2:]}"


def median(values: list[float]) -> float:
    values = sorted(v for v in values if v > 0)
    if not values:
        return 0
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return (values[mid - 1] + values[mid]) / 2


def compact_stats(rows: list[dict]) -> dict:
    prices = [row["total_price"] for row in rows if row["total_price"] > 0]
    units = [row["unit_price"] for row in rows if row["unit_price"] > 0]
    latest = max((row["date"] for row in rows if row["date"]), default="")
    return {
        "count": len(rows),
        "latest_date": latest,
        "avg_total_price": round(sum(prices) / len(prices)) if prices else 0,
        "median_total_price": round(median(prices)),
        "avg_unit_price": round(sum(units) / len(units)) if units else 0,
        "median_unit_price": round(median(units)),
        "max_total_price": round(max(prices)) if prices else 0,
    }


def read_shard(path: Path) -> dict:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)
    return json.loads(path.read_text(encoding="utf-8"))


def write_gzip_json(path: Path, payload: dict) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)
    return path.stat().st_size


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-index", type=Path, default=Path("data/plvr/web-index.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/plvr/communities"))
    parser.add_argument("--output-index", type=Path, default=Path("data/plvr/community-index.json"))
    args = parser.parse_args()

    index = json.loads(args.web_index.read_text(encoding="utf-8"))
    city_outputs = []
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for city in index["cities"]:
        community_rows: dict[str, list[dict]] = defaultdict(list)
        for town in city["townships"]:
            shard_path = Path(town["shard"])
            if not shard_path.exists():
                continue
            data = read_shard(shard_path)
            for record in data.get("records", []):
                if record.get("table_kind") != "主檔":
                    continue
                values = record.get("values") or {}
                name = str(values.get("建案名稱") or "").strip()
                if not name:
                    continue
                community_rows[name].append(
                    {
                        "township": values.get("鄉鎮市區") or town["township"],
                        "shard": town["shard"],
                        "date": tw_date(values.get("交易年月日")),
                        "address": values.get("土地位置建物門牌") or "",
                        "target": values.get("交易標的") or record.get("transaction_type") or "",
                        "source": record.get("_source_id") or "",
                        "total_price": to_number(values.get("總價元")),
                        "unit_price": to_number(values.get("單價元平方公尺")),
                    }
                )

        communities = []
        for name, rows in community_rows.items():
            town_counts: dict[str, int] = defaultdict(int)
            shard_counts: dict[str, int] = defaultdict(int)
            targets: dict[str, int] = defaultdict(int)
            for row in rows:
                town_counts[row["township"]] += 1
                shard_counts[row["shard"]] += 1
                targets[row["target"] or "未知"] += 1
            stats = compact_stats(rows)
            township = max(town_counts.items(), key=lambda item: item[1])[0]
            shard = max(shard_counts.items(), key=lambda item: item[1])[0]
            samples = sorted(rows, key=lambda row: row["date"], reverse=True)[:5]
            communities.append(
                {
                    "name": name,
                    "city": city["city_name"],
                    "township": township,
                    "shard": shard,
                    "townships": dict(sorted(town_counts.items())),
                    "targets": dict(sorted(targets.items(), key=lambda item: item[1], reverse=True)[:6]),
                    "stats": stats,
                    "samples": samples,
                    "search_text": " ".join(
                        [
                            name,
                            city["city_name"],
                            township,
                            " ".join(town_counts.keys()),
                            " ".join(row["address"] for row in samples),
                            " ".join(row["source"] for row in samples),
                        ]
                    ),
                }
            )

        communities.sort(key=lambda item: (item["stats"]["count"], item["stats"]["latest_date"]), reverse=True)
        output_path = args.output_dir / f"{city['city_code']}_{city['city_name']}.json.gz"
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "city_code": city["city_code"],
            "city_name": city["city_name"],
            "community_count": len(communities),
            "communities": communities,
        }
        size = write_gzip_json(output_path, payload)
        city_outputs.append(
            {
                "city_code": city["city_code"],
                "city_name": city["city_name"],
                "community_count": len(communities),
                "shard": output_path.as_posix(),
                "compressed_bytes": size,
            }
        )

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asset_format": "gzip-compressed city community indexes",
        "cities": city_outputs,
        "total_communities": sum(item["community_count"] for item in city_outputs),
    }
    args.output_index.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(city_outputs)} community city indexes with {summary['total_communities']} communities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
