#!/usr/bin/env python3
"""Download and index MOI PLVR real-estate open data as frontend-friendly JSON shards."""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import shutil
import ssl
import subprocess
import sys
import time
import zipfile
from collections import OrderedDict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TextIO
from urllib.parse import urlencode
from urllib.request import Request, urlopen


csv.field_size_limit(sys.maxsize)

BASE_URL = "https://plvr.land.moi.gov.tw"
OPEN_DATA_PAGE = f"{BASE_URL}/DownloadOpenData"
ACTIVE_ENDPOINT = f"{BASE_URL}/Download_ajax_active"
HISTORY_ENDPOINT = f"{BASE_URL}/DownloadHistory_ajax_list"
SEASON_ENDPOINT = f"{BASE_URL}/DownloadSeason_ajax_list"

CITY_NAMES = {
    "a": "臺北市",
    "b": "臺中市",
    "c": "基隆市",
    "d": "臺南市",
    "e": "高雄市",
    "f": "新北市",
    "g": "宜蘭縣",
    "h": "桃園市",
    "i": "嘉義市",
    "j": "新竹縣",
    "k": "苗栗縣",
    "m": "南投縣",
    "n": "彰化縣",
    "o": "新竹市",
    "p": "雲林縣",
    "q": "嘉義縣",
    "t": "屏東縣",
    "u": "花蓮縣",
    "v": "臺東縣",
    "w": "金門縣",
    "x": "澎湖縣",
    "z": "連江縣",
}

TRANSACTION_TYPES = {
    "a": "不動產買賣",
    "b": "預售屋買賣",
    "c": "不動產租賃",
}

TABLE_KINDS = {
    "main": "主檔",
    "build": "建物",
    "land": "土地",
    "park": "停車位",
}

REGION_FIELD = "鄉鎮市區"
SOURCE_CACHE_VERSION = 1


@dataclass(frozen=True)
class Source:
    id: str
    kind: str
    label: str
    url: str


def ssl_context(verify_tls: bool) -> ssl.SSLContext | None:
    if verify_tls:
        return None
    return ssl._create_unverified_context()


def fetch_text(url: str, verify_tls: bool) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=90, context=ssl_context(verify_tls)) as res:
        return res.read().decode("utf-8", errors="replace")


def source_url(path: str, params: dict[str, str]) -> str:
    return f"{BASE_URL}/{path}?{urlencode(params)}"


def discover_sources(verify_tls: bool) -> list[Source]:
    history_html = fetch_text(HISTORY_ENDPOINT, verify_tls)
    season_html = fetch_text(SEASON_ENDPOINT, verify_tls)

    release_dates = sorted(set(re.findall(r"downloadLast\('(\d{8})'\)", history_html)))
    seasons = re.findall(r'<option value="(\d{3}S[1-4])">', season_html)

    sources = [
        Source(
            id="current",
            kind="current",
            label="本期下載",
            url=source_url("Download", {"type": "zip", "fileName": "lvr_landcsv.zip"}),
        )
    ]

    for release_date in release_dates:
        sources.append(
            Source(
                id=release_date,
                kind="history",
                label=f"前期下載 {release_date}",
                url=source_url("DownloadHistory", {"type": "history", "fileName": release_date}),
            )
        )

    for season in seasons:
        sources.append(
            Source(
                id=season,
                kind="season",
                label=f"前季下載 {season}",
                url=source_url(
                    "DownloadSeason",
                    {"season": season, "type": "zip", "fileName": "lvr_landcsv.zip"},
                ),
            )
        )

    return sources


def download_with_python(source: Source, target: Path, verify_tls: bool = False) -> None:
    req = Request(source.url, headers={"User-Agent": "Mozilla/5.0"})
    tmp_path = target.with_suffix(target.suffix + ".part")
    with urlopen(req, timeout=300, context=ssl_context(verify_tls)) as res, tmp_path.open("wb") as out:
        while True:
            chunk = res.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    tmp_path.replace(target)


