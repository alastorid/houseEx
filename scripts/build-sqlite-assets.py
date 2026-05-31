#!/usr/bin/env python3
"""Build SQLite assets for PLVR WASM queries."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import shutil
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


M2_PER_PING = 3.305785


def to_number(value: object) -> float:
    try:
        return float(str(value or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def normalize_text(value: object) -> str:
    text = str(value or "").strip().replace(" ", "")
    return "".join(chr(ord(ch) - 0xFEE0) if "０" <= ch <= "９" else ch for ch in text)


def tw_date(value: object) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(digits) < 6:
        return ""
    year = int(digits[:-4]) + 1911
    return f"{year:04d}-{digits[-4:-2]}-{digits[-2:]}"


def quarter_of(date: str) -> str:
    if len(date) < 7:
        return ""
    month = int(date[5:7])
    return f"{date[:4]}Q{math.ceil(month / 3)}"


def median(values: list[float]) -> float:
    nums = sorted(v for v in values if v)
    if not nums:
        return 0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2


def read_json_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def gzip_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    with source.open("rb") as src, gzip.open(tmp, "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    tmp.replace(target)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_position(city: str, district: str, address: str, seed: str) -> tuple[float, float]:
    centers = {
        "彰化縣|社頭鄉": (23.8967, 120.5898),
        "彰化縣|芳苑鄉": (23.9245, 120.3318),
        "彰化縣": (24.0753, 120.5443),
    }
    lat, lng = centers.get(f"{city}|{district}", centers.get(city, (23.7, 121.0)))
    digest = hashlib.sha1(f"{address}|{seed}".encode("utf-8")).digest()
    angle = int.from_bytes(digest[:2], "big") / 65535 * math.tau
    radius = 0.0015 + digest[2] / 255 * 0.005
    return lat + math.sin(angle) * radius, lng + math.cos(angle) * radius


def road_of(address: str) -> str:
    for suffix in ("大道", "路", "街", "段", "巷"):
        idx = address.find(suffix)
        if idx > 0:
            start = max(address.rfind(ch, 0, idx) + 1 for ch in "縣市鄉鎮區村里")
            return address[start : idx + len(suffix)]
    return ""


def schema(conn: sqlite3.Connection, include_transactions: bool) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = MEMORY;

        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS cities (
          city TEXT PRIMARY KEY,
          city_code TEXT,
          db_path TEXT,
          gzip_path TEXT,
          compressed_bytes INTEGER,
          hash TEXT
        );

        CREATE TABLE IF NOT EXISTS districts (
          city TEXT,
          district TEXT,
          record_count INTEGER,
          shard TEXT,
          PRIMARY KEY (city, district)
        );

        CREATE TABLE IF NOT EXISTS communities (
          community_id TEXT PRIMARY KEY,
          community_name TEXT,
          city TEXT,
          district TEXT,
          sample_address TEXT,
          transaction_count INTEGER,
          avg_total_price REAL,
          median_total_price REAL,
          avg_unit_price_ping REAL,
          median_unit_price_ping REAL,
          min_unit_price_ping REAL,
          max_unit_price_ping REAL,
          latest_transaction_date TEXT,
          lat REAL,
          lng REAL,
          shard TEXT,
          search_text TEXT
        );

        CREATE TABLE IF NOT EXISTS search_index (
          token TEXT,
          target_type TEXT,
          target_id TEXT,
          display_text TEXT,
          city TEXT,
          district TEXT,
          rank_score REAL
        );

        CREATE INDEX IF NOT EXISTS idx_comm_city_district ON communities(city, district);
        CREATE INDEX IF NOT EXISTS idx_comm_name ON communities(community_name);
        CREATE INDEX IF NOT EXISTS idx_comm_price ON communities(median_unit_price_ping);
        CREATE INDEX IF NOT EXISTS idx_comm_count ON communities(transaction_count);
        CREATE INDEX IF NOT EXISTS idx_search_token ON search_index(token);
        """
    )
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_communities USING fts5(
              community_name, city, district, sample_address, search_text,
              content='communities', content_rowid='rowid'
            )
            """
        )
    except sqlite3.OperationalError:
        pass

    if not include_transactions:
        return

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          city TEXT,
          district TEXT,
          village TEXT,
          road TEXT,
          full_address TEXT,
          house_number TEXT,
          building_no TEXT,
          community_name TEXT,
          transaction_date TEXT,
          year INTEGER,
          quarter TEXT,
          total_price REAL,
          unit_price_m2 REAL,
          unit_price_ping REAL,
          building_area_m2 REAL,
          building_area_ping REAL,
          land_area_m2 REAL,
          land_area_ping REAL,
          property_type TEXT,
          transaction_target TEXT,
          has_parking INTEGER,
          parking_price REAL,
          building_age REAL,
          floor TEXT,
          total_floor TEXT,
          source_batch TEXT,
          lat REAL,
          lng REAL,
          raw_json TEXT
        );

        CREATE TABLE IF NOT EXISTS repeat_sales (
          repeat_id TEXT PRIMARY KEY,
          full_address TEXT,
          city TEXT,
          district TEXT,
          community_name TEXT,
          first_transaction_id TEXT,
          last_transaction_id TEXT,
          first_date TEXT,
          last_date TEXT,
          first_price REAL,
          last_price REAL,
          price_diff REAL,
          price_diff_pct REAL,
          holding_days INTEGER,
          annualized_return REAL
        );

        CREATE INDEX IF NOT EXISTS idx_tx_city_district ON transactions(city, district);
        CREATE INDEX IF NOT EXISTS idx_tx_community ON transactions(community_name);
        CREATE INDEX IF NOT EXISTS idx_tx_address ON transactions(full_address);
        CREATE INDEX IF NOT EXISTS idx_tx_building_no ON transactions(building_no);
        CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
        CREATE INDEX IF NOT EXISTS idx_tx_price ON transactions(total_price);
        CREATE INDEX IF NOT EXISTS idx_tx_unit_ping ON transactions(unit_price_ping);
        CREATE INDEX IF NOT EXISTS idx_tx_lat_lng ON transactions(lat, lng);
        """
    )
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_transactions USING fts5(
              community_name, full_address, building_no, city, district, source_batch,
              content='transactions', content_rowid='rowid'
            )
            """
        )
    except sqlite3.OperationalError:
        pass


def insert_community(conn: sqlite3.Connection, item: dict) -> str:
    stats = item.get("stats") or {}
    name = item.get("name") or ""
    city = item.get("city") or ""
    district = item.get("township") or ""
    community_id = hashlib.sha1(f"{city}|{district}|{name}".encode("utf-8")).hexdigest()[:16]
    sample_address = next((sample.get("address") for sample in item.get("samples", []) if sample.get("address")), "")
    lat, lng = stable_position(city, district, sample_address, name)
    median_unit_ping = (stats.get("median_unit_price") or 0) * M2_PER_PING
    avg_unit_ping = (stats.get("avg_unit_price") or 0) * M2_PER_PING
    conn.execute(
        """
        INSERT OR REPLACE INTO communities VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            community_id,
            name,
            city,
            district,
            sample_address,
            stats.get("count") or 0,
            stats.get("avg_total_price") or 0,
            stats.get("median_total_price") or 0,
            avg_unit_ping,
            median_unit_ping,
            0,
            0,
            stats.get("latest_date") or "",
            lat,
            lng,
            item.get("shard") or "",
            item.get("search_text") or "",
        ),
    )
    tokens = {name, city, district, sample_address}
    for token in tokens:
        if token:
            conn.execute(
                "INSERT INTO search_index VALUES (?,?,?,?,?,?,?)",
                (normalize_text(token), "community", community_id, name, city, district, stats.get("count") or 0),
            )
    return community_id


