/* global initSqlJs */

let SQL;
let metadata;
let indexDb;
const shardDbs = new Map();

const DB_CACHE_NAME = "houseEx.sqliteCache";
const DB_CACHE_VERSION = 1;
const DB_STORE = "blobs";
const M2_PER_PING = 3.305785;

function status(phase, detail = {}) {
  self.postMessage({ type: "status", status: { phase, at: Date.now(), ...detail } });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/巿/g, "市")
    .replace(/臺/g, "台")
    .replace(/\s+/g, "")
}

function searchVariants(value) {
  const original = String(value || "").trim();
  const normalized = normalizeText(original);
  const variants = [original, normalized];
  if (normalized.includes("台")) variants.push(normalized.replace(/台/g, "臺"));
  if (normalized.includes("市")) variants.push(normalized.replace(/市/g, "巿"));
  return [...new Set(variants.filter(Boolean))];
}

function likeAny(expr, value) {
  const variants = searchVariants(value);
  return {
    clause: `(${variants.map(() => `${expr} LIKE ?`).join(" OR ")})`,
    params: variants.map((item) => `%${item}%`),
  };
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
    .filter((item) => item.kind === "city" || item.kind === "shard")
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  await Promise.all(rows.slice(12).map((item) => idbDelete(db, item.key)));
}

async function clearCache() {
  const started = now();
  const db = await openIdb();
  const rows = await idbAll(db);
  await Promise.all(rows.map((item) => idbDelete(db, item.key)));
  return withMeta("clearCache", "cache", started, [], false, { cleared: rows.length });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function fetchCompressedBytes(path, hash = "", detail = {}) {
  const url = hash ? `${path}?h=${encodeURIComponent(hash)}` : path;
  status("download-start", { path, url, ...detail });
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    status("download-progress", { path, loaded: bytes.byteLength, total, label: total ? `${formatBytes(bytes.byteLength)} / ${formatBytes(total)}` : formatBytes(bytes.byteLength), ...detail });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastNotice = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const nowMs = now();
    if (nowMs - lastNotice > 250) {
      lastNotice = nowMs;
      status("download-progress", {
        path,
        loaded,
        total,
        label: total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded),
        ...detail,
      });
    }
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  status("download-progress", { path, loaded, total, label: total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded), ...detail });
  return bytes;
}