def download_with_aria2c(source: Source, target: Path, verify_tls: bool = False, connections: int = 8) -> bool:
    aria = shutil.which("aria2c")
    if not aria:
        return False
    tmp_path = target.with_suffix(target.suffix + ".part")
    tmp_path.unlink(missing_ok=True)
    Path(f"{tmp_path}.aria2").unlink(missing_ok=True)
    command = [
        aria,
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--continue=true",
        "--file-allocation=none",
        "--summary-interval=0",
        "--console-log-level=warn",
        "--max-connection-per-server",
        str(connections),
        "--split",
        str(connections),
        "--min-split-size=1M",
        "--user-agent=Mozilla/5.0",
        "--dir",
        str(target.parent),
        "--out",
        tmp_path.name,
    ]
    if not verify_tls:
        command.append("--check-certificate=false")
    command.append(source.url)
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"aria2c failed for {source.id}, falling back to Python downloader: {error}", file=sys.stderr)
        tmp_path.unlink(missing_ok=True)
        Path(f"{tmp_path}.aria2").unlink(missing_ok=True)
        return False
    if not tmp_path.exists() or tmp_path.stat().st_size <= 0:
        print(f"aria2c produced no file for {source.id}, falling back to Python downloader", file=sys.stderr)
        tmp_path.unlink(missing_ok=True)
        Path(f"{tmp_path}.aria2").unlink(missing_ok=True)
        return False
    tmp_path.replace(target)
    Path(f"{tmp_path}.aria2").unlink(missing_ok=True)
    return True


def download_source(
    source: Source,
    download_dir: Path,
    force: bool = False,
    verify_tls: bool = False,
    downloader: str = "auto",
    aria_connections: int = 8,
) -> Path:
    download_dir.mkdir(parents=True, exist_ok=True)
    zip_path = download_dir / f"{source.id}.zip"
    should_refresh = force or source.kind == "current"
    if zip_path.exists() and zip_path.stat().st_size > 0 and not should_refresh:
        print(f"cache hit: {source.id} -> {zip_path}", file=sys.stderr)
        return zip_path

    print(f"download: {source.id} ({source.kind})", file=sys.stderr)
    if downloader in {"auto", "aria2c"}:
        if download_with_aria2c(source, zip_path, verify_tls=verify_tls, connections=aria_connections):
            return zip_path
        if downloader == "aria2c":
            raise RuntimeError(f"aria2c failed for {source.id}")
    download_with_python(source, zip_path, verify_tls=verify_tls)
    return zip_path


def parse_file_name(name: str) -> dict[str, str]:
    stem = Path(name).name.lower().removesuffix(".csv")
    parts = stem.split("_")
    if len(parts) < 4 or parts[1:3] != ["lvr", "land"]:
        return {"city_code": "", "city_name": "", "transaction_code": "", "transaction_type": "", "table_kind": "other"}

    city_code = parts[0]
    transaction_code = parts[3]
    detail = parts[4] if len(parts) > 4 else "main"
    return {
        "city_code": city_code,
        "city_name": CITY_NAMES.get(city_code, ""),
        "transaction_code": transaction_code,
        "transaction_type": TRANSACTION_TYPES.get(transaction_code, ""),
        "table_kind": TABLE_KINDS.get(detail, detail),
    }


def csv_rows_from_zip(zip_path: Path, source: Source, include_schemas: bool) -> Iterable[dict[str, object]]:
    with zipfile.ZipFile(zip_path) as zf:
        names = sorted(
            name
            for name in zf.namelist()
            if name.lower().endswith(".csv")
            and (include_schemas or not Path(name).name.lower().startswith(("schema-", "manifest")))
        )
        for name in names:
            with zf.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                reader = csv.reader(text)
                try:
                    headers = next(reader)
                except StopIteration:
                    continue

                first_data = next(reader, None)
                if first_data and is_english_description_row(first_data):
                    pass
                elif first_data:
                    yield make_record(source, name, headers, first_data)

                for row in reader:
                    if not any(cell.strip() for cell in row):
                        continue
                    yield make_record(source, name, headers, row)


