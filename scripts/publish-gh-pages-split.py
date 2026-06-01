#!/usr/bin/env python3
"""Publish a large static site to gh-pages in several small pushes."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def existing(site_dir: Path, paths: list[str]) -> list[str]:
    return [path for path in paths if (site_dir / path).exists()]


def has_staged_changes(site_dir: Path) -> bool:
    result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=site_dir)
    return result.returncode != 0


def commit_and_push(site_dir: Path, branch: str, message: str, paths: list[str], force: bool = False) -> None:
    paths = existing(site_dir, paths)
    if not paths:
        return
    run(["git", "add", "--", *paths], cwd=site_dir)
    if not has_staged_changes(site_dir):
        return
    run(["git", "commit", "-m", message], cwd=site_dir)
    push = ["git", "push", "origin", f"HEAD:{branch}"]
    if force:
        push.insert(2, "--force")
    run(push, cwd=site_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=Path("site"))
    parser.add_argument("--branch", default="gh-pages")
    args = parser.parse_args()

    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    remote = f"https://x-access-token:{token}@github.com/{repository}.git"
    site_dir = args.site_dir
    (site_dir / ".nojekyll").write_text("", encoding="utf-8")

    run(["git", "init"], cwd=site_dir)
    run(["git", "checkout", "-B", args.branch], cwd=site_dir)
    run(["git", "config", "user.name", "github-actions[bot]"], cwd=site_dir)
    run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], cwd=site_dir)
    run(["git", "config", "http.version", "HTTP/1.1"], cwd=site_dir)
    run(["git", "remote", "add", "origin", remote], cwd=site_dir)

    app_paths = [
        ".nojekyll",
        "index.html",
        "terminal.html",
        "script.js",
        "styles.css",
        "queryService.js",
        "sqlWorker.js",
        "terminal.js",
        "terminal.css",
        "vendor",
    ]
    commit_and_push(site_dir, args.branch, "Deploy app shell", app_paths, force=True)
    commit_and_push(site_dir, args.branch, "Deploy PLVR JSON shards", ["data/plvr"])
    commit_and_push(
        site_dir,
        args.branch,
        "Deploy SQLite metadata",
        [
            "data/db/metadata.json",
            "data/db/qa-report.json",
            "data/db/size-report.json",
            "data/db/community-gap-report.json",
            "data/db/index.sqlite.gz",
        ],
    )

    district_root = site_dir / "data/db/district"
    for city_dir in sorted(path for path in district_root.iterdir() if path.is_dir()):
        commit_and_push(
            site_dir,
            args.branch,
            f"Deploy SQLite shards: {city_dir.name}",
            [city_dir.relative_to(site_dir).as_posix()],
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
