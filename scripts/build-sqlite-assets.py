#!/usr/bin/env python3
"""Build SQLite assets for PLVR WASM queries."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import shutil
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


M2_PER_PING = 3.305785

CITY_SLUGS = {
    "臺北市": "taipei",
    "台北市": "taipei",
    "新北市": "new-taipei",
    "桃園市": "taoyuan",
    "臺中市": "taichung",
    "台中市": "taichung",
    "臺南市": "tainan",
    "台南市": "tainan",
    "高雄市": "kaohsiung",
    "基隆市": "keelung",
    "新竹市": "hsinchu-city",
    "新竹縣": "hsinchu-county",
    "苗栗縣": "miaoli",
    "彰化縣": "changhua",
    "南投縣": "nantou",
    "雲林縣": "yunlin",
    "嘉義市": "chiayi-city",
    "嘉義縣": "chiayi-county",
    "屏東縣": "pingtung",
    "宜蘭縣": "yilan",
    "花蓮縣": "hualien",
    "臺東縣": "taitung",
    "台東縣": "taitung",
    "澎湖縣": "penghu",
    "金門縣": "kinmen",
    "連江縣": "lienchiang",
}

SIZE_BUDGETS = {
    "index.sqlite.gz": 25 * 1024 * 1024,
    "shard.sqlite.gz": 45 * 1024 * 1024,
    "script.js": 300 * 1024,
    "styles.css": 80 * 1024,
}

COMMUNITY_OVERRIDES: list[dict] = []
COMMUNITY_ITEMS_CACHE: dict[str, list[dict]] = {}


def to_number(value: object) -> float:
    try:
        return float(str(value or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", "", text)


def normalize_address(value: object) -> str:
    return (
        normalize_text(value)
        .replace("巿", "市")
        .replace("臺", "台")
        .replace("員林鎮", "員林市")
    )


def load_overrides(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def override_name(city: str, district: str, address: str) -> str:
    normalized = normalize_address(address)
    for item in COMMUNITY_OVERRIDES:
        if item.get("city") != city or item.get("district") != district:
            continue
        road = item.get("road") or ""
        if road and road not in normalized:
            continue
        numbers = {int(number) for number in item.get("numbers", [])}
        if numbers:
            match = re.search(rf"{re.escape(road)}(\d+)號", normalized)
            if not match or int(match.group(1)) not in numbers:
                continue
        return item.get("name") or ""
    return ""


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


def city_slug(city_name: str, city_code: str = "") -> str:
    return CITY_SLUGS.get(city_name) or normalize_text(city_code or city_name).lower() or "city"


def district_slug(district: str) -> str:
    digest = hashlib.sha1(normalize_text(district).encode("utf-8")).hexdigest()[:8]
    ascii_hint = re.sub(r"[^a-z0-9]+", "-", normalize_text(district).lower()).strip("-")
    return ascii_hint or digest


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

        CREATE TABLE IF NOT EXISTS community_summary (
          community_name TEXT,
          city TEXT,
          district TEXT,
          transaction_count INTEGER,
          avg_total_price REAL,
          median_total_price REAL,
          avg_unit_price_ping REAL,
          min_unit_price_ping REAL,
          max_unit_price_ping REAL,
          latest_transaction_date TEXT,
          lat REAL,
          lng REAL
        );

        CREATE TABLE IF NOT EXISTS district_summary (
          city TEXT,
          district TEXT,
          transaction_count INTEGER,
          avg_total_price REAL,
          avg_unit_price_ping REAL,
          min_unit_price_ping REAL,
          max_unit_price_ping REAL,
          latest_transaction_date TEXT
        );

        CREATE TABLE IF NOT EXISTS monthly_summary (
          city TEXT,
          district TEXT,
          month TEXT,
          transaction_count INTEGER,
          avg_total_price REAL,
          avg_unit_price_ping REAL
        );

        CREATE TABLE IF NOT EXISTS repeat_sales_summary (
          full_address TEXT,
          building_no TEXT,
          city TEXT,
          district TEXT,
          community_name TEXT,
          transaction_count INTEGER,
          first_date TEXT,
          last_date TEXT,
          first_price REAL,
          last_price REAL,
          price_diff REAL
        );

        CREATE TABLE IF NOT EXISTS price_bucket_summary (
          city TEXT,
          district TEXT,
          bucket TEXT,
          transaction_count INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_tx_city_district ON transactions(city, district);
        CREATE INDEX IF NOT EXISTS idx_tx_community ON transactions(community_name);
        CREATE INDEX IF NOT EXISTS idx_tx_address ON transactions(full_address);
        CREATE INDEX IF NOT EXISTS idx_tx_building_no ON transactions(building_no);
        CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
        CREATE INDEX IF NOT EXISTS idx_tx_price ON transactions(total_price);
        CREATE INDEX IF NOT EXISTS idx_tx_unit_ping ON transactions(unit_price_ping);
        CREATE INDEX IF NOT EXISTS idx_tx_lat_lng ON transactions(lat, lng);
        CREATE INDEX IF NOT EXISTS idx_summary_comm ON community_summary(city, district, community_name);
        CREATE INDEX IF NOT EXISTS idx_summary_district ON district_summary(city, district);
        CREATE INDEX IF NOT EXISTS idx_summary_monthly ON monthly_summary(city, district, month);
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
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_all USING fts5(
              id UNINDEXED,
              community_name,
              full_address,
              building_no,
              city,
              district,
              road,
              source_batch,
              raw_text
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
    if name:
        compact = normalize_text(name)
        for size in range(2, min(5, len(compact)) + 1):
            for index in range(0, len(compact) - size + 1):
                tokens.add(compact[index : index + size])
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
    full_address = normalize_address(values.get("土地位置建物門牌") or values.get("土地位置") or "")
    building_no = values.get("棟及號") or ""
    community_name = values.get("建案名稱") or override_name(city, district, full_address)
    date = tw_date(values.get("交易年月日"))
    year = int(date[:4]) if date else 0
    total_price = to_number(values.get("總價元"))
    unit_m2 = to_number(values.get("單價元平方公尺"))
    building_m2 = to_number(values.get("建物移轉總面積平方公尺") or values.get("建物移轉面積平方公尺"))
    land_m2 = to_number(values.get("土地移轉總面積平方公尺"))
    parking_price = to_number(values.get("車位總價元") or values.get("車位價格"))
    has_parking = 1 if "車位" in f"{values.get('交易筆棟數','')}{values.get('車位類別','')}{record.get('table_kind','')}" else 0
    base_id = values.get("編號") or ""
    tx_id = hashlib.sha1(
        f"{record.get('_source_id')}|{record.get('_file')}|{index}|{base_id}|{full_address}|{building_no}|{date}|{total_price}".encode("utf-8")
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


def insert_fts_all(conn: sqlite3.Connection, tx: tuple) -> None:
    raw = json.loads(tx[29] or "{}")
    raw_text = " ".join(f"{key}:{value}" for key, value in (raw.get("values") or {}).items())
    conn.execute(
        "INSERT INTO fts_all VALUES (?,?,?,?,?,?,?,?,?)",
        (tx[0], tx[8], tx[5], tx[7], tx[1], tx[2], tx[4], tx[26], raw_text),
    )


def populate_summary_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DELETE FROM community_summary;
        INSERT INTO community_summary
        SELECT community_name, city, district, COUNT(*), AVG(total_price), 0,
               AVG(unit_price_ping), MIN(unit_price_ping), MAX(unit_price_ping),
               MAX(transaction_date), AVG(lat), AVG(lng)
        FROM transactions
        WHERE community_name <> ''
        GROUP BY city, district, community_name;

        DELETE FROM district_summary;
        INSERT INTO district_summary
        SELECT city, district, COUNT(*), AVG(total_price), AVG(unit_price_ping),
               MIN(unit_price_ping), MAX(unit_price_ping), MAX(transaction_date)
        FROM transactions
        GROUP BY city, district;

        DELETE FROM monthly_summary;
        INSERT INTO monthly_summary
        SELECT city, district, substr(transaction_date, 1, 7), COUNT(*),
               AVG(total_price), AVG(unit_price_ping)
        FROM transactions
        WHERE transaction_date <> ''
        GROUP BY city, district, substr(transaction_date, 1, 7);

        DELETE FROM repeat_sales_summary;
        INSERT INTO repeat_sales_summary
        SELECT full_address, building_no, city, district, community_name, COUNT(*),
               MIN(transaction_date), MAX(transaction_date), MIN(total_price),
               MAX(total_price), MAX(total_price) - MIN(total_price)
        FROM transactions
        GROUP BY city, district, full_address, building_no
        HAVING COUNT(*) > 1;

        DELETE FROM price_bucket_summary;
        INSERT INTO price_bucket_summary
        SELECT city, district,
               CASE
                 WHEN unit_price_ping <= 100000 THEN '<=10萬/坪'
                 WHEN unit_price_ping <= 200000 THEN '10-20萬/坪'
                 WHEN unit_price_ping <= 400000 THEN '20-40萬/坪'
                 WHEN unit_price_ping <= 600000 THEN '40-60萬/坪'
                 ELSE '>60萬/坪'
               END,
               COUNT(*)
        FROM transactions
        WHERE unit_price_ping > 0
        GROUP BY city, district, 3;
        """
    )