async function decompressGzip(bytes) {
  if (!("DecompressionStream" in self)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadSqliteBytes(path, hash, kind, city = "", progressDetail = {}) {
  const key = `${kind}:${city || "index"}:${path}`;
  const db = await openIdb();
  status("cache-check", { kind, city, path, ...progressDetail });
  const cached = await idbGet(db, key);
  if (cached?.hash === hash && cached.bytes) {
    status("cache-hit", { kind, city, path, ...progressDetail });
    cached.lastUsed = Date.now();
    await idbPut(db, cached);
    status("decompress-start", { kind, city, path, ...progressDetail });
    const bytes = await decompressGzip(new Uint8Array(cached.bytes));
    status("db-ready", { kind, city, path, cacheHit: true, ...progressDetail });
    return { bytes, cacheHit: true };
  }
  const compressed = await fetchCompressedBytes(path, hash, { kind, city, ...progressDetail });
  status("cache-store", { kind, city, path, ...progressDetail });
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
  status("decompress-start", { kind, city, path, ...progressDetail });
  const bytes = await decompressGzip(compressed);
  status("db-ready", { kind, city, path, cacheHit: false, ...progressDetail });
  return { bytes, cacheHit: false };
}

async function ensureSql() {
  if (SQL) return SQL;
  status("wasm-start", { path: "vendor/sqljs/sql-wasm.wasm" });
  importScripts("vendor/sqljs/sql-wasm.js?v=20260531-sqlite-hardening");
  SQL = await initSqlJs({ locateFile: (file) => `vendor/sqljs/${file}` });
  status("wasm-ready", { path: "vendor/sqljs/sql-wasm.wasm" });
  return SQL;
}

async function init() {
  const started = now();
  await ensureSql();
  status("metadata-start", { path: "data/db/metadata.json" });
  const metadataResponse = await fetch("data/db/metadata.json", { cache: "no-cache" });
  if (!metadataResponse.ok) throw new Error("SQLite metadata not found");
  metadata = await metadataResponse.json();
  status("metadata-ready", { path: "data/db/metadata.json" });
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
  const limit = Math.min(Number(payload.limit) || 50, 200);
  const like = `%${keyword}%`;
  let rows = [];
  for (const { db } of cityDbsForPayload(payload)) {
    let shardRows = [];
    if (tableExists(db, "fts_all")) {
      try {
        shardRows = rowsFromExec(
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
        shardRows = [];
      }
    }
    if (!shardRows.length) {
      shardRows = rowsFromExec(
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
    rows.push(...shardRows);
  }
  rows = rows.slice(0, limit);
  return withMeta("searchAll", city, started, rows);
}

async function loadCity(payload = {}) {
  const started = now();
  const city = payload.city;
  if (!city) throw new Error("city required");
  const info = metadata.cities?.[city];
  if (!info) throw new Error(`SQLite city DB unavailable: ${city}`);
  const shards = shardInfos(city, payload.district);
  let cacheHit = true;
  status("city-load-start", { city, district: payload.district || "", shardCount: shards.length });
  for (const [index, shard] of shards.entries()) {
    const key = shardKey(city, shard.district || "");
    if (shardDbs.has(key)) continue;
    status("shard-open-start", {
      city,
      district: shard.district || "",
      path: shard.gzip || shard.path,
      shardIndex: index + 1,
      shardCount: shards.length,
    });
    const loaded = await loadSqliteBytes(
      shard.gzip || shard.path,
      shard.hash,
      info.shardMode === "district" ? "shard" : "city",
      key,
      {
        city,
        district: shard.district || "",
        shardIndex: index + 1,
        shardCount: shards.length,
      },
    );
    cacheHit = cacheHit && loaded.cacheHit;
    shardDbs.set(key, new SQL.Database(loaded.bytes));
    status("shard-open-ready", {
      city,
      district: shard.district || "",
      path: shard.gzip || shard.path,
      shardIndex: index + 1,
      shardCount: shards.length,
      cacheHit: loaded.cacheHit,
    });
  }
  status("city-load-ready", { city, district: payload.district || "", shardCount: shards.length, cacheHit });
  return { city, cached: cacheHit, info, shardCount: shards.length, meta: meta("loadCity", city, shards.length, now() - started, cacheHit) };
}

function shardKey(city, district = "") {
  return `${city}|${district || "*"}`;
}

function shardInfos(city, district = "") {
  const info = metadata.cities?.[city];
  if (!info) throw new Error(`SQLite city DB unavailable: ${city}`);
  if (info.shardMode !== "district") return [{ ...info, district: "" }];
  if (district) {
    const shard = info.districts?.[district];
    if (!shard) throw new Error(`SQLite district DB unavailable: ${city} ${district}`);
    return shard.shards || [shard];
  }
  return info.shards || Object.values(info.districts || {});
}

function cityDbsForPayload(payload = {}) {
  return shardInfos(payload.city, payload.district).map((shard) => {
    const key = shardKey(payload.city, shard.district || "");
    const db = shardDbs.get(key);
    if (!db) throw new Error(`SQLite shard not loaded: ${payload.city} ${shard.district || ""}`);
    return { db, shard };
  });
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
    if (op === "notIn") {
      const values = Array.isArray(value) ? value.filter(Boolean) : String(value || "").split(/[,\s，、]+/).filter(Boolean);
      if (!values.length) return;
      clauses.push(`${field.expr} NOT IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
      return;
    }
    if (field.type === "boolean") {
      const boolValue = value === true || value === "true" || value === "1" || value === 1 ? 1 : 0;
      clauses.push(`${field.expr} ${op === "!=" || op === "not" ? "!=" : "="} ?`);
      params.push(boolValue);
      return;
    }
    if (op === "anycontains") {
      const values = Array.isArray(value) ? value : String(value || "").split(/[,\s，、]+/).filter(Boolean);
      if (!values.length) return;
      const variants = [...new Set(values.flatMap(searchVariants))];
      clauses.push(`(${variants.map(() => `${field.expr} LIKE ?`).join(" OR ")})`);
      params.push(...variants.map((item) => `%${item}%`));
      return;
    }
    if (op === "notcontains") {
      const variants = searchVariants(value);
      if (!variants.length) return;
      clauses.push(`(${variants.map(() => `${field.expr} NOT LIKE ?`).join(" AND ")} OR ${field.expr} IS NULL)`);
      params.push(...variants.map((item) => `%${item}%`));
      return;
    }
    if (op === "between") {
      if (value === "" || value == null || value2 === "" || value2 == null) return;
      clauses.push(`${field.expr} BETWEEN ? AND ?`);
      params.push(field.type === "number" ? Number(value) : value, field.type === "number" ? Number(value2) : value2);
      return;
    }
    if (field.type === "number" && [">", ">=", "<", "<=", "=", "!="].includes(op)) {
      if (value === "" || value == null) return;
      clauses.push(`${field.expr} ${op} ?`);
      params.push(Number(value));
      return;
    }
    if (field.type === "date" && [">", ">=", "<", "<=", "=", "!="].includes(op)) {
      if (!value) return;
      clauses.push(`${field.expr} ${op} ?`);
      params.push(value);
      return;
    }
    const text = String(value || "");
    if (!text) return;
    if (op === "!=" || op === "not") {
      clauses.push(`(${field.expr} != ? OR ${field.expr} IS NULL)`);
      params.push(text);
    } else if (op === "exact") {
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
    const match = likeAny("full_address", payload.address);
    clauses.push(match.clause);
    params.push(...match.params);
  }
  if (payload.buildingNo) {
    const match = likeAny("building_no", payload.buildingNo);
    clauses.push(match.clause);
    params.push(...match.params);
  }
  if (payload.keyword) {
    const variants = searchVariants(payload.keyword);
    clauses.push(`(${variants.map(() => "(community_name LIKE ? OR full_address LIKE ? OR building_no LIKE ? OR source_batch LIKE ? OR raw_json LIKE ?)").join(" OR ")})`);
    variants.forEach((item) => {
      const like = `%${item}%`;
      params.push(like, like, like, like, like);
    });
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

function compareValues(a, b, dir = "ASC") {
  const av = a == null ? "" : a;
  const bv = b == null ? "" : b;
  let result;
  if (typeof av === "number" || typeof bv === "number") result = Number(av || 0) - Number(bv || 0);
  else result = String(av).localeCompare(String(bv), "zh-Hant", { numeric: true });
  return dir === "DESC" ? -result : result;
}

function sortRows(rows, sortBy = "full_address", sortDir = "ASC") {
  const dir = String(sortDir).toUpperCase() === "DESC" ? "DESC" : "ASC";
  return rows.sort((a, b) => (
    compareValues(a[sortBy], b[sortBy], dir)
    || compareValues(a.building_no, b.building_no, dir)
    || compareValues(a.transaction_date, b.transaction_date, "DESC")
  ));
}

function queryTransactions(payload = {}) {
  const started = now();
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 100, 5000);
  const offset = Math.max(0, Number(payload.offset) || 0);
  const fetchLimit = limit + offset;
  let rows = [];
  let total = 0;
  for (const { db } of cityDbsForPayload(payload)) {
    rows.push(...rowsFromExec(
      db,
      `
        SELECT * FROM transactions
        ${where}
        ORDER BY ${safeSort(payload.sortBy, payload.sortDir)}
        LIMIT ?
      `,
      [...params, fetchLimit],
    ));
    total += scalarFromExec(db, `SELECT COUNT(*) FROM transactions ${where}`, params);
  }
  rows = sortRows(rows, payload.sortBy, payload.sortDir).slice(offset, offset + limit);
  return withMeta("queryTransactions", payload.city, started, rows, false, { total, limit, offset });
}

function queryTransactionDetail(payload = {}) {
  const started = now();
  let row = null;
  for (const { db } of cityDbsForPayload(payload)) {
    row = rowsFromExec(db, "SELECT * FROM transactions WHERE id = ? LIMIT 1", [payload.id])[0] || null;
    if (row) break;
  }
  return { row, meta: meta("queryTransactionDetail", payload.city, row ? 1 : 0, now() - started, false) };
}

function queryRepeatSales(payload = {}) {
  const started = now();
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 100, 500);
  let rows = [];
  for (const { db } of cityDbsForPayload(payload)) {
    rows.push(...rowsFromExec(
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
      [...params, limit],
    ));
  }
  rows = rows.sort((a, b) => (b.count - a.count) || String(b.last_date).localeCompare(String(a.last_date))).slice(0, limit);
  return withMeta("queryRepeatSales", payload.city, started, rows);
}

function queryMapAnnotations(payload = {}) {
  const started = now();
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 13, 9999);
  const zoom = Number(payload.zoom) || 14;
  const groupExpr = zoom < 10 ? "district" : zoom < 15 ? "community_name" : "full_address || building_no";
  const labelExpr = zoom < 10 ? "district" : zoom < 15 ? "community_name" : "full_address";
  let rows = [];
  for (const { db } of cityDbsForPayload(payload)) {
    rows.push(...rowsFromExec(
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
    ));
  }
  rows = rows.sort((a, b) => (b.tx_count - a.tx_count) || String(b.latest_transaction_date).localeCompare(String(a.latest_transaction_date))).slice(0, limit);
  return withMeta("queryMapAnnotations", payload.city, started, rows);
}

function queryColumnAnalytics(payload = {}) {
  const started = now();
  const fieldMap = {
    community_name: { expr: "community_name", type: "string" },
    city: { expr: "city", type: "string" },
    district: { expr: "district", type: "string" },
    road: { expr: "road", type: "string" },
    full_address: { expr: "full_address", type: "string" },
    building_no: { expr: "building_no", type: "string" },
    transaction_date: { expr: "transaction_date", type: "string" },
    transaction_target: { expr: "transaction_target", type: "string" },
    property_type: { expr: "property_type", type: "string" },
    source_batch: { expr: "source_batch", type: "string" },
    has_parking: { expr: "has_parking", type: "string" },
    floor: { expr: "floor", type: "string" },
    total_floor: { expr: "total_floor", type: "string" },
    raw_json: { expr: "raw_json", type: "string" },
    total_price: { expr: "total_price", type: "number" },
    unit_price_ping: { expr: "unit_price_ping", type: "number" },
    building_area_ping: { expr: "building_area_ping", type: "number" },
    land_area_ping: { expr: "land_area_ping", type: "number" },
    parking_price: { expr: "parking_price", type: "number" },
    building_age: { expr: "building_age", type: "number" },
  };
  const field = fieldMap[payload.field];
  if (!field) return withMeta("queryColumnAnalytics", payload.city, started, []);
  const { where, params } = txWhere(payload);
  let rows;
  if (field.type === "number") {
    const numberWhere = where
      ? `${where} AND ${field.expr} > 0`
      : `WHERE ${field.expr} > 0`;
    const partials = cityDbsForPayload(payload).flatMap(({ db }) => rowsFromExec(
        db,
        `
          SELECT COUNT(*) AS count,
                 MIN(${field.expr}) AS min,
                 AVG(${field.expr}) AS avg,
                 MAX(${field.expr}) AS max
          FROM transactions
          ${numberWhere}
        `,
        params,
      ));
    const count = partials.reduce((sum, row) => sum + Number(row.count || 0), 0);
    const weighted = partials.reduce((sum, row) => sum + Number(row.avg || 0) * Number(row.count || 0), 0);
    rows = [{
      count,
      min: Math.min(...partials.map((row) => Number(row.min || Infinity))),
      avg: count ? weighted / count : 0,
      max: Math.max(...partials.map((row) => Number(row.max || 0))),
    }];
  } else {
    const counts = new Map();
    const limit = Math.min(Number(payload.limit) || 20, 200);
    for (const { db } of cityDbsForPayload(payload)) {
      for (const row of rowsFromExec(
        db,
        `
          SELECT ${field.expr} AS value, COUNT(*) AS count
          FROM transactions
          ${where}
          GROUP BY ${field.expr}
          ORDER BY count DESC
          LIMIT ?
        `,
        [...params, limit],
      )) {
        const key = row.value || "";
        counts.set(key, (counts.get(key) || 0) + Number(row.count || 0));
      }
    }
    rows = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
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
