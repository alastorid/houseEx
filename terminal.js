const FILTER_PRESETS_KEY = "houseEx.terminalPresets";
const PAGE_SIZE = 220;

const columns = [
  ["transaction_date", "日期", "date"],
  ["city", "縣市", "string"],
  ["district", "鄉鎮", "string"],
  ["community_name", "社區", "string"],
  ["road", "路名", "string"],
  ["full_address", "地址", "string"],
  ["building_no", "棟及號", "string"],
  ["building_area_ping", "建坪", "number"],
  ["land_area_ping", "地坪", "number"],
  ["total_price", "總價", "number"],
  ["unit_price_ping", "單價/坪", "number"],
  ["has_parking", "車位", "boolean"],
  ["parking_price", "車位價格", "number"],
  ["building_age", "屋齡", "number"],
  ["floor", "樓層", "string"],
  ["total_floor", "總樓層", "string"],
  ["property_type", "型態", "string"],
  ["transaction_target", "標的", "string"],
  ["source_batch", "來源", "string"],
  ["repeat_sale", "重複轉手", "boolean"],
  ["raw_json", "Raw", "string"],
];

const operators = {
  number: [">", ">=", "<", "<=", "=", "between"],
  date: [">", ">=", "<", "<=", "=", "between"],
  string: ["contains", "starts", "ends", "exact"],
  boolean: ["=", "!="],
};

const state = {
  metadata: null,
  city: "彰化縣",
  district: "",
  keyword: "",
  filters: [],
  rows: [],
  total: 0,
  offset: 0,
  loading: false,
  sortBy: "transaction_date",
  sortDir: "DESC",
};

const el = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const ping = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function setMeta(meta) {
  if (!meta) return;
  el("#perfBadge").textContent = `SQLite · ${meta.db} · ${money.format(meta.rowCount || 0)} rows · ${meta.elapsedMs}ms${meta.cacheHit ? " · cache" : ""}`;
}

function fieldDef(field) {
  return columns.find(([key]) => key === field) || columns[0];
}

function displayValue(row, field) {
  const value = row[field];
  if (field === "total_price" || field === "parking_price") return value ? `${money.format(value / 10000)}萬` : "";
  if (field === "unit_price_ping") return value ? money.format(value) : "";
  if (field.endsWith("_ping") || field === "building_age") return value ? ping.format(value) : "";
  if (field === "has_parking") return value ? "有" : "無";
  if (field === "raw_json") return value ? "JSON" : "";
  return value || "";
}

function populateFields() {
  el("#fieldSelect").innerHTML = columns
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join("");
  updateOperators();
}

function updateOperators() {
  const type = fieldDef(el("#fieldSelect").value)[2];
  el("#operatorSelect").innerHTML = operators[type]
    .map((op) => `<option value="${op}">${op}</option>`)
    .join("");
  el("#filterValue2").style.display = el("#operatorSelect").value === "between" ? "block" : "none";
}

function filterPayload() {
  const filters = [...state.filters];
  if (state.district) filters.push({ field: "district", operator: "exact", value: state.district });
  return {
    city: state.city,
    keyword: state.keyword,
    filters,
    sortBy: state.sortBy,
    sortDir: state.sortDir,
    limit: PAGE_SIZE,
    offset: state.offset,
  };
}

