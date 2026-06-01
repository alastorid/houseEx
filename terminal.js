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
  districtOptions: [],
  keyword: "",
  filters: [],
  rows: [],
  total: 0,
  offset: 0,
  loading: false,
  analyticsLoading: false,
  sortBy: "transaction_date",
  sortDir: "DESC",
  visibleColumns: columns.map(([key]) => key).filter(key => 
    !["city", "road", "has_parking", "parking_price", "building_age", "source_batch", "repeat_sale"].includes(key)
  ),
  widths: Object.fromEntries(columns.map(([key, , , width]) => [key, width])),
  restoringHash: false,
};

const el = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const debounce = (fn, wait = 220) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

function loadColumnPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_KEY) || "{}");
    if (Array.isArray(saved.visibleColumns)) state.visibleColumns = saved.visibleColumns;
    if (saved.widths) state.widths = { ...state.widths, ...saved.widths };
  } catch {}
}

function saveColumnPrefs() {
  localStorage.setItem(COLUMN_KEY, JSON.stringify({ visibleColumns: state.visibleColumns, widths: state.widths }));
  writeHashState();
}

function readHashState() {
  const raw = new URLSearchParams(window.location.hash.slice(1)).get("state");
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function applyHashState() {
  const saved = readHashState();
  if (!saved || typeof saved !== "object") return;
  state.restoringHash = true;
  if (saved.city && state.metadata?.cities?.[saved.city]) state.city = saved.city;
  state.district = saved.district || "";
  state.keyword = saved.keyword || "";
  if (Array.isArray(saved.filters)) state.filters = saved.filters;
  if (saved.sortBy && fieldDef(saved.sortBy)) state.sortBy = saved.sortBy;
  state.sortDir = saved.sortDir === "ASC" ? "ASC" : "DESC";
  if (Array.isArray(saved.visibleColumns)) {
    const valid = saved.visibleColumns.filter((key) => columns.some(([columnKey]) => columnKey === key));
    if (valid.length) state.visibleColumns = valid;
  }
  if (saved.widths && typeof saved.widths === "object") {
    const validWidths = Object.fromEntries(Object.entries(saved.widths).filter(([key, value]) => columns.some(([columnKey]) => columnKey === key) && Number.isFinite(Number(value))));
    state.widths = { ...state.widths, ...validWidths };
  }
  state.offset = 0;
  state.restoringHash = false;
}

function writeHashState() {
  if (state.restoringHash) return;
  const snapshot = {
    city: state.city,
    district: state.district,
    keyword: state.keyword,
    filters: state.filters,
    sortBy: state.sortBy,
    sortDir: state.sortDir,
    visibleColumns: state.visibleColumns,
    widths: state.widths,
  };
  const encoded = encodeURIComponent(JSON.stringify(snapshot));
  const next = `${window.location.pathname}${window.location.search}#state=${encoded}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(null, "", next);
  }
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
    const fullMapAddress = `${row.city || ""}${row.district || ""}${row.full_address}`;
    return `<td ${widthStyle(field)}><button class="address-cell" type="button" data-map-address="${String(fullMapAddress).replace(/"/g, "&quot;")}">${value}</button></td>`;
  }
  return `<td ${widthStyle(field)} title="${title}">${value}</td>`;
}