def city_qa(conn: sqlite3.Connection, city_name: str) -> dict:
    def scalar(sql: str) -> int:
        return conn.execute(sql).fetchone()[0] or 0

    return {
        "city": city_name,
        "totalRows": scalar("SELECT COUNT(*) FROM transactions"),
        "rowsMissingPrice": scalar("SELECT COUNT(*) FROM transactions WHERE total_price <= 0"),
        "rowsMissingAddress": scalar("SELECT COUNT(*) FROM transactions WHERE full_address = ''"),
        "rowsMissingLatLng": scalar("SELECT COUNT(*) FROM transactions WHERE lat IS NULL OR lng IS NULL OR lat = 0 OR lng = 0"),
        "duplicatedTransactionCandidates": scalar(
            """
            SELECT COUNT(*) FROM (
              SELECT full_address, building_no, transaction_date, total_price, COUNT(*) c
              FROM transactions
              GROUP BY full_address, building_no, transaction_date, total_price
              HAVING c > 1
            )
            """
        ),
        "abnormalUnitPrice": scalar("SELECT COUNT(*) FROM transactions WHERE unit_price_ping > 2000000 OR unit_price_ping BETWEEN 1 AND 10000"),
        "abnormalBuildingArea": scalar("SELECT COUNT(*) FROM transactions WHERE building_area_ping > 500 OR building_area_ping BETWEEN 0.01 AND 1"),
        "cityDistrictMismatch": 0,
        "sourceBatchCount": dict(conn.execute("SELECT source_batch, COUNT(*) FROM transactions GROUP BY source_batch").fetchall()),
    }


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
    safe_name = city_slug(city["city_name"], city.get("city_code") or "")
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
            tx = transaction_row(record, idx)
            conn.execute(insert_sql, tx)
            insert_fts_all(conn, tx)
            count += 1
        conn.commit()
    populate_summary_tables(conn)
    conn.execute("INSERT INTO fts_transactions(fts_transactions) VALUES ('rebuild')")
    conn.execute("INSERT INTO fts_communities(fts_communities) VALUES ('rebuild')")
    conn.commit()
    qa = city_qa(conn, city["city_name"])
    transaction_count = qa["totalRows"]
    community_count = conn.execute("SELECT COUNT(*) FROM communities").fetchone()[0] or 0
    min_date = conn.execute("SELECT MIN(transaction_date) FROM transactions WHERE transaction_date <> ''").fetchone()[0] or ""
    max_date = conn.execute("SELECT MAX(transaction_date) FROM transactions WHERE transaction_date <> ''").fetchone()[0] or ""
    conn.execute("ANALYZE")
    conn.execute("PRAGMA optimize")
    conn.execute("VACUUM")
    conn.close()
    gz = out.with_suffix(".sqlite.gz")
    gzip_file(out, gz)
    return {
        "city": city["city_name"],
        "slug": safe_name,
        "city_code": city["city_code"],
        "db": out.as_posix(),
        "gzip": gz.as_posix(),
        "path": gz.as_posix(),
        "size": out.stat().st_size,
        "compressedBytes": gz.stat().st_size,
        "compressed_bytes": gz.stat().st_size,
        "uncompressedBytes": out.stat().st_size,
        "hash": file_hash(gz),
        "transactionCount": transaction_count,
        "transaction_count": transaction_count,
        "communityCount": community_count,
        "minDate": min_date,
        "maxDate": max_date,
        "qa": qa,
    }


