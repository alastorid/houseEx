# Project: houseEx

houseEx is a static website and data processing pipeline designed to host and browse Real Estate Transaction Price (PLVR) data from Taiwan's Ministry of the Interior (MOI).

## Architecture

The project processes large volumes of raw open data into optimized, gzip-compressed JSON shards suitable for hosting on GitHub Pages. It also supports SQLite-based querying using `sql.js` for an interactive, browser-based data analysis experience.

## Building and Running

### Prerequisites
- Python 3.x
- Standard Unix environment

### Data Pipeline
To rebuild the web assets, follow these steps:
```sh
# Fetch raw open data
python3 scripts/fetch-plvr-open-data.py

# Build compressed web assets
python3 scripts/build-plvr-web-assets.py
```

### SQLite Assets
The project also supports SQLite generation for advanced querying:
```sh
python3 scripts/build-sqlite-assets.py
```

## Project Structure

- `/data`: Contains raw and processed data, including the PLVR JSON shards and SQLite databases.
- `/scripts`: Python-based automation for data ingestion, transformation, and testing.
- `/vendor`: Third-party frontend libraries (`leaflet`, `sql.js`).
- `index.html`, `script.js`, `styles.css`: Core frontend components for the web interface.
- `terminal.js`, `terminal.html`: Browser-based terminal interface for data interaction.

## Development Conventions

- **Data Processing:** All data manipulation is handled via Python scripts in `/scripts`.
- **Frontend:** Uses plain HTML/CSS/JS with minimal dependencies managed in `/vendor`.
- **Versioning:** Raw build outputs are intentionally excluded from version control due to their size.
