#!/usr/bin/env python3
"""Build GitHub-friendly compressed PLVR web assets from region JSON shards."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


def gzip_file(source: Path, target: Path, compresslevel: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    with source.open("rb") as src, gzip.open(tmp, "wb", compresslevel=compresslevel) as dst:
        shutil.copyfileobj(src, dst)
    tmp.replace(target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region-index", type=Path, default=Path("data/plvr/region-index.json"))
    parser.add_argument("--source-dir", type=Path, default=Path("data/plvr/by-region"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/plvr/web"))
    parser.add_argument("--output-index", type=Path, default=Path("data/plvr/web-index.json"))
    parser.add_argument("--compresslevel", type=int, default=9)
    parser.add_argument("--max-file-mb", type=float, default=95)
    args = parser.parse_args()

    index = json.loads(args.region_index.read_text(encoding="utf-8"))
    if args.output_dir.exists():
        shutil.rmtree(args.output_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    compressed_total = 0
    oversized: list[tuple[str, float]] = []
    max_bytes = args.max_file_mb * 1024 * 1024

    for city in index["cities"]:
        for town in city["townships"]:
            raw_path = Path(town["shard"])
            if not raw_path.exists():
                raw_path = args.source_dir / raw_path.name
            gz_path = args.output_dir / f"{raw_path.name}.gz"
            gzip_file(raw_path, gz_path, args.compresslevel)
            gz_size = gz_path.stat().st_size
            raw_size = raw_path.stat().st_size
            compressed_total += gz_size
            if gz_size > max_bytes:
                oversized.append((gz_path.as_posix(), gz_size / 1024 / 1024))
            town["raw_shard"] = raw_path.as_posix()
            town["shard"] = gz_path.as_posix()
            town["encoding"] = "gzip"
            town["raw_bytes"] = raw_size
            town["compressed_bytes"] = gz_size

    index["generated_at"] = datetime.now(timezone.utc).isoformat()
    index["asset_format"] = "gzip-compressed JSON shards"
    index["total_compressed_bytes"] = compressed_total
    index["max_file_mb"] = args.max_file_mb
    args.output_index.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if oversized:
        for path, size in oversized:
            print(f"oversized: {path} {size:.1f} MB")
        raise SystemExit(2)

    print(f"Wrote {sum(len(city['townships']) for city in index['cities'])} compressed shards to {args.output_dir}")
    print(f"Compressed total: {compressed_total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