def csv_records_from_zip(
    zip_path: Path,
    source: Source,
    include_schemas: bool,
    table_kind: str | None = None,
) -> Iterable[dict[str, object]]:
    with zipfile.ZipFile(zip_path) as zf:
        names = sorted(
            name
            for name in zf.namelist()
            if name.lower().endswith(".csv")
            and (include_schemas or not Path(name).name.lower().startswith(("schema-", "manifest")))
            and (table_kind is None or parse_file_name(name).get("table_kind") == table_kind)
        )
        for name in names:
            with zf.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                reader = csv.reader(text)
                try:
                    headers = next(reader)
                except StopIteration:
                    continue

                first_data = next(reader, None)
                if first_data and is_english_description_row(first_data):
                    pass
                elif first_data:
                    yield make_record(source, name, headers, first_data)

                for row in reader:
                    if not any(cell.strip() for cell in row):
                        continue
                    yield make_record(source, name, headers, row)


def source_region_lookup(zip_path: Path, source: Source, include_schemas: bool) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for record in csv_records_from_zip(zip_path, source, include_schemas, table_kind=TABLE_KINDS["main"]):
        values = record.get("values")
        if not isinstance(values, dict):
            continue
        transaction_id = str(values.get("編號", "")).strip()
        town = str(values.get(REGION_FIELD, "")).strip()
        if transaction_id and town:
            lookup[transaction_id] = town
    return lookup


def attach_derived_region(record: dict[str, object], lookup: dict[str, str]) -> None:
    values = record.get("values")
    if not isinstance(values, dict):
        return
    if str(values.get(REGION_FIELD, "")).strip():
        return
    transaction_id = str(values.get("編號", "")).strip()
    town = lookup.get(transaction_id)
    if town:
        record["_region_township"] = town
        record["_region_source"] = "derived_from_main_record"


def is_english_description_row(row: list[str]) -> bool:
    filled = " ".join(cell.strip() for cell in row[:6])
    if not filled:
        return False
    ascii_chars = sum(1 for ch in filled if ord(ch) < 128)
    return ascii_chars / max(len(filled), 1) > 0.9


def make_record(source: Source, name: str, headers: list[str], row: list[str]) -> dict[str, object]:
    values = {header: row[idx] if idx < len(row) else "" for idx, header in enumerate(headers)}
    meta = parse_file_name(name)
    return {
        "_source_id": source.id,
        "_source_kind": source.kind,
        "_source_label": source.label,
        "_file": Path(name).name,
        **meta,
        "values": values,
    }


def write_json_header(out: TextIO, source_page: str = OPEN_DATA_PAGE) -> None:
    out.write("{\n")
    out.write('  "generated_at": ')
    json.dump(datetime.now(timezone.utc).isoformat(), out, ensure_ascii=False)
    out.write(',\n  "source_page": ')
    json.dump(source_page, out, ensure_ascii=False)
    out.write(',\n  "record_shape": ')
    json.dump(
        "Each record has source/file/city/type metadata and original CSV fields under values.",
        out,
        ensure_ascii=False,
    )


def increment_counter(counter: dict[str, int], key: str) -> None:
    counter[key or "unknown"] = counter.get(key or "unknown", 0) + 1


def safe_path_part(value: str) -> str:
    value = (value or "unknown").strip() or "unknown"
    return re.sub(r'[\\/:*?"<>|\s]+', "_", value).strip("._") or "unknown"


def region_key(record: dict[str, object]) -> tuple[str, str, str]:
    values = record.get("values")
    town = str(record.get("_region_township", "")).strip()
    if isinstance(values, dict):
        town = town or str(values.get(REGION_FIELD, "")).strip()
    city_code = str(record.get("city_code", "")).strip() or "unknown"
    city_name = str(record.get("city_name", "")).strip() or "unknown"
    return city_code, city_name, town or "unknown"


