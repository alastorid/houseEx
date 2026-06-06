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
  presets: [],
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

let sqliteStatusTimer;
let monacoLoadPromise;
let jsonEditor;
let jsonEditorModel;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function shortPath(path = "") {
  const text = String(path || "");
  const parts = text.split("/");
  return parts.slice(-3).join("/") || text;
}

function sqliteStatusText(status = {}) {
  const place = [status.city, status.district].filter(Boolean).join(" ");
  const shard = status.shardCount ? ` ${status.shardIndex || ""}/${status.shardCount}` : "";
  if (status.phase === "wasm-start") return "載入 SQLite WASM...";
  if (status.phase === "metadata-start") return "讀取資料版本...";
  if (status.phase === "cache-check") return `檢查快取 ${shortPath(status.path)}`;
  if (status.phase === "cache-hit") return `快取命中 ${shortPath(status.path)}`;
  if (status.phase === "download-start") return `下載資料 ${place}${shard} ${shortPath(status.path)}`;
  if (status.phase === "download-progress") return `下載資料 ${place}${shard} ${status.label || ""}`;
  if (status.phase === "cache-store") return `寫入快取 ${shortPath(status.path)}`;
  if (status.phase === "decompress-start") return `解壓縮 ${shortPath(status.path)}`;
  if (status.phase === "shard-open-start") return `開啟資料 ${place}${shard}`;
  if (status.phase === "shard-open-ready") return `${status.cacheHit ? "快取" : "下載"}完成 ${place}${shard}`;
  if (status.phase === "city-load-start") return `載入 ${place || status.city} ${status.shardCount || 0} 個資料檔`;
  if (status.phase === "city-load-ready") return `${place || status.city} 資料已就緒`;
  return "";
}

function setLoadProgress(value) {
  const fill = el("#loadStatusFill");
  const bar = el("#loadStatusBar");
  if (!fill) return;
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  fill.style.width = `${Math.round(progress * 100)}%`;
  if (bar) bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function sqliteStatusProgress(status = {}) {
  const phase = status.phase || "";
  const count = Math.max(1, Number(status.shardCount) || 1);
  const index = Math.max(1, Number(status.shardIndex) || 1);
  const loaded = Number(status.loaded) || 0;
  const total = Number(status.total) || 0;
  const downloadRatio = total ? Math.max(0, Math.min(1, loaded / total)) : 0.35;
  const shardBase = 0.18 + ((index - 1) / count) * 0.66;
  const shardSpan = 0.66 / count;
  if (phase === "wasm-start") return 0.04;
  if (phase === "wasm-ready") return 0.1;
  if (phase === "metadata-start") return 0.12;
  if (phase === "metadata-ready") return 0.16;
  if (phase === "city-load-start") return 0.18;
  if (phase === "cache-check") return status.shardCount ? shardBase + shardSpan * 0.08 : 0.2;
  if (phase === "cache-hit") return status.shardCount ? shardBase + shardSpan * 0.5 : 0.45;
  if (phase === "download-start") return status.shardCount ? shardBase + shardSpan * 0.12 : 0.25;
  if (phase === "download-progress") return status.shardCount ? shardBase + shardSpan * (0.12 + downloadRatio * 0.56) : 0.25 + downloadRatio * 0.45;
  if (phase === "cache-store") return status.shardCount ? shardBase + shardSpan * 0.76 : 0.72;
  if (phase === "decompress-start") return status.shardCount ? shardBase + shardSpan * 0.86 : 0.82;
  if (phase === "db-ready") return status.shardCount ? shardBase + shardSpan * 0.92 : 0.88;
  if (phase === "shard-open-start") return shardBase;
  if (phase === "shard-open-ready") return Math.min(0.9, 0.18 + (index / count) * 0.66);
  if (phase === "city-load-ready") return 0.92;
  if (phase.endsWith("ready")) return 0.96;
  return null;
}

function showSqliteStatus(status = {}) {
  const text = sqliteStatusText(status);
  if (!text) return;
  const bottomText = el("#loadStatusText");
  if (bottomText) bottomText.textContent = text;
  const progress = sqliteStatusProgress(status);
  if (progress != null) setLoadProgress(progress);
  document.body.classList.add("loading-sqlite");
  clearTimeout(sqliteStatusTimer);
  if (status.phase?.endsWith("ready")) {
    sqliteStatusTimer = setTimeout(() => {
      document.body.classList.remove("loading-sqlite");
    }, 1200);
  }
}

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

function loadFilterPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_PRESETS_KEY) || "[]");
    state.presets = Array.isArray(saved) ? saved.filter((preset) => preset && preset.id && preset.name && preset.payload) : [];
  } catch {
    state.presets = [];
  }
}

