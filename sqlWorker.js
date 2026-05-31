/* global initSqlJs */

let SQL;
let metadata;
let indexDb;
const cityDbs = new Map();

const M2_PER_PING = 3.305785;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

async function loadGzipBytes(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  if (!("DecompressionStream" in self)) return new Uint8Array(await response.arrayBuffer());
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function ensureSql() {
  if (SQL) return SQL;
  importScripts("vendor/sqljs/sql-wasm.js?v=20260531-sqlite-worker");
  SQL = await initSqlJs({ locateFile: (file) => `vendor/sqljs/${file}` });
  return SQL;
}

async function init() {
  await ensureSql();
  const metadataResponse = await fetch(`data/db/metadata.json?v=${Date.now()}`, { cache: "no-store" });
  if (!metadataResponse.ok) throw new Error("SQLite metadata not found");
  metadata = await metadataResponse.json();
  const bytes = await loadGzipBytes(metadata.index.gzip);
  indexDb = new SQL.Database(bytes);
  return metadata;
}

function rowsFromExec(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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
  const { where, params } = communityWhere(payload);
  const limit = Math.min(Number(payload.limit) || 500, 2000);
  const offset = Number(payload.offset) || 0;
  return rowsFromExec(
    indexDb,
    `
      SELECT * FROM communities
      ${where}
      ORDER BY transaction_count DESC, latest_transaction_date DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
}

function searchCommunities(payload = {}) {
  const keyword = String(payload.keyword || "").trim();
  if (!keyword) return [];
  const normalized = normalizeText(keyword);
  const limit = Math.min(Number(payload.limit) || 20, 100);
  return rowsFromExec(
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
}

async function loadCity(payload = {}) {
  const city = payload.city;
  if (!city) throw new Error("city required");
  if (cityDbs.has(city)) return { city, cached: true };
  const info = metadata.cities?.[city];
  if (!info?.gzip) throw new Error(`SQLite city DB unavailable: ${city}`);
  const bytes = await loadGzipBytes(info.gzip);
  cityDbs.set(city, new SQL.Database(bytes));
  return { city, cached: false, info };
}

function cityDb(city) {
  const db = cityDbs.get(city);
  if (!db) throw new Error(`City DB not loaded: ${city}`);
  return db;
}

function txWhere(payload = {}) {
  const clauses = [];
  const params = [];
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
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function safeSort(sortBy = "full_address", sortDir = "ASC") {
  const columns = new Set([
    "transaction_date",
    "full_address",
    "building_no",
    "total_price",
    "unit_price_ping",
    "building_area_ping",
    "source_batch",
  ]);
  const col = columns.has(sortBy) ? sortBy : "full_address";
  const dir = String(sortDir).toUpperCase() === "DESC" ? "DESC" : "ASC";
  return `${col} COLLATE NOCASE ${dir}, building_no COLLATE NOCASE ${dir}, transaction_date DESC`;
}

function queryTransactions(payload = {}) {
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 500, 5000);
  const offset = Number(payload.offset) || 0;
  return rowsFromExec(
    db,
    `
      SELECT * FROM transactions
      ${where}
      ORDER BY ${safeSort(payload.sortBy, payload.sortDir)}
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
}

function queryTransactionDetail(payload = {}) {
  const db = cityDb(payload.city);
  return rowsFromExec(db, "SELECT * FROM transactions WHERE id = ? LIMIT 1", [payload.id])[0] || null;
}

function queryRepeatSales(payload = {}) {
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  return rowsFromExec(
    db,
    `
      SELECT full_address, building_no, community_name, COUNT(*) AS count,
             MIN(transaction_date) AS first_date,
             MAX(transaction_date) AS last_date,
             MIN(total_price) AS min_price,
             MAX(total_price) AS max_price
      FROM transactions
      ${where}
      GROUP BY full_address, building_no
      HAVING COUNT(*) > 1
      ORDER BY count DESC, last_date DESC
      LIMIT ?
    `,
    [...params, Math.min(Number(payload.limit) || 100, 500)],
  );
}

function queryMapAnnotations(payload = {}) {
  const db = cityDb(payload.city);
  const { where, params } = txWhere(payload);
  const limit = Math.min(Number(payload.limit) || 13, 9999);
  return rowsFromExec(
    db,
    `
      SELECT community_name, full_address, building_no,
             COUNT(*) AS count,
             AVG(unit_price_ping) AS median_unit_price_ping,
             AVG(lat) AS lat,
             AVG(lng) AS lng,
             MAX(transaction_date) AS latest_transaction_date
      FROM transactions
      ${where}
      GROUP BY CASE WHEN ? < 16 THEN community_name ELSE full_address || building_no END
      ORDER BY count DESC, latest_transaction_date DESC
      LIMIT ?
    `,
    [...params, Number(payload.zoom) || 14, limit],
  );
}

const handlers = {
  init,
  searchCommunities,
  queryCommunities,
  loadCity,
  queryTransactions,
  queryTransactionDetail,
  queryRepeatSales,
  queryMapAnnotations,
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
