/* global initSqlJs */

let SQL;
let metadata;
let indexDb;
const cityDbs = new Map();

const DB_CACHE_NAME = "houseEx.sqliteCache";
const DB_CACHE_VERSION = 1;
const DB_STORE = "blobs";
const M2_PER_PING = 3.305785;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function now() {
  return performance.now();
}

function meta(sqlName, db, rowCount, elapsedMs, cacheHit = false) {
  return {
    source: "sqlite-wasm",
    db: db || "index",
    rowCount: Number(rowCount) || 0,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    sqlName,
    cacheHit: Boolean(cacheHit),
  };
}

function withMeta(sqlName, db, started, rows, cacheHit = false, extra = {}) {
  const rowCount = Array.isArray(rows) ? rows.length : Number(extra.rowCount) || 0;
  return { rows: rows || [], meta: meta(sqlName, db, rowCount, now() - started, cacheHit), ...extra };
}

function openIdb() {
  if (!("indexedDB" in self)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_CACHE_NAME, DB_CACHE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: "key" });
        store.createIndex("kind", "kind");
        store.createIndex("lastUsed", "lastUsed");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function idbGet(db, key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function idbPut(db, record) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

function idbDelete(db, key) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

function idbAll(db) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

async function pruneCityCache(db) {
  const rows = (await idbAll(db))
    .filter((item) => item.kind === "city")
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  await Promise.all(rows.slice(3).map((item) => idbDelete(db, item.key)));
}

async function clearCache() {
  const started = now();
  const db = await openIdb();
  const rows = await idbAll(db);
  await Promise.all(rows.map((item) => idbDelete(db, item.key)));
  return withMeta("clearCache", "cache", started, [], false, { cleared: rows.length });
}

async function fetchCompressedBytes(path, hash = "") {
  const url = hash ? `${path}?h=${encodeURIComponent(hash)}` : path;
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function decompressGzip(bytes) {
  if (!("DecompressionStream" in self)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadSqliteBytes(path, hash, kind, city = "") {
  const key = `${kind}:${city || "index"}:${path}`;
  const db = await openIdb();
  const cached = await idbGet(db, key);
  if (cached?.hash === hash && cached.bytes) {
    cached.lastUsed = Date.now();
    await idbPut(db, cached);
    return { bytes: await decompressGzip(new Uint8Array(cached.bytes)), cacheHit: true };
  }
  const compressed = await fetchCompressedBytes(path, hash);
  await idbPut(db, {
    key,
    kind,
    city,
    path,
    hash,
    bytes: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength),
    lastUsed: Date.now(),
  });
  if (kind === "city") await pruneCityCache(db);
  return { bytes: await decompressGzip(compressed), cacheHit: false };
}

async function ensureSql() {
  if (SQL) return SQL;
  importScripts("vendor/sqljs/sql-wasm.js?v=20260531-sqlite-hardening");
  SQL = await initSqlJs({ locateFile: (file) => `vendor/sqljs/${file}` });
  return SQL;
}

async function init() {
  const started = now();
  await ensureSql();
  const metadataResponse = await fetch("data/db/metadata.json", { cache: "no-cache" });
  if (!metadataResponse.ok) throw new Error("SQLite metadata not found");
  metadata = await metadataResponse.json();
  const indexInfo = metadata.index || {};
  const loaded = await loadSqliteBytes(indexInfo.gzip || indexInfo.path, indexInfo.hash, "index");
  indexDb = new SQL.Database(loaded.bytes);
  return { metadata, meta: meta("init", "index", 0, now() - started, loaded.cacheHit) };
}

function rowsFromExec(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function scalarFromExec(db, sql, params = []) {
  const rows = rowsFromExec(db, sql, params);
  return rows[0] ? Object.values(rows[0])[0] : 0;
}

function tableExists(db, name) {
  return Boolean(
    rowsFromExec(db, "SELECT name FROM sqlite_master WHERE name = ? LIMIT 1", [name])[0],
  );
}

function communityWhere({ city, district, keyword }) {
  const clauses = [];
  const params = [];
  if (city) {
    clauses.push("city = ?");
    params.push(city);
  }
  if (district) {
    clauses.push("district = ?");
    params.push(district);
  }
  if (keyword) {
    clauses.push("(community_name LIKE ? OR sample_address LIKE ? OR search_text LIKE ?)");
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function queryCommunities(payload = {}) {
  const started = now();
  const { where, params } = communityWhere(payload);
  const limit = Math.min(Number(payload.limit) || 500, 2000);
  const offset = Number(payload.offset) || 0;
  const rows = rowsFromExec(
    indexDb,
    `
      SELECT * FROM communities
      ${where}
      ORDER BY transaction_count DESC, latest_transaction_date DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
  const total = scalarFromExec(indexDb, `SELECT COUNT(*) FROM communities ${where}`, params);
  return withMeta("queryCommunities", "index", started, rows, false, { total, limit, offset });
}

function searchCommunities(payload = {}) {
  const started = now();
  const keyword = String(payload.keyword || "").trim();
  if (!keyword) return withMeta("searchCommunities", "index", started, []);
  const normalized = normalizeText(keyword);
  const limit = Math.min(Number(payload.limit) || 20, 100);
  const rows = rowsFromExec(
    indexDb,
    `
      SELECT c.*
      FROM search_index s
      JOIN communities c ON c.community_id = s.target_id
      WHERE s.target_type = 'community'
        AND (s.token = ? OR s.token LIKE ? OR c.community_name LIKE ? OR c.search_text LIKE ?)
      GROUP BY c.community_id
      ORDER BY
        CASE WHEN c.community_name = ? THEN 0 ELSE 1 END,
        c.transaction_count DESC
      LIMIT ?
    `,
    [normalized, `%${normalized}%`, `%${keyword}%`, `%${keyword}%`, keyword, limit],
  );
  return withMeta("searchCommunities", "index", started, rows);
}

function searchAll(payload = {}) {
  const started = now();
  const city = payload.city;
  const keyword = String(payload.keyword || "").trim();
  if (!city || !keyword) return withMeta("searchAll", city || "city", started, []);
  const db = cityDb(city);
  const limit = Math.min(Number(payload.limit) || 50, 200);
  const like = `%${keyword}%`;
  let rows = [];
  if (tableExists(db, "fts_all")) {
    try {
      rows = rowsFromExec(
        db,
        `
          SELECT t.*
          FROM fts_all f
          JOIN transactions t ON t.id = f.id
          WHERE fts_all MATCH ?
          ORDER BY
            CASE WHEN t.community_name = ? THEN 0 ELSE 1 END,
            t.transaction_date DESC
          LIMIT ?
        `,
        [keyword.replace(/"/g, ""), keyword, limit],
      );
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    rows = rowsFromExec(
      db,
      `
        SELECT *
        FROM transactions
        WHERE community_name LIKE ?
           OR full_address LIKE ?
           OR building_no LIKE ?
           OR city LIKE ?
           OR district LIKE ?
           OR road LIKE ?
           OR source_batch LIKE ?
           OR raw_json LIKE ?
        ORDER BY
          CASE WHEN community_name = ? THEN 0 ELSE 1 END,
          transaction_date DESC
        LIMIT ?
      `,
      [like, like, like, like, like, like, like, like, keyword, limit],
    );
  }
  return withMeta("searchAll", city, started, rows);
}

async function loadCity(payload = {}) {
  const started = now();
  const city = payload.city;
  if (!city) throw new Error("city required");
  if (cityDbs.has(city)) {
    return { city, cached: true, info: metadata.cities?.[city], meta: meta("loadCity", city, 0, now() - started, true) };
  }
  const info = metadata.cities?.[city];
  if (!info?.gzip && !info?.path) throw new Error(`SQLite city DB unavailable: ${city}`);
  const loaded = await loadSqliteBytes(info.gzip || info.path, info.hash, "city", city);
  cityDbs.set(city, new SQL.Database(loaded.bytes));
  return { city, cached: loaded.cacheHit, info, meta: meta("loadCity", city, 0, now() - started, loaded.cacheHit) };
}

function cityDb(city) {
  const db = cityDbs.get(city);
  if (!db) throw new Error(`City DB not loaded: ${city}`);
  return db;
}

function txWhere(payload = {}) {
  const clauses = [];
  const params = [];
  const fieldMap = {
    city: { expr: "city", type: "string" },
    district: { expr: "district", type: "string" },
    community_name: { expr: "community_name", type: "string" },
    road: { expr: "road", type: "string" },
    full_address: { expr: "full_address", type: "string" },
    building_no: { expr: "building_no", type: "string" },
    transaction_date: { expr: "transaction_date", type: "date" },
    total_price: { expr: "total_price", type: "number" },
    unit_price_ping: { expr: "unit_price_ping", type: "number" },
    building_area_ping: { expr: "building_area_ping", type: "number" },
    land_area_ping: { expr: "land_area_ping", type: "number" },
    parking_price: { expr: "parking_price", type: "number" },
    building_age: { expr: "building_age", type: "number" },
    floor: { expr: "floor", type: "string" },
    total_floor: { expr: "total_floor", type: "string" },
    property_type: { expr: "property_type", type: "string" },
    transaction_target: { expr: "transaction_target", type: "string" },
    source_batch: { expr: "source_batch", type: "string" },
    has_parking: { expr: "has_parking", type: "boolean" },
    raw_json: { expr: "raw_json", type: "string" },
    repeat_sale: { expr: "repeat_sale", type: "boolean" },
  };

  function appendFilter(filter) {
    const field = fieldMap[filter?.field];
    if (!field) return;
    const op = String(filter.operator || "contains").toLowerCase();
    const value = filter.value;
    const value2 = filter.value2;
    if (field.expr === "repeat_sale") {
      const exists = "EXISTS (SELECT 1 FROM repeat_sales_summary rs WHERE rs.full_address = transactions.full_address AND rs.building_no = transactions.building_no)";
      clauses.push(value === false || value === "false" || value === "0" ? `NOT ${exists}` : exists);
      return;
    }
    if (field.type === "boolean") {
      clauses.push(`${field.expr} = ?`);
      params.push(value === true || value === "true" || value === "1" || value === 1 ? 1 : 0);
      return;
    }
    if (op === "between") {
      if (value === "" || value == null || value2 === "" || value2 == null) return;
      clauses.push(`${field.expr} BETWEEN ? AND ?`);
      params.push(field.type === "number" ? Number(value) : value, field.type === "number" ? Number(value2) : value2);
      return;
    }
    if (field.type === "number" && [">", ">=", "<", "<=", "="].includes(op)) {
      if (value === "" || value == null) return;
      clauses.push(`${field.expr} ${op} ?`);
      params.push(Number(value));
      return;
    }
    if (field.type === "date" && [">", ">=", "<", "<=", "="].includes(op)) {
      if (!value) return;
      clauses.push(`${field.expr} ${op} ?`);
      params.push(value);
      return;
    }
    const text = String(value || "");
    if (!text) return;
    if (op === "exact") {
      clauses.push(`${field.expr} = ?`);
      params.push(text);
    } else if (op === "starts") {
      clauses.push(`${field.expr} LIKE ?`);
      params.push(`${text}%`);
    } else if (op === "ends") {
      clauses.push(`${field.expr} LIKE ?`);
      params.push(`%${text}`);
    } else {
      clauses.push(`${field.expr} LIKE ?`);
      params.push(`%${text}%`);
    }
  }

  if (payload.city) {
    clauses.push("city = ?");
    params.push(payload.city);
  }
  if (payload.district) {
    clauses.push("district = ?");
    params.push(payload.district);
  }
  if (payload.communityName) {
    clauses.push("community_name = ?");
    params.push(payload.communityName);
  }
  if (payload.address) {
    clauses.push("full_address LIKE ?");
    params.push(`%${payload.address}%`);
  }
  if (payload.buildingNo) {
    clauses.push("building_no LIKE ?");
    params.push(`%${payload.buildingNo}%`);
  }
  if (payload.keyword) {
    clauses.push("(community_name LIKE ? OR full_address LIKE ? OR building_no LIKE ? OR source_batch LIKE ? OR raw_json LIKE ?)");
    const like = `%${payload.keyword}%`;
    params.push(like, like, like, like, like);
  }
  if (payload.bounds) {
    const south = Number(payload.bounds.south);
    const north = Number(payload.bounds.north);
    const west = Number(payload.bounds.west);
    const east = Number(payload.bounds.east);
    if ([south, north, west, east].every(Number.isFinite)) {
      clauses.push("lat BETWEEN ? AND ?");
      params.push(Math.min(south, north), Math.max(south, north));
      clauses.push("lng BETWEEN ? AND ?");
      params.push(Math.min(west, east), Math.max(west, east));
    }
  }
  for (const [key, col] of [
    ["priceMin", "total_price >= ?"],
    ["priceMax", "total_price <= ?"],
    ["unitPriceMin", "unit_price_ping >= ?"],
    ["unitPriceMax", "unit_price_ping <= ?"],
  ]) {
    if (payload[key] != null && payload[key] !== "") {
      clauses.push(col);
      params.push(Number(payload[key]));
    }
  }
  if (payload.dateFrom) {
    clauses.push("transaction_date >= ?");
    params.push(payload.dateFrom);
  }
  if (payload.dateTo) {
    clauses.push("transaction_date <= ?");
    params.push(payload.dateTo);
  }
  if (payload.hasParking != null) {
    clauses.push("has_parking = ?");
    params.push(payload.hasParking ? 1 : 0);
  }
  for (const filter of payload.filters || []) appendFilter(filter);
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function safeSort(sortBy = "full_address", sortDir = "ASC") {
  const columns = new Set([
    "city",
    "district",
    "community_name",
    "road",
    "transaction_date",
    "full_address",
    "building_no",
    "total_price",
    "unit_price_ping",
    "building_area_ping",
    "land_area_ping",
    "parking_price",
    "building_age",
    "floor",
    "total_floor",
    "property_type",
    "transaction_target",
    "has_parking",
    "source_batch",
  ]);
  const col = columns.has(sortBy) ? sortBy : "full_address";
  const dir = String(sortDir).toUpperCase() === "DESC" ? "DESC" : "ASC";
  return `${col} COLLATE NOCASE ${dir}, building_no COLLATE NOCASE ${dir}, transaction_date DESC`;
}

function queryTransactions(payload = {}) {
  const started = now();
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 100, 5000);
  const offset = Math.max(0, Number(payload.offset) || 0);
  const rows = rowsFromExec(
    db,
    `
      SELECT * FROM transactions
      ${where}
      ORDER BY ${safeSort(payload.sortBy, payload.sortDir)}
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
  const total = scalarFromExec(db, `SELECT COUNT(*) FROM transactions ${where}`, params);
  return withMeta("queryTransactions", payload.city, started, rows, false, { total, limit, offset });
}

function queryTransactionDetail(payload = {}) {
  const started = now();
  const db = cityDb(payload.city);
  const row = rowsFromExec(db, "SELECT * FROM transactions WHERE id = ? LIMIT 1", [payload.id])[0] || null;
  return { row, meta: meta("queryTransactionDetail", payload.city, row ? 1 : 0, now() - started, false) };
}

function queryRepeatSales(payload = {}) {
  const started = now();
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  const rows = rowsFromExec(
    db,
    `
      SELECT full_address, building_no, community_name, COUNT(*) AS count,
             MIN(transaction_date) AS first_date,
             MAX(transaction_date) AS last_date,
             MIN(total_price) AS min_price,
             MAX(total_price) AS max_price,
             MAX(total_price) - MIN(total_price) AS price_diff
      FROM transactions
      ${where}
      GROUP BY full_address, building_no
      HAVING COUNT(*) > 1
      ORDER BY count DESC, last_date DESC
      LIMIT ?
    `,
    [...params, Math.min(Number(payload.limit) || 100, 500)],
  );
  return withMeta("queryRepeatSales", payload.city, started, rows);
}

function queryMapAnnotations(payload = {}) {
  const started = now();
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 13, 9999);
  const zoom = Number(payload.zoom) || 14;
  const groupExpr = zoom < 10 ? "district" : zoom < 15 ? "community_name" : "full_address || building_no";
  const labelExpr = zoom < 10 ? "district" : zoom < 15 ? "community_name" : "full_address";
  const rows = rowsFromExec(
    db,
    `
      SELECT
        ${labelExpr} AS label,
        community_name,
        full_address,
        building_no,
        COUNT(*) AS tx_count,
        AVG(lat) AS lat,
        AVG(lng) AS lng,
        AVG(unit_price_ping) AS median_unit_price_ping,
        MIN(unit_price_ping) AS min_unit_price_ping,
        MAX(unit_price_ping) AS max_unit_price_ping,
        MAX(transaction_date) AS latest_transaction_date
      FROM transactions
      ${where}
      GROUP BY ${groupExpr}
      ORDER BY tx_count DESC, latest_transaction_date DESC
      LIMIT ?
    `,
    [...params, limit],
  );
  return withMeta("queryMapAnnotations", payload.city, started, rows);
}

function queryColumnAnalytics(payload = {}) {
  const started = now();
  const db = cityDb(payload.city);
  const fieldMap = {
    community_name: { expr: "community_name", type: "string" },
    district: { expr: "district", type: "string" },
    road: { expr: "road", type: "string" },
    transaction_target: { expr: "transaction_target", type: "string" },
    property_type: { expr: "property_type", type: "string" },
    source_batch: { expr: "source_batch", type: "string" },
    total_price: { expr: "total_price", type: "number" },
    unit_price_ping: { expr: "unit_price_ping", type: "number" },
    building_area_ping: { expr: "building_area_ping", type: "number" },
    land_area_ping: { expr: "land_area_ping", type: "number" },
    parking_price: { expr: "parking_price", type: "number" },
    building_age: { expr: "building_age", type: "number" },
  };
  const field = fieldMap[payload.field] || fieldMap.community_name;
  const { where, params } = txWhere(payload);
  let rows;
  if (field.type === "number") {
    rows = rowsFromExec(
      db,
      `
        SELECT COUNT(*) AS count,
               MIN(${field.expr}) AS min,
               AVG(${field.expr}) AS avg,
               MAX(${field.expr}) AS max
        FROM transactions
        ${where}
        AND ${field.expr} > 0
      `.replace(`${where}\n        AND`, where ? `${where}\n        AND` : "WHERE"),
      params,
    );
  } else {
    rows = rowsFromExec(
      db,
      `
        SELECT ${field.expr} AS value, COUNT(*) AS count
        FROM transactions
        ${where}
        GROUP BY ${field.expr}
        ORDER BY count DESC
        LIMIT 20
      `,
      params,
    );
  }
  return withMeta("queryColumnAnalytics", payload.city, started, rows);
}

const handlers = {
  init,
  searchCommunities,
  searchAll,
  queryCommunities,
  loadCity,
  queryTransactions,
  queryTransactionDetail,
  queryRepeatSales,
  queryMapAnnotations,
  queryColumnAnalytics,
  clearCache,
};

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (!handlers[type]) throw new Error(`Unknown query type: ${type}`);
    const result = await handlers[type](payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
});
