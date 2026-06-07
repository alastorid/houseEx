#!/usr/bin/env python3

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

ENDPOINT = "https://cpami.chcg.gov.tw/opendata/OpenDataSearchUrl.do"
PAGE_SIZE = 100
DISTRICTS = [
    "彰化市", "芬園鄉", "花壇鄉", "秀水鄉", "鹿港鎮", "福興鄉", "線西鄉",
    "和美鎮", "伸港鄉", "員林市", "社頭鄉", "永靖鄉", "埔心鄉", "溪湖鎮",
    "大村鄉", "埔鹽鄉", "田中鎮", "北斗鎮", "田尾鄉", "埤頭鄉", "溪州鄉",
    "竹塘鄉", "二林鎮", "大城鄉", "芳苑鄉", "二水鄉",
]


def fetch_page(start, cache_dir, refresh=False, filters=None, cache_prefix=""):
    path = cache_dir / f"{cache_prefix}{start:07d}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    query = urllib.parse.urlencode({"d": "OPENDATA", "c": "BUILDLIC", "Start": start, **(filters or {})})
    url = f"{ENDPOINT}?{query}"
    for attempt in range(5):
        try:
            response = subprocess.run(
                [
                    "curl", "--fail", "--silent", "--show-error", "--location",
                    "--max-time", "60", "--retry", "2", "--retry-all-errors",
                    "-H", "Accept: application/json",
                    "-A", "HouseEx buildlic ETL/1.0",
                    url,
                ],
                check=True,
                capture_output=True,
            )
            payload = json.loads(response.stdout.decode("utf-8-sig"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False))
            return payload
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def find_end(cache_dir):
    low = 1
    high = PAGE_SIZE + 1
    while fetch_page(high, cache_dir).get("data"):
        low = high
        high *= 2
    while high - low > PAGE_SIZE:
        middle = ((low + high) // (PAGE_SIZE * 2)) * PAGE_SIZE + 1
        if middle <= low:
            middle = low + PAGE_SIZE
        if fetch_page(middle, cache_dir).get("data"):
            low = middle
        else:
            high = middle
    return high


def fetch_qtime_range(year_start, year_end, cache_dir, refresh=False):
    records = []
    pages = 0
    for year in range(year_start, year_end):
        for month in range(1, 13):
            issue_month = f"{year:03d}年{month:02d}月"
            start = 1
            while True:
                payload = fetch_page(
                    start,
                    cache_dir,
                    refresh,
                    filters={"發照日期": issue_month},
                    cache_prefix=f"issue-month-{year:03d}-{month:02d}-",
                )
                rows = payload.get("data") or []
                records.extend(rows)
                pages += 1
                if len(rows) < PAGE_SIZE:
                    break
                start += PAGE_SIZE
        print(f"Fetched BUILDLIC year {year:03d}", flush=True)
    return records, pages


def fetch_filtered_pages(filters, cache_dir, cache_prefix, refresh=False):
    records = []
    pages = 0
    start = 1
    while True:
        payload = fetch_page(
            start,
            cache_dir,
            refresh,
            filters=filters,
            cache_prefix=cache_prefix,
        )
        rows = payload.get("data") or []
        records.extend(rows)
        pages += 1
        if len(rows) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return records, pages


def fetch_district(district, cache_dir, refresh=False):
    if district not in DISTRICTS:
        raise ValueError(f"Unknown BUILDLIC district: {district}")
    slug = hashlib.sha1(district.encode()).hexdigest()[:10]
    return fetch_filtered_pages(
        {"門牌.行政區": f"彰化縣{district}"},
        cache_dir,
        f"district-{slug}-",
        refresh,
    )


def district_from_door(door):
    area = str(door.get("行政區") or "")
    match = re.search(r"彰化縣(.+?[鄉鎮市])", area)
    return match.group(1) if match else "unknown"


def record_key(record):
    oid = (record.get("_id") or {}).get("$oid")
    if oid:
        return oid
    stable = json.dumps(record, ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha1(stable).hexdigest()


def write_assets(records, output_dir):
    districts = {}
    seen = {}
    for record in records:
        key = record_key(record)
        if key in seen:
            continue
        seen[key] = record
        doors = record.get("門牌") if isinstance(record.get("門牌"), list) else []
        names = {district_from_door(door) for door in doors if isinstance(door, dict)}
        if not names:
            names = {"unknown"}
        for district in names:
            districts.setdefault(district, []).append(record)

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"version": time.strftime("%Y-%m-%d"), "totalRecords": len(seen), "districts": {}}
    for district, rows in sorted(districts.items()):
        slug = hashlib.sha1(district.encode()).hexdigest()[:10]
        filename = f"{slug}.json.gz"
        raw = json.dumps({"district": district, "data": rows}, ensure_ascii=False, separators=(",", ":")).encode()
        target = output_dir / filename
        with gzip.open(target, "wb", compresslevel=9) as stream:
            stream.write(raw)
        manifest["districts"][district] = {
            "path": f"data/buildlic/{filename}",
            "recordCount": len(rows),
            "compressedBytes": target.stat().st_size,
            "hash": hashlib.sha256(target.read_bytes()).hexdigest(),
        }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def record_has_address(record, expected):
    normalized = re.sub(r"\s+", "", expected).replace("臺", "台").replace("－", "-")
    for door in record.get("門牌") or []:
        address = "".join(str(door.get(key) or "") for key in ("行政區", "村里鄰", "路街段巷弄", "號", "樓"))
        comparable = re.sub(r"\s+", "", address).replace("臺", "台").replace("－", "-")
        comparable = re.sub(r"([^鄉鎮市區]{1,8}[村里])(?:\d+鄰)?", "", comparable)
        normalized_without_village = re.sub(r"([^鄉鎮市區]{1,8}[村里])(?:\d+鄰)?", "", normalized)
        if comparable == normalized_without_village:
            return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default="downloads/buildlic")
    parser.add_argument("--output-dir", default="data/buildlic")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int)
    parser.add_argument("--fetch-only", action="store_true")
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--year-start", type=int)
    parser.add_argument("--year-end", type=int)
    parser.add_argument("--district")
    parser.add_argument("--require-address", action="append", default=[])
    args = parser.parse_args()
    cache_dir = Path(args.cache_dir)
    use_qtime = args.year_start is not None and args.year_end is not None
    end = args.end or (args.start if args.build_only or use_qtime or args.district else find_end(cache_dir))
    starts = list(range(args.start, end, PAGE_SIZE))
    records = []
    pages = len(starts)
    if not args.build_only and args.district:
        records, pages = fetch_district(args.district, cache_dir, args.refresh)
        print(f"Fetched BUILDLIC {args.district}: {len(records)} records in {pages} pages", flush=True)
    elif not args.build_only and use_qtime:
        records, pages = fetch_qtime_range(
            args.year_start,
            args.year_end,
            cache_dir,
            args.refresh,
        )
    elif not args.build_only:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(fetch_page, start, cache_dir, args.refresh): start
                for start in starts
            }
            for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
                records.extend(future.result().get("data") or [])
                if index % 100 == 0 or index == len(futures):
                    print(f"Fetched {index}/{len(futures)} pages", flush=True)
    if args.fetch_only:
        return
    if args.build_only:
        for path in sorted(cache_dir.glob("*.json")):
            records.extend(json.loads(path.read_text()).get("data") or [])
    missing_addresses = [
        address for address in args.require_address
        if not any(record_has_address(record, address) for record in records)
    ]
    if missing_addresses:
        raise RuntimeError(f"BUILDLIC snapshot is incomplete; missing required addresses: {', '.join(missing_addresses)}")
    manifest = write_assets(records, Path(args.output_dir))
    print(json.dumps({"pages": pages, **manifest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
