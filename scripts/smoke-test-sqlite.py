#!/usr/bin/env python3
"""Smoke-test generated SQLite assets before deployment."""

from __future__ import annotations

import gzip
import json
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def open_gzip_sqlite(path: Path) -> sqlite3.Connection:
    tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    with gzip.open(path, "rb") as src, tmp_path.open("wb") as dst:
        dst.write(src.read())
    return sqlite3.connect(tmp_path)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def scalar(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> object:
    return conn.execute(sql, params).fetchone()[0]


def open_district(metadata_city: dict, district: str) -> sqlite3.Connection:
    shard = (metadata_city.get("districts") or {}).get(district)
    assert_true(bool(shard), f"metadata must include {district} shard")
    return open_gzip_sqlite(ROOT / shard["gzip"])


def main() -> int:
    metadata = json.loads((ROOT / "data/db/metadata.json").read_text(encoding="utf-8"))
    changhua = metadata["cities"].get("彰化縣")
    assert_true(bool(changhua), "metadata must include 彰化縣")
    assert_true(changhua.get("slug") == "changhua", "彰化縣 slug must be changhua")

    index_conn = open_gzip_sqlite(ROOT / metadata["index"]["gzip"])
    index_hit = scalar(index_conn, "SELECT COUNT(*) FROM communities WHERE community_name = ?", ("漢寶新宿",))
    assert_true(index_hit >= 1, "index DB must resolve 漢寶新宿")
    index_conn.close()

    assert_true(changhua.get("shardMode") == "district", "彰化 must use district shards")
    total_rows = sum((item.get("transactionCount") or 0) for item in (changhua.get("shards") or []))
    assert_true(total_rows > 100000, "彰化 district shards must contain transactions")

    city_conn = open_district(changhua, "芳苑鄉")
    assert_true(scalar(city_conn, "SELECT COUNT(*) FROM transactions") > 0, "芳苑 shard must contain transactions")
    assert_true(scalar(city_conn, "SELECT COUNT(*) FROM fts_all") > 0, "fts_all must be populated")
    assert_true(scalar(city_conn, "SELECT COUNT(*) FROM community_summary") > 0, "community_summary must be populated")

    hanbao = city_conn.execute(
        """
        SELECT district, building_no, unit_price_ping
        FROM transactions
        WHERE community_name = '漢寶新宿'
        ORDER BY transaction_date DESC
        LIMIT 1
        """
    ).fetchone()
    assert_true(bool(hanbao), "漢寶新宿 must exist in city DB")
    assert_true(hanbao[0] == "芳苑鄉", "漢寶新宿 must resolve 彰化縣 / 芳苑鄉")
    assert_true(bool(hanbao[1]), "交易明細 must include 棟及號")
    assert_true((hanbao[2] or 0) > 0, "unit_price_ping must be populated")

    city_conn.close()

    city_conn = open_district(changhua, "社頭鄉")
    gaotie = city_conn.execute(
        """
        SELECT district, COUNT(*)
        FROM transactions
        WHERE community_name = '高鐵湛' OR full_address LIKE '%高鐵北二路%'
        GROUP BY district
        ORDER BY COUNT(*) DESC
        """
    ).fetchone()
    assert_true(bool(gaotie), "高鐵湛 / 高鐵北二路 must exist in city DB")
    assert_true(gaotie[0] == "社頭鄉", "高鐵湛 must resolve 彰化縣 / 社頭鄉")

    batch_hit = scalar(city_conn, "SELECT COUNT(*) FROM transactions WHERE source_batch = '115S1'")
    assert_true(batch_hit > 0, "source batch 115S1 must be searchable")

    city_conn.close()

    city_conn = open_district(changhua, "員林市")
    jiemei = city_conn.execute(
        """
        SELECT district, COUNT(*)
        FROM transactions
        WHERE community_name = '傑盟天第'
        GROUP BY district
        """
    ).fetchone()
    assert_true(bool(jiemei), "傑盟天第 must exist in city DB")
    assert_true(jiemei[0] == "員林市", "傑盟天第 must resolve 彰化縣 / 員林市")

    token_hit = scalar(city_conn, "SELECT COUNT(*) FROM fts_all WHERE community_name MATCH '傑盟天第'")
    assert_true(token_hit > 0, "傑盟天第 must be in FTS")
    city_conn.close()
    print("SQLite smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