function filterPayload() {
  const filters = [...state.filters];
  return {
    city: state.city,
    district: state.district,
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
  state.districtOptions = names;
  el("#districtSelect").innerHTML = `<option value="">全部</option>${names.map((name) => `<option value="${name}">${name}</option>`).join("")}`;
  if (state.district && !names.includes(state.district)) state.district = "";
  el("#districtSelect").value = state.district;
}

async function runQuery({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    await queryService.loadCity({ city: state.city, district: state.district });
    const result = await queryService.queryTransactions(filterPayload());
    setMeta(result.meta);
    state.total = result.total || 0;
    state.rows = append ? [...state.rows, ...(result.rows || [])] : result.rows || [];
    renderRows();
    if (!append) writeHashState();
  } finally {
    state.loading = false;
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

function filterInputValue(filter) {
  if (filter.field === "total_price" || filter.field === "parking_price" || filter.field === "unit_price_ping") {
    return filter.value === "" || filter.value == null ? "" : Number(filter.value) / 10000;
  }
  return filter.value ?? "";
}

function renderFilters() {
  el("#activeFilters").innerHTML = state.filters.map((filter, index) => (
    `<div class="filter-line" data-index="${index}">
      <small>${humanFilter(filter)}</small>
      <input type="text" value="${filterInputValue(filter)}" data-edit-val="${index}" />
      <button type="button" data-remove-filter="${index}">×</button>
    </div>`
  )).join("");
}

// Add event listener for inline filter editing
el("#activeFilters").addEventListener("input", (e) => {
  const target = e.target;
  const index = target.dataset.editVal;
  if (index === undefined) return;
  state.filters[index].value = convertValue(state.filters[index].field, target.value);
  state.offset = 0;
  writeHashState();
  runQuery();
});

function convertValue(field, value) {
  if (value === "" || value == null) return "";
  if (field === "total_price" || field === "parking_price") return Number(value) * 10000;
  if (field === "unit_price_ping") return Number(value) * 10000;
  return value;
}

function contextFilterValue(field, value) {
  if (field === "total_price" || field === "parking_price" || field === "unit_price_ping") return Number(value || 0) / 10000;
  return value;
}

function contextFilterLabel(field, value) {
  if (field === "total_price" || field === "parking_price") return `${money.format(Number(value || 0) / 10000)}萬`;
  if (field === "unit_price_ping") return `${decimal.format(Number(value || 0) / 10000)}萬/坪`;
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
  writeHashState();
  runQuery();
}

function removeAutoFilters(fields) {
  state.filters = state.filters.filter((filter) => !fields.includes(filter.field));
}

function applyLargeDetachedPreset() {
  removeAutoFilters(["building_area_ping", "land_area_ping"]);
  state.filters.push(
    { field: "building_area_ping", operator: ">", value: 99, value2: "" },
    { field: "land_area_ping", operator: ">", value: 99, value2: "" },
  );
  state.offset = 0;
  renderFilters();
  writeHashState();
  runQuery();
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
  const def = fieldDef(field);
  if (!def) return;
  const [key, label, type] = def;
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
  applyHashState();
  el("#citySelect").value = state.city;
  await reloadDistricts();
  el("#keywordInput").value = state.keyword;
  el("#districtSelect").value = state.district;
  renderFilters();
  renderColumnsPopover();
  await runQuery();
}

function bind() {
  el("#keywordInput").addEventListener("input", () => {
    clearTimeout(bind.keywordTimer);
    bind.keywordTimer = setTimeout(() => {
      state.keyword = el("#keywordInput").value.trim();
      state.offset = 0;
      writeHashState();
      runQuery();
    }, 180);
  });
  el("#citySelect").addEventListener("change", async () => {
    state.city = el("#citySelect").value;
    state.district = "";
    state.offset = 0;
    await reloadDistricts();
    writeHashState();
    runQuery();
  });
  el("#districtSelect").addEventListener("change", () => {
    state.district = el("#districtSelect").value;
    state.offset = 0;
    writeHashState();
    runQuery();
  });
  el("#activeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-filter]");
    if (!button) return;
    state.filters.splice(Number(button.dataset.removeFilter), 1);
    state.offset = 0;
    renderFilters();
    writeHashState();
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
    writeHashState();
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
  el("#columnButton").addEventListener("click", (event) => {
    event.stopPropagation();
    el("#columnPopover").classList.toggle("open");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#columnPopover") && !event.target.closest("#columnButton")) {
      el("#columnPopover").classList.remove("open");
    }
  });
  el("#columnPopover").addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-column]");
    if (!button) return;
    const field = button.dataset.toggleColumn;
    if (state.visibleColumns.includes(field)) hideColumn(field);
    else state.visibleColumns.push(field);
    saveColumnPrefs();
    writeHashState();
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
  el("#gridRows").addEventListener("contextmenu", (event) => {
    const td = event.target.closest("td");
    const tr = event.target.closest("tr");
    if (!td || !tr) return;
    event.preventDefault();
    const cellIndex = td.cellIndex;
    const field = visibleColumnDefs()[cellIndex][0];
    const row = state.rows[tr.rowIndex - 1];
    const value = row[field];
    const filterValue = contextFilterValue(field, value);
    const filterLabel = contextFilterLabel(field, value);
    const menu = el("#contextMenu");
    let options = [`<button type="button" data-filter="${field}" data-op="=" data-val="${filterValue}">Include: ${filterLabel}</button>`, `<button type="button" data-filter="${field}" data-op="!=" data-val="${filterValue}">Exclude: ${filterLabel}</button>`];
    if (fieldDef(field)[2] === "number" || fieldDef(field)[2] === "money" || fieldDef(field)[2] === "unitMoney") {
      options.push(`<button type="button" data-filter="${field}" data-op=">=" data-val="${filterValue}">>= ${filterLabel}</button>`);
      options.push(`<button type="button" data-filter="${field}" data-op="<=" data-val="${filterValue}"><= ${filterLabel}</button>`);
    }
    const googleKeyword = field === "full_address"
      ? `${row.city || ""}${row.district || ""}${row.full_address}`
      : filterLabel;
    if (googleKeyword) options.push(`<button type="button" data-google-keyword="${encodeURIComponent(googleKeyword)}">Google: ${filterLabel}</button>`);
    if (field === "full_address") {
      const fullMapAddress = `${row.city || ""}${row.district || ""}${row.full_address}`;
      options.push(`<button type="button" data-map-streetview="${encodeURIComponent(fullMapAddress)}">Street View</button>`);
    }
    menu.innerHTML = options.join("");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.classList.add("open");
  });
  el("#contextMenu").addEventListener("click", (event) => {
    const filterBtn = event.target.closest("[data-filter]");
    const streetViewBtn = event.target.closest("[data-map-streetview]");
    const googleBtn = event.target.closest("[data-google-keyword]");
    if (filterBtn) {
      addFilter(filterBtn.dataset.filter, filterBtn.dataset.op, filterBtn.dataset.val);
    } else if (googleBtn) {
      window.open(`https://www.google.com/search?q=${googleBtn.dataset.googleKeyword}`, "_blank", "noopener");
    } else if (streetViewBtn) {
      window.open(`https://www.google.com/maps?layer=c&cbll=&cbp=1,0,,0,0&q=${streetViewBtn.dataset.mapStreetview}`, "_blank", "noopener");
    }
    el("#contextMenu").classList.remove("open");
  });
  el("#exportCsv").addEventListener("click", exportCsv);
  el("#largeDetachedPreset").addEventListener("click", applyLargeDetachedPreset);
  window.addEventListener("hashchange", async () => {
    applyHashState();
    el("#citySelect").value = state.city;
    await reloadDistricts();
    el("#keywordInput").value = state.keyword;
    el("#districtSelect").value = state.district;
    renderFilters();
    renderColumnsPopover();
    await runQuery();
  });
}

bind();
init().catch((error) => {
  el("#resultMeta").textContent = error.message;
  console.error(error);
});
