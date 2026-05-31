const FILTER_PRESETS_KEY = "houseEx.terminalPresets";
const COLUMN_KEY = "houseEx.terminalColumns";
const PAGE_SIZE = 240;

const columns = [
  ["transaction_date", "日期", "date", 98],
  ["city", "縣市", "string", 86],
  ["district", "鄉鎮", "string", 86],
  ["community_name", "社區", "string", 132],
  ["road", "路名", "string", 116],
  ["full_address", "地址", "string", 260],
  ["building_no", "棟及號", "string", 108],
  ["building_area_ping", "建坪", "number", 80],
  ["land_area_ping", "地坪", "number", 80],
  ["total_price", "總價", "money", 92],
  ["unit_price_ping", "單價/坪", "unitMoney", 90],
  ["has_parking", "車位", "boolean", 66],
  ["parking_price", "車位價格", "money", 96],
  ["building_age", "屋齡", "number", 72],
  ["floor", "樓層", "string", 84],
  ["total_floor", "總樓層", "string", 80],
  ["property_type", "型態", "string", 128],
  ["transaction_target", "標的", "string", 142],
  ["source_batch", "來源", "string", 82],
  ["repeat_sale", "重複轉手", "boolean", 86],
  ["raw_json", "Raw", "string", 72],
];

const operators = {
  number: [">", ">=", "<", "<=", "=", "between"],
  money: [">", ">=", "<", "<=", "=", "between"],
  unitMoney: [">", ">=", "<", "<=", "=", "between"],
  date: [">", ">=", "<", "<=", "=", "between"],
  string: ["contains", "notContains", "starts", "ends", "exact", "anyContains"],
  boolean: ["=", "!="],
};

const state = {
  metadata: null,
  city: "彰化縣",
  district: "",
  excludedDistricts: [],
  keyword: "",
  filters: [],
  rows: [],
  total: 0,
  offset: 0,
  loading: false,
  analyticsLoading: false,
  sortBy: "transaction_date",
  sortDir: "DESC",
  visibleColumns: columns.map(([key]) => key).filter((key) => key !== "raw_json"),
  widths: Object.fromEntries(columns.map(([key, , , width]) => [key, width])),
};

const el = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function loadColumnPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_KEY) || "{}");
    if (Array.isArray(saved.visibleColumns)) state.visibleColumns = saved.visibleColumns;
    if (saved.widths) state.widths = { ...state.widths, ...saved.widths };
  } catch {}
}

function saveColumnPrefs() {
  localStorage.setItem(COLUMN_KEY, JSON.stringify({ visibleColumns: state.visibleColumns, widths: state.widths }));
}

function setMeta(meta) {
  if (!meta) return;
  el("#perfBadge").textContent = `SQLite · ${meta.db} · ${money.format(meta.rowCount || 0)} rows · ${meta.elapsedMs}ms${meta.cacheHit ? " · cache" : ""}`;
}

function fieldDef(field) {
  return columns.find(([key]) => key === field) || columns[0];
}

function visibleColumnDefs() {
  return columns.filter(([key]) => state.visibleColumns.includes(key));
}

function displayValue(row, field) {
  const value = row[field];
  if (field === "total_price" || field === "parking_price") return value ? `${money.format(value / 10000)}萬` : "";
  if (field === "unit_price_ping") return value ? `${decimal.format(value / 10000)}萬` : "";
  if (field.endsWith("_ping") || field === "building_age") return value ? decimal.format(value) : "";
  if (field === "has_parking") return value ? "有" : "無";
  if (field === "repeat_sale") return value ? "是" : "";
  if (field === "raw_json") return value ? "JSON" : "";
  return value || "";
}