def community_items_for_city(args: argparse.Namespace, city_name: str) -> list[dict]:
    if city_name in COMMUNITY_ITEMS_CACHE:
        return COMMUNITY_ITEMS_CACHE[city_name]
    community_index = json.loads(args.community_index.read_text(encoding="utf-8"))
    shard = next(c["shard"] for c in community_index["cities"] if c["city_name"] == city_name)
    COMMUNITY_ITEMS_CACHE[city_name] = read_json_gz(Path(shard)).get("communities", [])
    return COMMUNITY_ITEMS_CACHE[city_name]


def build_transaction_db(city: dict, towns: list[dict], out: Path, args: argparse.Namespace, metadata: dict, record_filter=None) -> tuple[dict, dict]:
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    conn = sqlite3.connect(out)
    schema(conn, include_transactions=True)
    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ("version", metadata["version"]))
    districts = {town.get("township") for town in towns}
    for item in community_items_for_city(args, city["city_name"]):
        if item.get("township") in districts:
            insert_community(conn, item)
    insert_sql = "INSERT OR REPLACE INTO transactions VALUES (" + ",".join("?" for _ in range(30)) + ")"
    count = 0
    for town in towns:
        shard = Path(town["shard"])
        if not shard.exists():
            continue
        data = read_json_gz(shard)
        for idx, record in enumerate(data.get("records", [])):
            if record.get("table_kind") != "主檔":
                continue
            if record_filter and not record_filter(record, idx):
                continue
            tx = transaction_row(record, idx)
            conn.execute(insert_sql, tx)
            insert_fts_all(conn, tx)
            count += 1
        conn.commit()
    populate_summary_tables(conn)
    conn.execute("INSERT INTO fts_transactions(fts_transactions) VALUES ('rebuild')")
    conn.execute("INSERT INTO fts_communities(fts_communities) VALUES ('rebuild')")
    conn.commit()
    qa = city_qa(conn, city["city_name"])
    transaction_count = qa["totalRows"]
    community_count = conn.execute("SELECT COUNT(*) FROM communities").fetchone()[0] or 0
    min_date = conn.execute("SELECT MIN(transaction_date) FROM transactions WHERE transaction_date <> ''").fetchone()[0] or ""
    max_date = conn.execute("SELECT MAX(transaction_date) FROM transactions WHERE transaction_date <> ''").fetchone()[0] or ""
    conn.execute("ANALYZE")
    conn.execute("PRAGMA optimize")
    conn.execute("VACUUM")
    conn.close()
    gz = out.with_suffix(".sqlite.gz")
    gzip_file(out, gz)
    info = {
        "db": out.as_posix(),
        "gzip": gz.as_posix(),
        "path": gz.as_posix(),
        "size": out.stat().st_size,
        "compressedBytes": gz.stat().st_size,
        "compressed_bytes": gz.stat().st_size,
        "uncompressedBytes": out.stat().st_size,
        "hash": file_hash(gz),
        "transactionCount": transaction_count,
        "transaction_count": transaction_count,
        "communityCount": community_count,
        "minDate": min_date,
        "maxDate": max_date,
        "qa": qa,
    }
    return info, qa


