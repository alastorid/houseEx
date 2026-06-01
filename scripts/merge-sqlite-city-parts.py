#!/usr/bin/env python3
"""Merge per-city SQLite build artifacts into the deployable data/db tree."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def rewrite_shard_paths(value: object, source_root: Path, output_dir: Path) -> object:
    if isinstance(value, list):
        return [rewrite_shard_paths(item, source_root, output_dir) for item in value]
    if isinstance(value, dict):
        rewritten = {key: rewrite_shard_paths(item, source_root, output_dir) for key, item in value.items()}
        path = rewritten.get("path") or rewritten.get("gzip")
        if isinstance(path, str) and path.endswith(".sqlite.gz"):
            source = (source_root / path).resolve() if not Path(path).is_absolute() else Path(path)
            try:
                rel = source.relative_to(source_root / "data/db-part")
            except ValueError:
                try:
                    rel = source.relative_to(source_root)
                except ValueError:
                    rel = Path(path)
            if "district" in rel.parts:
                rel = Path(*rel.parts[rel.parts.index("district") :])
            else:
                rel = Path("district") / rel
            target = output_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            deployed = target.as_posix()
            rewritten["gzip"] = deployed
            rewritten["path"] = deployed
            if "db" in rewritten:
                rewritten["db"] = str(Path(deployed).with_suffix(""))
        return rewritten
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-metadata", type=Path, default=Path("data/db/metadata.json"))
    parser.add_argument("--parts-dir", type=Path, default=Path("city-parts"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/db"))
    args = parser.parse_args()

    metadata = json.loads(args.base_metadata.read_text(encoding="utf-8"))
    metadata["cities"] = {}

    qa_report = {
        "generatedAt": metadata["generated_at"],
        "totalRows": 0,
        "cities": {},
    }
    size_report = {
        "generatedAt": metadata["generated_at"],
        "budgets": {
            "index.sqlite.gz": 25 * 1024 * 1024,
            "shard.sqlite.gz": 45 * 1024 * 1024,
            "script.js": 300 * 1024,
            "styles.css": 80 * 1024,
        },
        "files": [],
        "warnings": [],
    }

    part_metadata_paths = sorted(path for path in args.parts_dir.glob("**/metadata.json") if path != args.base_metadata)
    if not part_metadata_paths:
        raise SystemExit(f"No city metadata artifacts found under {args.parts_dir}")

    for part_metadata_path in part_metadata_paths:
        source_root = part_metadata_path.parents[2] if part_metadata_path.parent.name == "db-part" else part_metadata_path.parent
        part = json.loads(part_metadata_path.read_text(encoding="utf-8"))
        for city, info in (part.get("cities") or {}).items():
            rewritten = rewrite_shard_paths(info, source_root, args.output_dir)
            metadata["cities"][city] = rewritten
            qa = rewritten.get("qa") or {}
            qa_report["cities"][city] = qa
            qa_report["totalRows"] += qa.get("totalRows", 0)
            for shard in rewritten.get("shards") or []:
                path = Path(shard["gzip"])
                size = path.stat().st_size if path.exists() else shard.get("compressedBytes", 0)
                budget = size_report["budgets"]["shard.sqlite.gz"]
                entry = {"file": path.as_posix(), "label": f"{rewritten['slug']}/{shard['slug']}.sqlite.gz", "bytes": size, "budgetBytes": budget, "ok": size <= budget}
                size_report["files"].append(entry)
                if not entry["ok"]:
                    size_report["warnings"].append(f"{entry['label']} is {size} bytes; budget is {budget} bytes")

    index_path = Path((metadata.get("index") or {}).get("gzip", args.output_dir / "index.sqlite.gz"))
    if index_path.exists():
        budget = size_report["budgets"]["index.sqlite.gz"]
        size = index_path.stat().st_size
        entry = {"file": index_path.as_posix(), "label": "index.sqlite.gz", "bytes": size, "budgetBytes": budget, "ok": size <= budget}
        size_report["files"].insert(0, entry)
        if not entry["ok"]:
            size_report["warnings"].append(f"index.sqlite.gz is {size} bytes; budget is {budget} bytes")

    args.base_metadata.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "qa-report.json").write_text(json.dumps(qa_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "size-report.json").write_text(json.dumps(size_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Merged {len(metadata['cities'])} city SQLite artifacts into {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
