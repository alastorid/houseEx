# 實價登錄資料

Static GitHub Pages site for browsing processed MOI PLVR open data.

## Data

- `data/plvr/web-index.json`: region index.
- `data/plvr/web/*.json.gz`: gzip-compressed region shards.

The raw local build output is intentionally ignored because it is too large for a normal GitHub repository. Rebuild the web assets with:

```sh
python3 scripts/fetch-plvr-open-data.py
python3 scripts/build-plvr-web-assets.py
```