def transaction_row(record: dict, index: int) -> tuple:
    values = record.get("values") or {}
    city = record.get("city_name") or ""
    district = values.get("鄉鎮市區") or ""
    full_address = values.get("土地位置建物門牌") or values.get("土地位置") or ""
    building_no = values.get("棟及號") or ""
    community_name = values.get("建案名稱") or ""
    date = tw_date(values.get("交易年月日"))
    year = int(date[:4]) if date else 0
    total_price = to_number(values.get("總價元"))
    unit_m2 = to_number(values.get("單價元平方公尺"))
    building_m2 = to_number(values.get("建物移轉總面積平方公尺") or values.get("建物移轉面積平方公尺"))
    land_m2 = to_number(values.get("土地移轉總面積平方公尺"))
    parking_price = to_number(values.get("車位總價元") or values.get("車位價格"))
    has_parking = 1 if "車位" in f"{values.get('交易筆棟數','')}{values.get('車位類別','')}{record.get('table_kind','')}" else 0
    tx_id = values.get("編號") or hashlib.sha1(
        f"{record.get('_source_id')}|{record.get('_file')}|{index}|{full_address}|{building_no}|{date}|{total_price}".encode("utf-8")
    ).hexdigest()
    lat, lng = stable_position(city, district, full_address, building_no or tx_id)
    return (
        tx_id,
        city,
        district,
        "",
        road_of(full_address),
        full_address,
        "",
        building_no,
        community_name,
        date,
        year,
        quarter_of(date),
        total_price,
        unit_m2,
        unit_m2 * M2_PER_PING if unit_m2 else 0,
        building_m2,
        building_m2 / M2_PER_PING if building_m2 else 0,
        land_m2,
        land_m2 / M2_PER_PING if land_m2 else 0,
        values.get("建物型態") or "",
        values.get("交易標的") or record.get("transaction_type") or "",
        has_parking,
        parking_price,
        0,
        values.get("移轉層次") or "",
        values.get("總樓層數") or "",
        record.get("_source_id") or "",
        lat,
        lng,
        json.dumps(record, ensure_ascii=False, separators=(",", ":")),
    )