async function runQuery({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  await queryService.loadCity({ city: state.city });
  const result = await queryService.queryTransactions(filterPayload());
  setMeta(result.meta);
  state.total = result.total || 0;
  state.rows = append ? [...state.rows, ...(result.rows || [])] : result.rows || [];
  renderRows();
  state.loading = false;
}

function renderHead() {
  el("#gridHead").innerHTML = `<tr>${columns.slice(0, 19).map(([key, label]) => `
    <th><button type="button" data-sort="${key}" data-analytics="${key}">${label}${state.sortBy === key ? (state.sortDir === "ASC" ? " ▲" : " ▼") : ""}</button></th>
  `).join("")}</tr>`;
}

function renderRows() {
  renderHead();
  el("#resultMeta").textContent = `顯示 ${money.format(state.rows.length)} / ${money.format(state.total)} 筆`;
  el("#gridRows").innerHTML = state.rows.map((row) => `
    <tr>${columns.slice(0, 19).map(([key]) => `<td title="${String(displayValue(row, key)).replace(/"/g, "&quot;")}">${displayValue(row, key)}</td>`).join("")}</tr>
  `).join("");
}

function renderFilters() {
  el("#activeFilters").innerHTML = state.filters.map((filter, index) => {
    const label = fieldDef(filter.field)[1];
    const value = filter.operator === "between" ? `${filter.value} ~ ${filter.value2}` : filter.value;
    return `<span class="filter-chip">${label} ${filter.operator} ${value}<button type="button" data-remove-filter="${index}">×</button></span>`;
  }).join("");
}

function convertValue(field, value) {
  if (field === "total_price" || field === "parking_price") return Number(value) * 10000;
  if (field === "unit_price_ping") return Number(value) * 10000;
  return value;
}

function addFilter(field, operator, value, value2 = "") {
  state.filters.push({
    field,
    operator,
    value: convertValue(field, value),
    value2: convertValue(field, value2),
  });
  state.offset = 0;
  renderFilters();
  runQuery();
}

function readPresets() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_PRESETS_KEY) || "[]");
  } catch {
    return [];
  }
}

function savePresets(items) {
  localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(items.slice(0, 20)));
  renderPresets();
}

function renderPresets() {
  el("#savedPresets").innerHTML = readPresets().map((item, index) => `
    <span class="filter-chip"><button type="button" data-load-preset="${index}">${item.name}</button><button type="button" data-delete-preset="${index}">×</button></span>
  `).join("");
}

async function showAnalytics(field) {
  const [key, label, type] = fieldDef(field);
  const result = await queryService.queryColumnAnalytics({ ...filterPayload(), field: key });
  setMeta(result.meta);
  el("#analyticsTitle").textContent = label;
  if (type === "number") {
    const row = result.rows[0] || {};
    el("#analyticsBody").innerHTML = ["count", "min", "avg", "max"].map((name) => `
      <div class="stat-line"><span>${name}</span><strong>${name === "count" ? money.format(row[name] || 0) : ping.format(row[name] || 0)}</strong></div>
    `).join("");
    return;
  }
  el("#analyticsBody").innerHTML = result.rows.map((row) => `
    <div class="stat-line"><span>${row.value || "(blank)"}</span><strong>${money.format(row.count || 0)}</strong></div>
  `).join("");
}

function applyBuiltInPreset(name) {
  const currentYear = new Date().getFullYear();
  const presets = {
    newer: [{ field: "building_age", operator: "<", value: 5 }],
    largeLow: [
      { field: "building_area_ping", operator: ">", value: 40 },
      { field: "total_price", operator: "<", value: 12000000 },
    ],
    parking: [{ field: "has_parking", operator: "=", value: true }],
    repeat: [{ field: "repeat_sale", operator: "=", value: true }],
    recent: [{ field: "transaction_date", operator: ">=", value: `${currentYear}-01-01` }],
  };
  state.filters = presets[name] || [];
  state.offset = 0;
  renderFilters();
  runQuery();
}

async function init() {
  const initResult = await queryService.init();
  state.metadata = initResult.metadata;
  setMeta(initResult.meta);
  el("#citySelect").innerHTML = Object.keys(state.metadata.cities || {})
    .map((city) => `<option value="${city}">${city}</option>`)
    .join("");
  el("#citySelect").value = state.city;
  const districts = await queryService.queryCommunities({ city: state.city, limit: 2000 });
  const districtNames = [...new Set((districts.rows || []).map((row) => row.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  el("#districtSelect").innerHTML = `<option value="">全部</option>${districtNames.map((name) => `<option value="${name}">${name}</option>`).join("")}`;
  populateFields();
  renderPresets();
  await runQuery();
}

function bind() {
  el("#fieldSelect").addEventListener("change", updateOperators);
  el("#operatorSelect").addEventListener("change", updateOperators);
  el("#addFilter").addEventListener("click", () => addFilter(el("#fieldSelect").value, el("#operatorSelect").value, el("#filterValue").value, el("#filterValue2").value));
  el("#keywordInput").addEventListener("input", () => {
    clearTimeout(bind.keywordTimer);
    bind.keywordTimer = setTimeout(() => {
      state.keyword = el("#keywordInput").value.trim();
      state.offset = 0;
      runQuery();
    }, 180);
  });
  el("#districtSelect").addEventListener("change", () => {
    state.district = el("#districtSelect").value;
    state.offset = 0;
    runQuery();
  });
  el("#activeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-filter]");
    if (!button) return;
    state.filters.splice(Number(button.dataset.removeFilter), 1);
    state.offset = 0;
    renderFilters();
    runQuery();
  });
  el("#gridHead").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    const field = button.dataset.sort;
    if (state.sortBy === field) state.sortDir = state.sortDir === "ASC" ? "DESC" : "ASC";
    else {
      state.sortBy = field;
      state.sortDir = "ASC";
    }
    state.offset = 0;
    showAnalytics(field);
    runQuery();
  });
  el("#gridWrap").addEventListener("scroll", () => {
    const wrap = el("#gridWrap");
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 120 || state.rows.length >= state.total) return;
    state.offset = state.rows.length;
    runQuery({ append: true });
  });
  el(".preset-bar").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (button) applyBuiltInPreset(button.dataset.preset);
  });
  el("#savePreset").addEventListener("click", () => {
    const name = el("#presetName").value.trim();
    if (!name) return;
    savePresets([{ name, filters: state.filters }, ...readPresets().filter((item) => item.name !== name)]);
  });
  el("#savedPresets").addEventListener("click", (event) => {
    const load = event.target.closest("[data-load-preset]");
    const del = event.target.closest("[data-delete-preset]");
    const presets = readPresets();
    if (load) {
      state.filters = presets[Number(load.dataset.loadPreset)]?.filters || [];
      state.offset = 0;
      renderFilters();
      runQuery();
    }
    if (del) {
      presets.splice(Number(del.dataset.deletePreset), 1);
      savePresets(presets);
    }
  });
}

bind();
init().catch((error) => {
  el("#resultMeta").textContent = error.message;
  console.error(error);
});