class RegionShardWriter:
    def __init__(self, shard_root: Path, max_open_files: int = 96) -> None:
        self.shard_root = shard_root
        self.max_open_files = max_open_files
        self.open_files: OrderedDict[tuple[str, str, str], TextIO] = OrderedDict()
        self.stats: dict[tuple[str, str, str], dict[str, object]] = {}

    def shard_path(self, key: tuple[str, str, str]) -> Path:
        city_code, city_name, town = key
        file_name = f"{safe_path_part(city_code)}_{safe_path_part(city_name)}__{safe_path_part(town)}.json"
        return self.shard_root / file_name

    def get_file(self, key: tuple[str, str, str]) -> TextIO:
        if key in self.open_files:
            out = self.open_files.pop(key)
            self.open_files[key] = out
            return out

        if len(self.open_files) >= self.max_open_files:
            _, old = self.open_files.popitem(last=False)
            old.close()

        path = self.shard_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        is_new = key not in self.stats
        out = path.open("a", encoding="utf-8")
        self.open_files[key] = out

        if is_new:
            city_code, city_name, town = key
            self.stats[key] = {
                "city_code": city_code,
                "city_name": city_name,
                "township": town,
                "shard": path.as_posix(),
                "record_count": 0,
                "sources": {},
                "files": {},
                "transaction_types": {},
                "table_kinds": {},
                "_first": True,
            }
            write_json_header(out)
            out.write(',\n  "region": ')
            json.dump(
                {"city_code": city_code, "city_name": city_name, "township": town},
                out,
                ensure_ascii=False,
                indent=2,
            )
            out.write(',\n  "records": [\n')

        return out

    def write_record(self, record: dict[str, object]) -> None:
        key = region_key(record)
        stat = self.stats.get(key)
        out = self.get_file(key)
        stat = self.stats[key]

        if stat["_first"]:
            stat["_first"] = False
        else:
            out.write(",\n")
        out.write("    ")
        json.dump(record, out, ensure_ascii=False, separators=(",", ":"))

        stat["record_count"] = int(stat["record_count"]) + 1
        increment_counter(stat["sources"], str(record.get("_source_id", "")))  # type: ignore[arg-type]
        increment_counter(stat["files"], str(record.get("_file", "")))  # type: ignore[arg-type]
        increment_counter(stat["transaction_types"], str(record.get("transaction_type", "")))  # type: ignore[arg-type]
        increment_counter(stat["table_kinds"], str(record.get("table_kind", "")))  # type: ignore[arg-type]

    def close(self) -> list[dict[str, object]]:
        for out in self.open_files.values():
            out.close()
        self.open_files.clear()

        entries: list[dict[str, object]] = []
        for key, stat in sorted(self.stats.items(), key=lambda item: (item[0][1], item[0][2])):
            path = Path(str(stat["shard"]))
            with path.open("a", encoding="utf-8") as out:
                out.write("\n  ]\n}\n")
            entry = {k: v for k, v in stat.items() if k != "_first"}
            entries.append(entry)
        return entries


def write_records_array(
    out: TextIO,
    zip_path: Path,
    source: Source,
    include_schemas: bool,
) -> dict[str, object]:
    count = 0
    first = True
    files: dict[str, int] = {}
    cities: dict[str, int] = {}
    transaction_types: dict[str, int] = {}
    table_kinds: dict[str, int] = {}

    out.write(',\n  "records": [\n')
    for record in csv_rows_from_zip(zip_path, source, include_schemas):
        if first:
            first = False
        else:
            out.write(",\n")
        out.write("    ")
        json.dump(record, out, ensure_ascii=False, separators=(",", ":"))

        count += 1
        increment_counter(files, str(record["_file"]))
        increment_counter(cities, str(record["city_name"]))
        increment_counter(transaction_types, str(record["transaction_type"]))
        increment_counter(table_kinds, str(record["table_kind"]))
    out.write("\n  ]\n}\n")

    return {
        "record_count": count,
        "files": files,
        "cities": cities,
        "transaction_types": transaction_types,
        "table_kinds": table_kinds,
    }


def write_json(
    sources: list[Source],
    output_path: Path,
    download_dir: Path,
    force: bool,
    include_schemas: bool,
    sleep_seconds: float,
    verify_tls: bool,
    downloader: str,
    aria_connections: int,
) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    first = True

    with output_path.open("w", encoding="utf-8") as out:
        write_json_header(out)
        out.write(',\n  "sources": ')
        json.dump([asdict(source) for source in sources], out, ensure_ascii=False, indent=2)
        out.write(",\n  \"records\": [\n")

        for idx, source in enumerate(sources, start=1):
            print(f"[{idx}/{len(sources)}] {source.id} {source.url}", file=sys.stderr)
            zip_path = download_source(source, download_dir, force=force, verify_tls=verify_tls, downloader=downloader, aria_connections=aria_connections)
            for record in csv_rows_from_zip(zip_path, source, include_schemas):
                if first:
                    first = False
                else:
                    out.write(",\n")
                out.write("    ")
                json.dump(record, out, ensure_ascii=False, separators=(",", ":"))
                count += 1
            if sleep_seconds:
                time.sleep(sleep_seconds)

        out.write("\n  ]\n}\n")

    return count