def build_district_shards(city: dict, args: argparse.Namespace, metadata: dict) -> dict:
    safe_name = city_slug(city["city_name"], city.get("city_code") or "")
    city_dir = args.output_dir / "district" / safe_name
    if city_dir.exists():
        for old in city_dir.glob("*.sqlite*"):
            old.unlink()
    city_dir.mkdir(parents=True, exist_ok=True)
    shards = []
    total_rows = 0
    total_communities = 0
    min_dates = []
    max_dates = []
    qa_total = {
        "city": city["city_name"],
        "totalRows": 0,
        "rowsMissingPrice": 0,
        "rowsMissingAddress": 0,
        "rowsMissingLatLng": 0,
        "duplicatedTransactionCandidates": 0,
        "abnormalUnitPrice": 0,
        "abnormalBuildingArea": 0,
        "cityDistrictMismatch": 0,
        "sourceBatchCount": {},
    }
    def add_shard(shard_info: dict, qa: dict) -> None:
        nonlocal total_rows, total_communities
        source_counts = qa.get("sourceBatchCount") or {}
        for key, value in source_counts.items():
            qa_total["sourceBatchCount"][key] = qa_total["sourceBatchCount"].get(key, 0) + value
        for key in ("totalRows", "rowsMissingPrice", "rowsMissingAddress", "rowsMissingLatLng", "duplicatedTransactionCandidates", "abnormalUnitPrice", "abnormalBuildingArea", "cityDistrictMismatch"):
            qa_total[key] += qa.get(key, 0)
        total_rows += shard_info["transactionCount"]
        total_communities += shard_info["communityCount"]
        if shard_info["minDate"]:
            min_dates.append(shard_info["minDate"])
        if shard_info["maxDate"]:
            max_dates.append(shard_info["maxDate"])
        shards.append(shard_info)

    for town in city.get("townships", []):
        district = town.get("township") or "unknown"
        slug = district_slug(district)
        out = city_dir / f"{slug}.sqlite"
        info, qa = build_transaction_db(city, [town], out, args, metadata)
        if info["compressedBytes"] > SIZE_BUDGETS["shard.sqlite.gz"]:
            Path(info["db"]).unlink(missing_ok=True)
            Path(info["gzip"]).unlink(missing_ok=True)
            bucket_count = max(2, math.ceil(info["compressedBytes"] / SIZE_BUDGETS["shard.sqlite.gz"]) + 1)
            for bucket in range(bucket_count):
                bucket_out = city_dir / f"{slug}__{bucket + 1:02d}.sqlite"
                bucket_info, bucket_qa = build_transaction_db(
                    city,
                    [town],
                    bucket_out,
                    args,
                    metadata,
                    record_filter=lambda record, idx, b=bucket, n=bucket_count: int(hashlib.sha1(f"{record.get('_source_id')}|{record.get('_file')}|{idx}|{(record.get('values') or {}).get('編號','')}".encode("utf-8")).hexdigest(), 16) % n == b,
                )
                add_shard({
                    **{key: bucket_info[key] for key in ("db", "gzip", "path", "size", "compressedBytes", "compressed_bytes", "uncompressedBytes", "hash", "transactionCount", "transaction_count", "communityCount", "minDate", "maxDate")},
                    "city": city["city_name"],
                    "district": district,
                    "slug": f"{slug}__{bucket + 1:02d}",
                    "bucket": bucket + 1,
                    "bucketCount": bucket_count,
                    "recordCount": town.get("record_count") or 0,
                }, bucket_qa)
        else:
            add_shard({
                **{key: info[key] for key in ("db", "gzip", "path", "size", "compressedBytes", "compressed_bytes", "uncompressedBytes", "hash", "transactionCount", "transaction_count", "communityCount", "minDate", "maxDate")},
                "city": city["city_name"],
                "district": district,
                "slug": slug,
                "recordCount": town.get("record_count") or 0,
            }, qa)
    districts = {}
    for shard in shards:
        district = shard["district"]
        entry = districts.setdefault(district, {
            "city": city["city_name"],
            "district": district,
            "slug": district_slug(district),
            "shards": [],
            "transactionCount": 0,
            "transaction_count": 0,
            "communityCount": 0,
            "compressedBytes": 0,
            "compressed_bytes": 0,
        })
        entry["shards"].append(shard)
        entry["transactionCount"] += shard.get("transactionCount") or 0
        entry["transaction_count"] = entry["transactionCount"]
        entry["communityCount"] += shard.get("communityCount") or 0
        entry["compressedBytes"] += shard.get("compressedBytes") or 0
        entry["compressed_bytes"] = entry["compressedBytes"]
        if not entry.get("path") and len(entry["shards"]) == 1:
            entry.update({key: shard[key] for key in ("db", "gzip", "path", "size", "uncompressedBytes", "hash", "minDate", "maxDate") if key in shard})
    return {
        "city": city["city_name"],
        "slug": safe_name,
        "city_code": city["city_code"],
        "shardMode": "district",
        "transactionCount": total_rows,
        "transaction_count": total_rows,
        "communityCount": total_communities,
        "minDate": min(min_dates) if min_dates else "",
        "maxDate": max(max_dates) if max_dates else "",
        "districts": districts,
        "shards": shards,
        "qa": qa_total,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-index", type=Path, default=Path("data/plvr/web-index.json"))
    parser.add_argument("--community-index", type=Path, default=Path("data/plvr/community-index.json"))
    parser.add_argument("--community-overrides", type=Path, default=Path("data/community-overrides.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/db"))
    parser.add_argument("--cities", default="", help="Comma-separated city names/codes, or 'all'. Empty builds index only.")
    args = parser.parse_args()

    global COMMUNITY_OVERRIDES
    COMMUNITY_OVERRIDES = load_overrides(args.community_overrides)
    version = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    metadata = {"version": version, "generated_at": datetime.now(timezone.utc).isoformat(), "cities": {}}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    index_db = build_index_db(args, metadata)
    metadata["index"] = {
        "db": index_db.as_posix(),
        "gzip": index_db.with_suffix(".sqlite.gz").as_posix(),
        "path": index_db.with_suffix(".sqlite.gz").as_posix(),
        "size": index_db.stat().st_size,
        "compressedBytes": index_db.with_suffix(".sqlite.gz").stat().st_size,
        "compressed_bytes": index_db.with_suffix(".sqlite.gz").stat().st_size,
        "uncompressedBytes": index_db.stat().st_size,
        "hash": file_hash(index_db.with_suffix(".sqlite.gz")),
    }

    requested = {item.strip() for item in args.cities.split(",") if item.strip()}
    web_index = json.loads(args.web_index.read_text(encoding="utf-8"))
    for city in web_index.get("cities", []):
        if requested != {"all"} and requested and city["city_name"] not in requested and city["city_code"] not in requested:
            continue
        if not requested:
            continue
        info = build_district_shards(city, args, metadata)
        metadata["cities"][info["city"]] = info

    metadata_path = args.output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    qa_report = {
        "generatedAt": metadata["generated_at"],
        "totalRows": sum((info.get("qa") or {}).get("totalRows", 0) for info in metadata["cities"].values()),
        "cities": {city: info.get("qa", {}) for city, info in metadata["cities"].items()},
    }
    (args.output_dir / "qa-report.json").write_text(json.dumps(qa_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    size_report = {
        "generatedAt": metadata["generated_at"],
        "budgets": SIZE_BUDGETS,
        "files": [],
        "warnings": [],
    }
    budget_checks = [
        ("index.sqlite.gz", index_db.with_suffix(".sqlite.gz"), SIZE_BUDGETS["index.sqlite.gz"]),
        ("script.js", Path("script.js"), SIZE_BUDGETS["script.js"]),
        ("styles.css", Path("styles.css"), SIZE_BUDGETS["styles.css"]),
    ]
    for info in metadata["cities"].values():
        for shard in info.get("shards", []):
            budget_checks.append((f"{info['slug']}/{shard['slug']}.sqlite.gz", Path(shard["gzip"]), SIZE_BUDGETS["shard.sqlite.gz"]))
    for label, path, budget in budget_checks:
        if not path.exists():
            continue
        size = path.stat().st_size
        entry = {"file": path.as_posix(), "label": label, "bytes": size, "budgetBytes": budget, "ok": size <= budget}
        size_report["files"].append(entry)
        if not entry["ok"]:
            size_report["warnings"].append(f"{label} is {size} bytes; budget is {budget} bytes")
    (args.output_dir / "size-report.json").write_text(json.dumps(size_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote SQLite metadata: {metadata_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