function saveFilterPresets() {
  localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(state.presets));
}

function currentPresetPayload() {
  return {
    city: state.city,
    district: state.district,
    keyword: state.keyword,
    filters: JSON.parse(JSON.stringify(state.filters)),
    sortBy: state.sortBy,
    sortDir: state.sortDir,
  };
}

function presetName() {
  const used = new Set(state.presets.map((preset) => preset.name));
  let index = state.presets.length + 1;
  while (used.has(`Preset ${index}`)) index += 1;
  return `Preset ${index}`;
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
  setTheme(saved.theme || "dark");
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
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    visibleColumns: state.visibleColumns,
    widths: state.widths,
  };
  const encoded = encodeURIComponent(JSON.stringify(snapshot));
  const next = `${window.location.pathname}${window.location.search}#state=${encoded}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(null, "", next);
  }
}

function setTheme(scheme, { sync = false } = {}) {
  const resolved = scheme === "light" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", resolved === "dark");
  const button = el("#themeToggle");
  if (button) {
    button.textContent = resolved === "dark" ? "☀" : "☾";
    button.title = resolved === "dark" ? "切換淺色模式" : "切換深色模式";
  }
  if (window.monaco?.editor) {
    window.monaco.editor.setTheme(resolved === "dark" ? "houseex-dark" : "houseex-light");
  }
  if (sync) writeHashState();
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

function joinedAddress(row) {
  const address = String(row.full_address || "").trim();
  const city = String(row.city || "").trim();
  const district = String(row.district || "").trim();
  if (!address) return [city, district].filter(Boolean).join("");
  if (city && address.startsWith(city)) return address;
  if (district && address.startsWith(district)) return `${city}${address}`;
  return `${city}${district}${address}`;
}

function cellHtml(row, field, index) {
  const value = displayValue(row, field);
  const title = String(value).replace(/"/g, "&quot;");
  if (field === "full_address" && row.full_address) {
    return `<td ${widthStyle(field)} title="${title}">${value}</td>`;
  }
  if (field === "raw_json") {
    return `<td ${widthStyle(field)}>${row.raw_json ? `<button class="raw-cell" type="button" data-raw-index="${index}">JSON</button>` : ""}</td>`;
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
  document.body.classList.add("loading-sqlite");
  setLoadProgress(0.03);
  try {
    el("#resultMeta").textContent = append ? "載入更多資料..." : "載入資料...";
    await queryService.loadCity({ city: state.city, district: state.district });
    setLoadProgress(0.72);
    const result = await queryService.queryTransactions(filterPayload());
    setLoadProgress(0.88);
    setMeta(result.meta);
    state.total = result.total || 0;
    state.rows = append ? [...state.rows, ...(result.rows || [])] : result.rows || [];
    renderRows();
    setLoadProgress(1);
    if (!append) writeHashState();
  } finally {
    state.loading = false;
    document.body.classList.remove("loading-sqlite");
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
  el("#gridRows").innerHTML = state.rows.map((row, index) => `
    <tr>${cols.map(([key]) => cellHtml(row, key, index)).join("")}</tr>
  `).join("");
  renderColumnsPopover();
}

function highlightedJson(value) {
  return escapeHtml(value).replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token) => {
      let type = "number";
      if (token.startsWith('"')) type = token.endsWith(":") ? "key" : "string";
      else if (token === "true" || token === "false") type = "boolean";
      else if (token === "null") type = "null";
      return `<span class="json-${type}">${token}</span>`;
    },
  );
}

function loadMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (monacoLoadPromise) return monacoLoadPromise;
  monacoLoadPromise = new Promise((resolve, reject) => {
    window.MonacoEnvironment = {
      getWorkerUrl: () => "vendor/monaco/vs/base/worker/workerMain.js",
    };
    const script = document.createElement("script");
    script.src = "vendor/monaco/vs/loader.js?v=20260601-monaco-json";
    script.onload = () => {
      window.require.config({ paths: { vs: "vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => {
        window.monaco.editor.defineTheme("houseex-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "string.key.json", foreground: "70c3b3" },
            { token: "string.value.json", foreground: "d9b46a" },
            { token: "number", foreground: "72acd0" },
            { token: "keyword", foreground: "c58ad3" },
          ],
          colors: {
            "editor.background": "#151b20",
            "editor.foreground": "#e7edf2",
            "editorLineNumber.foreground": "#5f6e7a",
            "editorLineNumber.activeForeground": "#d9b46a",
            "editor.selectionBackground": "#2e5d61",
            "editorWidget.background": "#1c2329",
          },
        });
        window.monaco.editor.defineTheme("houseex-light", {
          base: "vs",
          inherit: true,
          rules: [
            { token: "string.key.json", foreground: "176f72" },
            { token: "string.value.json", foreground: "9b6424" },
            { token: "number", foreground: "236b8e" },
            { token: "keyword", foreground: "7b4a92" },
          ],
          colors: {
            "editor.background": "#ffffff",
            "editor.foreground": "#17212b",
            "editorLineNumber.foreground": "#94a2ad",
            "editorLineNumber.activeForeground": "#176f72",
            "editor.selectionBackground": "#c8e3e0",
            "editorWidget.background": "#f7fafb",
          },
        });
        window.monaco.editor.setTheme(document.documentElement.classList.contains("dark") ? "houseex-dark" : "houseex-light");
        resolve(window.monaco);
      });
    };
    script.onerror = () => reject(new Error("Monaco local runtime failed to load"));
    document.head.appendChild(script);
  });
  return monacoLoadPromise;
}

function showJsonFallback(pretty) {
  const fallback = el("#jsonCode");
  fallback.innerHTML = highlightedJson(pretty);
  fallback.classList.add("open");
  el("#jsonEditor").style.display = "none";
}

async function openJsonPayload({ title = "JSON", meta = "", payload, actionsHtml = "" }) {
  const pretty = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  el("#jsonTitle").textContent = title;
  el("#jsonMeta").textContent = meta;
  const actions = el("#jsonActions");
  if (actions) actions.innerHTML = actionsHtml;
  el("#jsonDrawer").classList.add("open");
  el("#jsonDrawer").setAttribute("aria-hidden", "false");
  el("#jsonCode").classList.remove("open");
  el("#jsonEditor").style.display = "block";
  try {
    const monaco = await loadMonaco();
    if (!jsonEditorModel) {
      jsonEditorModel = monaco.editor.createModel(pretty, "json");
    } else {
      jsonEditorModel.setValue(pretty);
    }
    if (!jsonEditor) {
      jsonEditor = monaco.editor.create(el("#jsonEditor"), {
        model: jsonEditorModel,
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        fontSize: 12,
        lineNumbersMinChars: 4,
        renderLineHighlight: "line",
        theme: document.documentElement.classList.contains("dark") ? "houseex-dark" : "houseex-light",
      });
    } else {
      jsonEditor.setModel(jsonEditorModel);
      jsonEditor.layout();
    }
  } catch (error) {
    console.warn(error);
    showJsonFallback(pretty);
  }
}

async function openJsonViewer(row) {
  if (!row?.raw_json) return;
  let parsed;
  try {
    parsed = JSON.parse(row.raw_json);
  } catch {
    parsed = row.raw_json;
  }
  await openJsonPayload({
    title: row.full_address || row.community_name || row.id || "Raw JSON",
    meta: [row.city, row.district, row.transaction_date, row.source_batch].filter(Boolean).join(" · "),
    payload: parsed,
  });
}

function closeJsonViewer() {
  el("#jsonDrawer").classList.remove("open");
  el("#jsonDrawer").setAttribute("aria-hidden", "true");
}

function filterInputValue(filter) {
  if (filter.field === "total_price" || filter.field === "parking_price" || filter.field === "unit_price_ping") {
    return filter.value === "" || filter.value == null ? "" : Number(filter.value) / 10000;
  }
  if (Array.isArray(filter.value)) return filter.value.join(" ");
  return filter.value ?? "";
}

function filterInputValue2(filter) {
  if (filter.field === "total_price" || filter.field === "parking_price" || filter.field === "unit_price_ping") {
    return filter.value2 === "" || filter.value2 == null ? "" : Number(filter.value2) / 10000;
  }
  return filter.value2 ?? "";
}

function filterOperatorOptions(filter) {
  const type = fieldDef(filter.field)[2];
  return (operators[type] || operators.string)
    .map((op) => `<option value="${op}" ${filter.operator === op ? "selected" : ""}>${op}</option>`)
    .join("");
}

function renderFilters() {
  el("#activeFilters").innerHTML = state.filters.map((filter, index) => (
    `<div class="filter-line" data-index="${index}">
      <span>${fieldDef(filter.field)[1]}</span>
      <select data-edit-op="${index}">${filterOperatorOptions(filter)}</select>
      <input type="text" value="${escapeHtml(filterInputValue(filter))}" data-edit-val="${index}" />
      <input class="${filter.operator === "between" ? "" : "is-hidden"}" type="text" value="${escapeHtml(filterInputValue2(filter))}" data-edit-val2="${index}" />
      <button type="button" data-remove-filter="${index}">×</button>
    </div>`
  )).join("");
}

function updateFilterFromControl(target) {
  const valueIndex = target.dataset.editVal;
  const value2Index = target.dataset.editVal2;
  const opIndex = target.dataset.editOp;
  const index = valueIndex ?? value2Index ?? opIndex;
  if (index === undefined) return;
  const filter = state.filters[Number(index)];
  if (!filter) return;
  if (opIndex !== undefined) filter.operator = target.value;
  if (valueIndex !== undefined) filter.value = convertValue(filter.field, target.value);
  if (value2Index !== undefined) filter.value2 = convertValue(filter.field, target.value);
  state.offset = 0;
  if (opIndex !== undefined) renderFilters();
  writeHashState();
  runQuery();
}

el("#activeFilters").addEventListener("input", (event) => {
  if (event.target.matches("[data-edit-val], [data-edit-val2]")) updateFilterFromControl(event.target);
});

el("#activeFilters").addEventListener("change", (event) => {
  if (event.target.matches("[data-edit-op]")) updateFilterFromControl(event.target);
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

function renderPresetButtons() {
  const target = el("#savedPresets");
  if (!target) return;
  target.innerHTML = state.presets.map((preset) => `
    <button type="button" data-preset-id="${escapeHtml(preset.id)}" title="套用；雙擊改名">${escapeHtml(preset.name)}</button>
  `).join("");
}

function addCurrentPreset() {
  const preset = {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: presetName(),
    payload: currentPresetPayload(),
  };
  state.presets.unshift(preset);
  saveFilterPresets();
  renderPresetButtons();
  startPresetRename(preset.id);
}

function deleteSavedPreset(id) {
  const next = state.presets.filter((preset) => preset.id !== id);
  if (next.length === state.presets.length) return;
  state.presets = next;
  saveFilterPresets();
  renderPresetButtons();
}

async function applySavedPreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  const payload = preset.payload || {};
  if (payload.city && state.metadata?.cities?.[payload.city]) state.city = payload.city;
  state.district = payload.district || "";
  state.keyword = payload.keyword || "";
  state.filters = Array.isArray(payload.filters) ? JSON.parse(JSON.stringify(payload.filters)) : [];
  state.sortBy = payload.sortBy && fieldDef(payload.sortBy) ? payload.sortBy : state.sortBy;
  state.sortDir = payload.sortDir === "ASC" ? "ASC" : "DESC";
  state.offset = 0;
  el("#citySelect").value = state.city;
  await reloadDistricts();
  el("#districtSelect").value = state.district;
  el("#keywordInput").value = state.keyword;
  renderFilters();
  writeHashState();
  runQuery();
}

function startPresetRename(id) {
  const preset = state.presets.find((item) => item.id === id);
  const button = el(`[data-preset-id="${CSS.escape(id)}"]`);
  if (!preset || !button) return;
  const input = document.createElement("input");
  input.className = "preset-name-input";
  input.name = "preset-label";
  input.type = "text";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-1p-ignore", "true");
  input.value = preset.name;
  input.setAttribute("aria-label", "preset name");
  button.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const nextName = input.value.trim();
    if (nextName) {
      preset.name = nextName;
      saveFilterPresets();
    }
    renderPresetButtons();
  };
  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      input.value = preset.name;
      input.blur();
    }
  });
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

async function queryBuildLicenseForAddress(address) {
  if (!window.cpamiOpenData) return;
  await openJsonPayload({
    title: address || "Build License",
    meta: "BUILDLIC · loading",
    payload: { address, loading: true },
  });
  try {
    const matches = await window.cpamiOpenData.queryLocalByAddress(address);
    await openJsonPayload({
      title: address || "Build License",
      meta: `BUILDLIC · ${matches.length} possible hits`,
      payload: {
        address,
        matches: matches.map(({ score, matchedAddress, record }) => ({ score, matchedAddress, ...record })),
      },
    });
  } catch (error) {
    await openJsonPayload({
      title: address || "Build License",
      meta: "BUILDLIC · unavailable",
      payload: { address, error: error.message },
    });
  }
}

function navigateBupicWindow(popup, detailUrl) {
  if (!popup) return;
  try {
    popup.opener = null;
    popup.location.href = window.cpamiOpenData.BUPIC_PRELOGIN_URL;
    window.setTimeout(() => {
      try {
        popup.location.href = detailUrl;
      } catch {
        window.open(detailUrl, "_blank", "noopener");
      }
    }, 1800);
  } catch {
    window.open(detailUrl, "_blank", "noopener");
  }
}

async function openBupicForAddress(address) {
  if (!window.cpamiOpenData) return;
  await openJsonPayload({
    title: address || "BUPIC",
    meta: "BUPIC qtype 3 · loading",
    payload: { qtype: 3, address, loading: true },
  });
  try {
    const matches = await window.cpamiOpenData.queryLocalByAddress(address);
    const rows = matches.map(window.cpamiOpenData.toBupicCandidate).filter((row) => row.index_key);
    const links = rows.map((row, index) => (
      `<a href="${escapeHtml(row.detail_url)}" target="_blank" rel="noreferrer">Open ${escapeHtml(row.license_desc || `result ${index + 1}`)}</a>`
    )).join("");
    await openJsonPayload({
      title: address || "BUPIC",
      meta: `BUPIC qtype 3 · ${rows.length} possible hits`,
      payload: { qtype: 3, address, rows },
      actionsHtml: links,
    });
  } catch (error) {
    await openJsonPayload({
      title: address || "BUPIC",
      meta: "BUPIC · unavailable",
      payload: { qtype: 3, address, error: error.message },
    });
  }
}

async function init() {
  loadColumnPrefs();
  loadFilterPresets();
  const initResult = await queryService.init();
  state.metadata = initResult.metadata;
  setMeta(initResult.meta);
  el("#citySelect").innerHTML = Object.keys(state.metadata.cities || {}).map((city) => `<option value="${city}">${city}</option>`).join("");
  applyHashState();
  el("#citySelect").value = state.city;
  await reloadDistricts();
  el("#keywordInput").value = state.keyword;
  el("#districtSelect").value = state.district;
  setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  renderFilters();
  renderPresetButtons();
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
    const rawButton = event.target.closest("[data-raw-index]");
    if (rawButton) {
      openJsonViewer(state.rows[Number(rawButton.dataset.rawIndex)]);
    }
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
    if (field === "full_address") {
      const fullMapAddress = joinedAddress(row);
      options.push(`<button type="button" data-google-keyword="${encodeURIComponent(fullMapAddress)}">Google: ${escapeHtml(fullMapAddress)}</button>`);
      options.push(`<button type="button" data-google-map="${encodeURIComponent(fullMapAddress)}">Open Google Maps</button>`);
      options.push(`<button type="button" data-buildlic-address="${escapeHtml(fullMapAddress)}">Query build license data</button>`);
      options.push(`<button type="button" data-bupic-address="${escapeHtml(fullMapAddress)}">View BUPIC data</button>`);
    }
    menu.innerHTML = options.join("");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.classList.add("open");
  });
  el("#contextMenu").addEventListener("click", (event) => {
    const filterBtn = event.target.closest("[data-filter]");
    const googleBtn = event.target.closest("[data-google-keyword]");
    const googleMapBtn = event.target.closest("[data-google-map]");
    const buildlicBtn = event.target.closest("[data-buildlic-address]");
    const bupicBtn = event.target.closest("[data-bupic-address]");
    if (filterBtn) {
      addFilter(filterBtn.dataset.filter, filterBtn.dataset.op, filterBtn.dataset.val);
    } else if (googleMapBtn) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${googleMapBtn.dataset.googleMap}`, "_blank", "noopener");
    } else if (bupicBtn) {
      openBupicForAddress(bupicBtn.dataset.bupicAddress || "");
    } else if (buildlicBtn) {
      queryBuildLicenseForAddress(buildlicBtn.dataset.buildlicAddress || "");
    } else if (googleBtn) {
      window.open(`https://www.google.com/search?q=${googleBtn.dataset.googleKeyword}`, "_blank", "noopener");
    }
    el("#contextMenu").classList.remove("open");
  });
  el("#exportCsv").addEventListener("click", exportCsv);
  el("#largeDetachedPreset").addEventListener("click", applyLargeDetachedPreset);
  el("#addPreset").addEventListener("click", addCurrentPreset);
  el("#savedPresets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset-id]");
    if (!button) return;
    applySavedPreset(button.dataset.presetId);
  });
  el("#savedPresets").addEventListener("dblclick", (event) => {
    const button = event.target.closest("[data-preset-id]");
    if (!button) return;
    event.preventDefault();
    startPresetRename(button.dataset.presetId);
  });
  el("#savedPresets").addEventListener("contextmenu", (event) => {
    const button = event.target.closest("[data-preset-id]");
    if (!button) return;
    event.preventDefault();
    deleteSavedPreset(button.dataset.presetId);
  });
  el("#themeToggle").addEventListener("click", () => {
    setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark", { sync: true });
  });
  el("#closeJson").addEventListener("click", closeJsonViewer);
  el("#jsonActions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-buildlic]");
    if (!button) return;
    window.open(button.dataset.openBuildlic, "_blank", "noopener");
  });
  el("#jsonDrawer").addEventListener("click", (event) => {
    if (event.target.id === "jsonDrawer") closeJsonViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el("#jsonDrawer").classList.contains("open")) closeJsonViewer();
  });
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
window.addEventListener("sqlite-status", (event) => showSqliteStatus(event.detail));
init().catch((error) => {
  el("#resultMeta").textContent = error.message;
  console.error(error);
});