def write_source_shards(
    sources: list[Source],
    index_path: Path,
    shard_dir: Path,
    download_dir: Path,
    force: bool,
    include_schemas: bool,
    sleep_seconds: float,
    verify_tls: bool,
    downloader: str,
    aria_connections: int,
) -> int:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    shard_dir.mkdir(parents=True, exist_ok=True)
    total_count = 0
    shard_entries: list[dict[str, object]] = []

    for idx, source in enumerate(sources, start=1):
        print(f"[{idx}/{len(sources)}] {source.id} {source.url}", file=sys.stderr)
        zip_path = download_source(source, download_dir, force=force, verify_tls=verify_tls, downloader=downloader, aria_connections=aria_connections)
        shard_path = shard_dir / f"{source.id}.json"
        tmp_path = shard_path.with_suffix(".json.part")
        source_payload = asdict(source)

        with tmp_path.open("w", encoding="utf-8") as out:
            write_json_header(out)
            out.write(',\n  "source": ')
            json.dump(source_payload, out, ensure_ascii=False, indent=2)
            stats = write_records_array(out, zip_path, source, include_schemas)

        tmp_path.replace(shard_path)
        total_count += int(stats["record_count"])
        shard_entries.append(
            {
                **source_payload,
                "shard": shard_path.as_posix(),
                "zip": zip_path.as_posix(),
                **stats,
            }
        )
        if sleep_seconds:
            time.sleep(sleep_seconds)

    index_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_page": OPEN_DATA_PAGE,
        "total_sources": len(sources),
        "total_records": total_count,
        "shard_strategy": "by official source id: current, rolling release date YYYYMMDD, or quarterly season YYYQS#",
        "record_shape": "Load one shard from sources[].shard; each record has metadata and original CSV fields under values.",
        "sources": shard_entries,
    }
    tmp_index = index_path.with_suffix(".json.part")
    tmp_index.write_text(json.dumps(index_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_index.replace(index_path)
    return total_count


def write_region_shards(
    sources: list[Source],
    index_path: Path,
    shard_dir: Path,
    download_dir: Path,
    source_cache_dir: Path,
    force: bool,
    include_schemas: bool,
    sleep_seconds: float,
    verify_tls: bool,
    downloader: str,
    aria_connections: int,
) -> int:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = shard_dir.with_name(f"{shard_dir.name}.part")
    if tmp_root.exists():
        shutil.rmtree(tmp_root)
    tmp_root.mkdir(parents=True, exist_ok=True)

    writer = RegionShardWriter(tmp_root)
    total_count = 0
    source_entries: list[dict[str, object]] = []

    try:
        for idx, source in enumerate(sources, start=1):
            print(f"[{idx}/{len(sources)}] {source.id} {source.url}", file=sys.stderr)
            source_count = 0

            if source.kind != "current" and not force and valid_source_cache(source, source_cache_dir, include_schemas):
                print(f"parsed cache hit: {source.id}", file=sys.stderr)
                zip_path = download_dir / f"{source.id}.zip"
                for record in iter_cached_source_records(source, source_cache_dir):
                    writer.write_record(record)
                    source_count += 1
            else:
                zip_path = download_source(source, download_dir, force=force, verify_tls=verify_tls, downloader=downloader, aria_connections=aria_connections)
                source_count = write_uncached_source_to_regions(
                    source=source,
                    zip_path=zip_path,
                    writer=writer,
                    cache_dir=source_cache_dir,
                    include_schemas=include_schemas,
                    write_cache=source.kind != "current",
                )
            total_count += source_count
            source_entries.append({**asdict(source), "zip": zip_path.as_posix(), "record_count": source_count})
            if sleep_seconds:
                time.sleep(sleep_seconds)
    except Exception:
        for out in writer.open_files.values():
            out.close()
        writer.open_files.clear()
        raise

    region_entries = writer.close()
    for entry in region_entries:
        entry["shard"] = (shard_dir / Path(str(entry["shard"])).name).as_posix()

    by_city: dict[str, dict[str, object]] = {}
    for entry in region_entries:
        city_code = str(entry["city_code"])
        city_name = str(entry["city_name"])
        city = by_city.setdefault(
            city_code,
            {"city_code": city_code, "city_name": city_name, "record_count": 0, "townships": []},
        )
        city["record_count"] = int(city["record_count"]) + int(entry["record_count"])
        city["townships"].append(entry)  # type: ignore[union-attr]

    index_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_page": OPEN_DATA_PAGE,
        "total_sources": len(sources),
        "total_records": total_count,
        "total_region_shards": len(region_entries),
        "shard_strategy": "by two region levels: county/city from source filename, then township/district from CSV 鄉鎮市區",
        "record_shape": "Load one township shard from cities[].townships[].shard; each record has metadata and original CSV fields under values.",
        "sources": source_entries,
        "cities": sorted(by_city.values(), key=lambda city: str(city["city_name"])),
    }

    tmp_index = index_path.with_suffix(".json.part")
    tmp_index.write_text(json.dumps(index_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if shard_dir.exists():
        shutil.rmtree(shard_dir)
    tmp_root.replace(shard_dir)
    tmp_index.replace(index_path)
    return total_count


def write_sources(sources: list[Source], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_page": OPEN_DATA_PAGE,
        "sources": [asdict(source) for source in sources],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def source_cache_paths(source: Source, cache_dir: Path) -> tuple[Path, Path]:
    return cache_dir / f"{safe_path_part(source.id)}.jsonl.gz", cache_dir / f"{safe_path_part(source.id)}.meta.json"


def valid_source_cache(source: Source, cache_dir: Path, include_schemas: bool) -> bool:
    records_path, meta_path = source_cache_paths(source, cache_dir)
    if not records_path.exists() or not meta_path.exists():
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        meta.get("cache_version") == SOURCE_CACHE_VERSION
        and meta.get("source_id") == source.id
        and meta.get("source_url") == source.url
        and meta.get("include_schemas") == include_schemas
        and int(meta.get("record_count") or 0) > 0
    )


def iter_cached_source_records(source: Source, cache_dir: Path) -> Iterable[dict[str, object]]:
    records_path, _ = source_cache_paths(source, cache_dir)
    with gzip.open(records_path, "rt", encoding="utf-8") as raw:
        for line in raw:
            if line.strip():
                yield json.loads(line)


def write_source_record_cache(
    source: Source,
    zip_path: Path,
    cache_dir: Path,
    include_schemas: bool,
) -> int:
    cache_dir.mkdir(parents=True, exist_ok=True)
    records_path, meta_path = source_cache_paths(source, cache_dir)
    tmp_records = records_path.with_suffix(records_path.suffix + ".part")
    tmp_meta = meta_path.with_suffix(meta_path.suffix + ".part")
    lookup = source_region_lookup(zip_path, source, include_schemas)
    count = 0
    with gzip.open(tmp_records, "wt", encoding="utf-8", compresslevel=4) as out:
        for record in csv_rows_from_zip(zip_path, source, include_schemas):
            attach_derived_region(record, lookup)
            json.dump(record, out, ensure_ascii=False, separators=(",", ":"))
            out.write("\n")
            count += 1
    meta = {
        "cache_version": SOURCE_CACHE_VERSION,
        "source_id": source.id,
        "source_kind": source.kind,
        "source_url": source.url,
        "include_schemas": include_schemas,
        "record_count": count,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_records.replace(records_path)
    tmp_meta.replace(meta_path)
    return count


def write_uncached_source_to_regions(
    source: Source,
    zip_path: Path,
    writer: RegionShardWriter,
    cache_dir: Path,
    include_schemas: bool,
    write_cache: bool,
) -> int:
    lookup = source_region_lookup(zip_path, source, include_schemas)
    count = 0
    cache_out = None
    tmp_records: Path | None = None
    tmp_meta: Path | None = None

    if write_cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        records_path, meta_path = source_cache_paths(source, cache_dir)
        tmp_records = records_path.with_suffix(records_path.suffix + ".part")
        tmp_meta = meta_path.with_suffix(meta_path.suffix + ".part")
        cache_out = gzip.open(tmp_records, "wt", encoding="utf-8", compresslevel=4)

    try:
        for record in csv_rows_from_zip(zip_path, source, include_schemas):
            attach_derived_region(record, lookup)
            writer.write_record(record)
            if cache_out is not None:
                json.dump(record, cache_out, ensure_ascii=False, separators=(",", ":"))
                cache_out.write("\n")
            count += 1
    finally:
        if cache_out is not None:
            cache_out.close()

    if write_cache and tmp_records is not None and tmp_meta is not None:
        records_path, meta_path = source_cache_paths(source, cache_dir)
        meta = {
            "cache_version": SOURCE_CACHE_VERSION,
            "source_id": source.id,
            "source_kind": source.kind,
            "source_url": source.url,
            "include_schemas": include_schemas,
            "record_count": count,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        tmp_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_records.replace(records_path)
        tmp_meta.replace(meta_path)

    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="data/plvr/plvr-land-transactions.json", type=Path)
    parser.add_argument("--index-output", default="data/plvr/region-index.json", type=Path)
    parser.add_argument("--shard-dir", default="data/plvr/by-region", type=Path)
    parser.add_argument("--sources-output", default="data/plvr/source-urls.json", type=Path)
    parser.add_argument("--download-dir", default="downloads/plvr", type=Path)
    parser.add_argument("--source-cache-dir", default="cache/plvr-source-regions", type=Path)
    parser.add_argument("--source-kind", choices=["all", "current", "history", "season"], default="all")
    parser.add_argument("--max-sources", type=int, help="Useful for smoke tests.")
    parser.add_argument("--force", action="store_true", help="Re-download ZIPs even if cached.")
    parser.add_argument("--include-schemas", action="store_true", help="Also include manifest/schema CSV rows as records.")
    parser.add_argument("--sources-only", action="store_true", help="Only write the source URL manifest.")
    parser.add_argument("--by-source", action="store_true", help="Write one shard per official source date/season.")
    parser.add_argument("--single-json", action="store_true", help="Write one huge JSON file instead of source-date shards.")
    parser.add_argument("--sleep", type=float, default=0.2, help="Pause between source downloads.")
    parser.add_argument(
        "--downloader",
        choices=["auto", "aria2c", "python"],
        default="auto",
        help="Downloader for ZIP files. auto uses aria2c when available and falls back to Python.",
    )
    parser.add_argument("--aria-connections", type=int, default=8, help="aria2c split/connection count per ZIP.")
    parser.add_argument(
        "--verify-tls",
        action="store_true",
        help="Use strict TLS verification. Off by default because this public site currently fails Python certificate checks.",
    )
    args = parser.parse_args()

    sources = discover_sources(args.verify_tls)
    if args.source_kind != "all":
        sources = [source for source in sources if source.kind == args.source_kind]
    if args.max_sources:
        sources = sources[: args.max_sources]

    write_sources(sources, args.sources_output)
    print(f"Wrote {len(sources)} source URLs to {args.sources_output}", file=sys.stderr)

    if args.sources_only:
        return 0

    if args.single_json:
        count = write_json(
            sources=sources,
            output_path=args.output,
            download_dir=args.download_dir,
            force=args.force,
            include_schemas=args.include_schemas,
            sleep_seconds=args.sleep,
            verify_tls=args.verify_tls,
            downloader=args.downloader,
            aria_connections=args.aria_connections,
        )
        print(f"Wrote {count} records to {args.output}", file=sys.stderr)
        return 0

    if args.by_source:
        count = write_source_shards(
            sources=sources,
            index_path=args.index_output,
            shard_dir=args.shard_dir,
            download_dir=args.download_dir,
            force=args.force,
            include_schemas=args.include_schemas,
            sleep_seconds=args.sleep,
            verify_tls=args.verify_tls,
            downloader=args.downloader,
            aria_connections=args.aria_connections,
        )
        print(f"Wrote {count} records across {len(sources)} source shards under {args.shard_dir}", file=sys.stderr)
        return 0

    count = write_region_shards(
        sources=sources,
        index_path=args.index_output,
        shard_dir=args.shard_dir,
        download_dir=args.download_dir,
        source_cache_dir=args.source_cache_dir,
        force=args.force,
        include_schemas=args.include_schemas,
        sleep_seconds=args.sleep,
        verify_tls=args.verify_tls,
        downloader=args.downloader,
        aria_connections=args.aria_connections,
    )
    print(f"Wrote {count} records into region shards under {args.shard_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