def build_index_db(args: argparse.Namespace, metadata: dict) -> Path:
    out = args.output_dir / "index.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    conn = sqlite3.connect(out)
    schema(conn, include_transactions=False)
    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ("version", metadata["version"]))
    web_index = json.loads(args.web_index.read_text(encoding="utf-8"))
    for city in web_index.get("cities", []):
        conn.execute("INSERT OR REPLACE INTO cities VALUES (?,?,?,?,?,?)", (city["city_name"], city["city_code"], "", "", 0, ""))
        for town in city.get("townships", []):
            conn.execute(
                "INSERT OR REPLACE INTO districts VALUES (?,?,?,?)",
                (city["city_name"], town["township"], town.get("record_count") or 0, town.get("shard") or ""),
            )
    community_index = json.loads(args.community_index.read_text(encoding="utf-8"))
    for city in community_index.get("cities", []):
        payload = read_json_gz(Path(city["shard"]))
        for item in payload.get("communities", []):
            insert_community(conn, item)
    conn.execute("INSERT INTO fts_communities(fts_communities) VALUES ('rebuild')")
    conn.commit()
    conn.execute("ANALYZE")
    conn.execute("PRAGMA optimize")
    conn.execute("VACUUM")
    conn.close()
    gzip_file(out, out.with_suffix(".sqlite.gz"))
    return out


def build_city_db(city: dict, args: argparse.Namespace, metadata: dict) -> dict:
    safe_name = city["city_code"]
    out = args.output_dir / "city" / f"{safe_name}.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    conn = sqlite3.connect(out)
    schema(conn, include_transactions=True)
    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ("version", metadata["version"]))
    community_payload = read_json_gz(Path(next(c["shard"] for c in json.loads(args.community_index.read_text(encoding="utf-8"))["cities"] if c["city_name"] == city["city_name"])))
    for item in community_payload.get("communities", []):
        insert_community(conn, item)
    insert_sql = "INSERT OR REPLACE INTO transactions VALUES (" + ",".join("?" for _ in range(30)) + ")"
    count = 0
    for town in city.get("townships", []):
        shard = Path(town["shard"])
        if not shard.exists():
            continue
        data = read_json_gz(shard)
        for idx, record in enumerate(data.get("records", [])):
            if record.get("table_kind") != "主檔":
                continue
            conn.execute(insert_sql, transaction_row(record, idx))
            count += 1
        conn.commit()
    conn.execute("INSERT INTO fts_transactions(fts_transactions) VALUES ('rebuild')")
    conn.execute("INSERT INTO fts_communities(fts_communities) VALUES ('rebuild')")
    conn.commit()
    conn.execute("ANALYZE")
    conn.execute("PRAGMA optimize")
    conn.execute("VACUUM")
    conn.close()
    gz = out.with_suffix(".sqlite.gz")
    gzip_file(out, gz)
    return {
        "city": city["city_name"],
        "city_code": city["city_code"],
        "db": out.as_posix(),
        "gzip": gz.as_posix(),
        "size": out.stat().st_size,
        "compressed_bytes": gz.stat().st_size,
        "hash": file_hash(gz),
        "transaction_count": count,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-index", type=Path, default=Path("data/plvr/web-index.json"))
    parser.add_argument("--community-index", type=Path, default=Path("data/plvr/community-index.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/db"))
    parser.add_argument("--cities", default="", help="Comma-separated city names/codes, or 'all'. Empty builds index only.")
    args = parser.parse_args()

    version = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    metadata = {"version": version, "generated_at": datetime.now(timezone.utc).isoformat(), "cities": {}}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    index_db = build_index_db(args, metadata)
    metadata["index"] = {
        "db": index_db.as_posix(),
        "gzip": index_db.with_suffix(".sqlite.gz").as_posix(),
        "size": index_db.stat().st_size,
        "compressed_bytes": index_db.with_suffix(".sqlite.gz").stat().st_size,
        "hash": file_hash(index_db.with_suffix(".sqlite.gz")),
    }

    requested = {item.strip() for item in args.cities.split(",") if item.strip()}
    web_index = json.loads(args.web_index.read_text(encoding="utf-8"))
    for city in web_index.get("cities", []):
        if requested != {"all"} and requested and city["city_name"] not in requested and city["city_code"] not in requested:
            continue
        if not requested:
            continue
        info = build_city_db(city, args, metadata)
        metadata["cities"][info["city"]] = info

    metadata_path = args.output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote SQLite metadata: {metadata_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