function cellHtml(row, field) {
  const value = displayValue(row, field);
  const title = String(value).replace(/"/g, "&quot;");
  if (field === "full_address" && row.full_address) {
    return `<td ${widthStyle(field)}><button class="address-cell" type="button" data-map-address="${String(row.full_address).replace(/"/g, "&quot;")}">${value}</button></td>`;
  }
  return `<td ${widthStyle(field)} title="${title}">${value}</td>`;
}

function filterPayload() {
  const filters = [...state.filters];
  if (state.district) filters.push({ field: "district", operator: "exact", value: state.district });
  if (state.excludedDistricts.length) filters.push({ field: "district", operator: "notIn", value: state.excludedDistricts });
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

async function reloadDistricts() {
  const result = await queryService.queryCommunities({ city: state.city, limit: 2000 });
  const names = [...new Set((result.rows || []).map((row) => row.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  el("#districtSelect").innerHTML = `<option value="">全部</option>${names.map((name) => `<option value="${name}">${name}</option>`).join("")}`;
  el("#districtSelect").value = state.district;
}

async function runQuery({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    await queryService.loadCity({ city: state.city });
    const result = await queryService.queryTransactions(filterPayload());
    setMeta(result.meta);
    state.total = result.total || 0;
    state.rows = append ? [...state.rows, ...(result.rows || [])] : result.rows || [];
    renderRows();
    if (!append) refreshRangeHints();
    if (!append) refreshTownTags();
  } finally {
    state.loading = false;
  }
}

async function refreshTownTags() {
  const result = await queryService.queryColumnAnalytics({ ...filterPayload(), field: "district" });
  const rows = result.rows || [];
  el("#townTags").innerHTML = rows.map((row) => {
    const district = row.value || "";
    const active = !state.excludedDistricts.includes(district);
    return `<button type="button" class="${active ? "active" : ""}" data-town-tag="${district}">${district} <span>${money.format(row.count || 0)}</span></button>`;
  }).join("");
}

async function refreshRangeHints() {
  if (state.analyticsLoading || !state.city) return;
  state.analyticsLoading = true;
  try {
    const baseRows = state.rows.length ? state.rows : [];
    for (const [field, minId, maxId, formatter] of [
      ["building_area_ping", "buildingMin", "buildingMax", (v) => decimal.format(v)],
      ["land_area_ping", "landMin", "landMax", (v) => decimal.format(v)],
      ["total_price", "priceMin", "priceMax", (v) => money.format(v / 10000)],
      ["unit_price_ping", "unitMin", "unitMax", (v) => decimal.format(v / 10000)],
    ]) {
      const values = baseRows.map((row) => Number(row[field]) || 0).filter((value) => value > 0);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 0;
      el(`#${minId}`).placeholder = min ? `min ${formatter(min)}` : "min";
      el(`#${maxId}`).placeholder = max ? `max ${formatter(max)}` : "max";
    }
  } finally {
    state.analyticsLoading = false;
  }
}

function populateFields() {
  el("#fieldSelect").innerHTML = columns.map(([key, label]) => `<option value="${key}">${label}</option>`).join("");
  updateOperators();
}

function updateOperators() {
  const type = fieldDef(el("#fieldSelect").value)[2];
  el("#operatorSelect").innerHTML = operators[type].map((op) => `<option value="${op}">${op}</option>`).join("");
  el("#filterValue2").style.display = el("#operatorSelect").value === "between" ? "block" : "none";
}

function widthStyle(key) {
  return `style="width:${state.widths[key] || 100}px"`;
}

function renderHead() {
  el("#gridHead").innerHTML = `<tr>${visibleColumnDefs().map(([key, label]) => `
    <th ${widthStyle(key)} data-field="${key}">
      <button type="button" data-sort="${key}" data-analytics="${key}">${label}${state.sortBy === key ? (state.sortDir === "ASC" ? " ▲" : " ▼") : ""}</button>
      <span class="resize-handle" data-resize="${key}"></span>
    </th>
  `).join("")}</tr>`;
}

function renderRows() {
  renderHead();
  el("#resultMeta").textContent = `顯示 ${money.format(state.rows.length)} / ${money.format(state.total)} 筆`;
  const cols = visibleColumnDefs();
  el("#gridRows").innerHTML = state.rows.map((row) => `
    <tr>${cols.map(([key]) => cellHtml(row, key)).join("")}</tr>
  `).join("");
  renderColumnsPopover();
}

function humanFilter(filter) {
  const label = fieldDef(filter.field)[1];
  let value = filter.value;
  let value2 = filter.value2;
  if (filter.field === "total_price" || filter.field === "parking_price") {
    value = value ? `${Number(value) / 10000}萬` : value;
    value2 = value2 ? `${Number(value2) / 10000}萬` : value2;
  }
  if (filter.field === "unit_price_ping") {
    value = value ? `${Number(value) / 10000}萬/坪` : value;
    value2 = value2 ? `${Number(value2) / 10000}萬/坪` : value2;
  }
  if (Array.isArray(value)) value = value.join(" OR ");
  return `${label} ${filter.operator} ${filter.operator === "between" ? `${value}~${value2}` : value}`;
}

function renderFilters() {
  el("#activeFilters").innerHTML = state.filters.map((filter, index) => (
    `<span class="filter-chip">${humanFilter(filter)}<button type="button" data-remove-filter="${index}">×</button></span>`
  )).join("");
}

function convertValue(field, value) {
  if (value === "" || value == null) return "";
  if (field === "total_price" || field === "parking_price") return Number(value) * 10000;
  if (field === "unit_price_ping") return Number(value) * 10000;
  return value;
}

function addFilter(field, operator, value, value2 = "") {
  if (value === "" && operator !== "=" && operator !== "!=") return;
  state.filters.push({
    field,
    operator,
    value: Array.isArray(value) ? value : convertValue(field, value),
    value2: convertValue(field, value2),
  });
  state.offset = 0;
  renderFilters();
  runQuery();
}

function removeAutoFilters(fields) {
  state.filters = state.filters.filter((filter) => !fields.includes(filter.field));
}

function applyRangeFilters() {
  removeAutoFilters(["building_area_ping", "land_area_ping", "total_price", "unit_price_ping"]);
  for (const [field, minId, maxId] of [
    ["building_area_ping", "buildingMin", "buildingMax"],
    ["land_area_ping", "landMin", "landMax"],
    ["total_price", "priceMin", "priceMax"],
    ["unit_price_ping", "unitMin", "unitMax"],
  ]) {
    const min = el(`#${minId}`).value.trim();
    const max = el(`#${maxId}`).value.trim();
    if (min && max) addFilter(field, "between", min, max);
    else if (min) addFilter(field, ">=", min);
    else if (max) addFilter(field, "<=", max);
  }
  renderFilters();
  runQuery();
}

function setParkingFilter(value) {
  removeAutoFilters(["has_parking"]);
  if (value) state.filters.push({ field: "has_parking", operator: "=", value: value === "true" });
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
  localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(items.slice(0, 30)));
  renderPresets();
}

function renderPresets() {
  el("#savedPresets").innerHTML = readPresets().map((item, index) => `
    <span class="filter-chip"><button type="button" data-load-preset="${index}">${item.name}</button><button type="button" data-delete-preset="${index}">×</button></span>
  `).join("");
}

function renderColumnsPopover() {
  el("#columnPopover").innerHTML = columns.map(([key, label]) => `
    <button class="${state.visibleColumns.includes(key) ? "active" : ""}" type="button" data-toggle-column="${key}">${label}</button>
  `).join("");
}

function hideColumn(field) {
  if (state.visibleColumns.length <= 1) return;
  state.visibleColumns = state.visibleColumns.filter((key) => key !== field);
  saveColumnPrefs();
  renderRows();
}

async function showAnalytics(field) {
  const [key, label, type] = fieldDef(field);
  const result = await queryService.queryColumnAnalytics({ ...filterPayload(), field: key });
  setMeta(result.meta);
  el("#analyticsTitle").textContent = label;
  if (["number", "money", "unitMoney"].includes(type)) {
    const row = result.rows[0] || {};
    el("#analyticsBody").innerHTML = ["count", "min", "avg", "max"].map((name) => `
      <div class="stat-line"><span>${name}</span><strong>${name === "count" ? money.format(row[name] || 0) : decimal.format(row[name] || 0)}</strong></div>
    `).join("");
    return;
  }
  el("#analyticsBody").innerHTML = result.rows.map((row) => `
    <div class="stat-line"><span>${row.value || "(blank)"}</span><strong>${money.format(row.count || 0)}</strong></div>
  `).join("");
}

function applyDetachedParkingScreen() {
  state.filters = [
    { field: "building_area_ping", operator: ">", value: 50 },
    { field: "property_type", operator: "anyContains", value: ["透天", "別墅"] },
    { field: "has_parking", operator: "=", value: true },
  ];
  el("#buildingMin").value = "50";
  el("#stringValue").value = "透天,別墅";
  elsParking().forEach((button) => button.classList.toggle("active", button.dataset.parking === "true"));
  state.offset = 0;
  renderFilters();
  runQuery();
}

function elsParking() {
  return [...document.querySelectorAll("[data-parking]")];
}

function exportCsv() {
  const cols = visibleColumnDefs();
  const lines = [
    cols.map(([, label]) => label),
    ...state.rows.map((row) => cols.map(([key]) => displayValue(row, key))),
  ];
  const csv = lines.map((line) => line.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `terminal-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function init() {
  loadColumnPrefs();
  const initResult = await queryService.init();
  state.metadata = initResult.metadata;
  setMeta(initResult.meta);
  el("#citySelect").innerHTML = Object.keys(state.metadata.cities || {}).map((city) => `<option value="${city}">${city}</option>`).join("");
  el("#citySelect").value = state.city;
  await reloadDistricts();
  populateFields();
  renderPresets();
  renderColumnsPopover();
  await runQuery();
}

function bind() {
  el("#fieldSelect").addEventListener("change", updateOperators);
  el("#operatorSelect").addEventListener("change", updateOperators);
  el("#addFilter").addEventListener("click", () => addFilter(el("#fieldSelect").value, el("#operatorSelect").value, el("#filterValue").value, el("#filterValue2").value));
  el("#applyRangeFilters").addEventListener("click", applyRangeFilters);
  el("#addStringFilter").addEventListener("click", () => {
    const raw = el("#stringValue").value.trim();
    const value = el("#stringOperator").value === "anyContains" ? raw.split(/[,\s，、]+/).filter(Boolean) : raw;
    addFilter(el("#stringField").value, el("#stringOperator").value, value);
  });
  el("#detachedParkingScreen").addEventListener("click", applyDetachedParkingScreen);
  el("#keywordInput").addEventListener("input", () => {
    clearTimeout(bind.keywordTimer);
    bind.keywordTimer = setTimeout(() => {
      state.keyword = el("#keywordInput").value.trim();
      state.offset = 0;
      runQuery();
    }, 180);
  });
  el("#citySelect").addEventListener("change", async () => {
    state.city = el("#citySelect").value;
    state.district = "";
    state.excludedDistricts = [];
    state.offset = 0;
    await reloadDistricts();
    runQuery();
  });
  el("#districtSelect").addEventListener("change", () => {
    state.district = el("#districtSelect").value;
    state.excludedDistricts = [];
    state.offset = 0;
    runQuery();
  });
  el("#townTags").addEventListener("click", (event) => {
    const button = event.target.closest("[data-town-tag]");
    if (!button) return;
    const district = button.dataset.townTag;
    state.excludedDistricts = state.excludedDistricts.includes(district)
      ? state.excludedDistricts.filter((item) => item !== district)
      : [...state.excludedDistricts, district];
    state.offset = 0;
    runQuery();
  });
  elsParking().forEach((button) => button.addEventListener("click", () => {
    elsParking().forEach((item) => item.classList.toggle("active", item === button));
    setParkingFilter(button.dataset.parking);
  }));
  el("#activeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-filter]");
    if (!button) return;
    state.filters.splice(Number(button.dataset.removeFilter), 1);
    state.offset = 0;
    renderFilters();
    runQuery();
  });
  el("#gridHead").addEventListener("click", (event) => {
    if (event.target.closest("[data-resize]")) return;
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
  el("#gridHead").addEventListener("contextmenu", (event) => {
    const th = event.target.closest("th[data-field]");
    if (!th) return;
    event.preventDefault();
    const field = th.dataset.field;
    const menu = el("#contextMenu");
    menu.innerHTML = `<button type="button" data-hide-column="${field}">隱藏 ${fieldDef(field)[1]}</button>`;
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.classList.add("open");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#contextMenu")) el("#contextMenu").classList.remove("open");
  });
  el("#contextMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-hide-column]");
    if (!button) return;
    hideColumn(button.dataset.hideColumn);
    el("#contextMenu").classList.remove("open");
  });
  el("#gridHead").addEventListener("mousedown", (event) => {
    const handle = event.target.closest("[data-resize]");
    if (!handle) return;
    const field = handle.dataset.resize;
    const startX = event.clientX;
    const startWidth = state.widths[field] || 100;
    const move = (moveEvent) => {
      state.widths[field] = Math.max(56, startWidth + moveEvent.clientX - startX);
      renderRows();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      saveColumnPrefs();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  el("#columnButton").addEventListener("click", () => el("#columnPopover").classList.toggle("open"));
  el("#columnPopover").addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-column]");
    if (!button) return;
    const field = button.dataset.toggleColumn;
    if (state.visibleColumns.includes(field)) hideColumn(field);
    else state.visibleColumns.push(field);
    saveColumnPrefs();
    renderRows();
  });
  el("#gridWrap").addEventListener("scroll", () => {
    const wrap = el("#gridWrap");
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 120 || state.rows.length >= state.total) return;
    state.offset = state.rows.length;
    runQuery({ append: true });
  });
  el("#gridRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-map-address]");
    if (!button) return;
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(button.dataset.mapAddress)}`, "_blank", "noopener");
  });
  el("#savePreset").addEventListener("click", () => {
    const name = el("#presetName").value.trim();
    if (!name) return;
    savePresets([{ name, filters: state.filters, city: state.city, district: state.district, excludedDistricts: state.excludedDistricts }, ...readPresets().filter((item) => item.name !== name)]);
  });
  el("#savedPresets").addEventListener("click", (event) => {
    const load = event.target.closest("[data-load-preset]");
    const del = event.target.closest("[data-delete-preset]");
    const presets = readPresets();
    if (load) {
      const preset = presets[Number(load.dataset.loadPreset)];
      state.filters = preset?.filters || [];
      state.city = preset?.city || state.city;
      state.district = preset?.district || "";
      state.excludedDistricts = preset?.excludedDistricts || [];
      state.offset = 0;
      el("#citySelect").value = state.city;
      reloadDistricts().then(() => {
        renderFilters();
        runQuery();
      });
    }
    if (del) {
      presets.splice(Number(del.dataset.deletePreset), 1);
      savePresets(presets);
    }
  });
  el("#exportCsv").addEventListener("click", exportCsv);
}

bind();
init().catch((error) => {
  el("#resultMeta").textContent = error.message;
  console.error(error);
});
