const BASE_PARAMS = { d: "OPENDATA", c: "BUILDLIC", Start: "1" };
const DEFAULT_PARAMS = { ...BASE_PARAMS, "門牌.行政區": "彰化縣" };
const HIDDEN_QUERY_KEYS = new Set(["d", "Start"]);
const THEME_KEY = "houseEx.buildlicTheme";
const COLUMN_ORDER = [
  "資料區塊",
  "完整地址",
  "執照類別",
  "核發執照字號",
  "起造人代表人",
  "發照日期",
  "建造類別",
  "構造別",
  "地上層數",
  "地下層數",
  "總樓地板面積",
  "基地面積",
  "門牌.行政區",
  "門牌.路街段巷弄",
  "門牌.號",
  "地號.地段",
  "地號.地號母號",
  "地號.地號子號",
  "樓層概要.樓層別",
  "樓層概要.樓層面積",
  "樓層概要.樓層用途",
];

const state = {
  params: {},
  raw: null,
  rows: [],
  sortBy: "資料區塊",
  sortDir: "ASC",
  widths: {},
};

const el = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });

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

function setTheme(scheme, { sync = false } = {}) {
  const resolved = scheme === "dark" ? "dark" : "light";
  document.documentElement.classList.toggle("dark", resolved === "dark");
  const button = el("#themeToggle");
  if (button) button.textContent = resolved === "dark" ? "☀" : "☾";
  if (window.monaco?.editor) window.monaco.editor.setTheme(resolved === "dark" ? "houseex-dark" : "houseex-light");
  if (sync) {
    localStorage.setItem(THEME_KEY, resolved);
    writeLocationState();
  }
}

function loadMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (monacoLoadPromise) return monacoLoadPromise;
  monacoLoadPromise = new Promise((resolve, reject) => {
    window.MonacoEnvironment = { getWorkerUrl: () => "vendor/monaco/vs/base/worker/workerMain.js" };
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
          colors: { "editor.background": "#151b20", "editor.foreground": "#e7edf2" },
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
          colors: { "editor.background": "#ffffff", "editor.foreground": "#17212b" },
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

function highlightedJson(value) {
  return escapeHtml(value).replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token) => `<span class="json-${token.startsWith('"') ? (token.endsWith(":") ? "key" : "string") : token === "true" || token === "false" ? "boolean" : token === "null" ? "null" : "number"}">${token}</span>`,
  );
}

async function openJson(title, meta, payload) {
  const pretty = JSON.stringify(payload, null, 2);
  el("#jsonTitle").textContent = title;
  el("#jsonMeta").textContent = meta;
  el("#jsonActions").innerHTML = "";
  el("#jsonDrawer").classList.add("open");
  el("#jsonDrawer").setAttribute("aria-hidden", "false");
  el("#jsonCode").classList.remove("open");
  el("#jsonEditor").style.display = "block";
  try {
    const monaco = await loadMonaco();
    if (!jsonEditorModel) jsonEditorModel = monaco.editor.createModel(pretty, "json");
    else jsonEditorModel.setValue(pretty);
    if (!jsonEditor) {
      jsonEditor = monaco.editor.create(el("#jsonEditor"), {
        model: jsonEditorModel,
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        fontSize: 12,
        theme: document.documentElement.classList.contains("dark") ? "houseex-dark" : "houseex-light",
      });
    } else {
      jsonEditor.setModel(jsonEditorModel);
      jsonEditor.layout();
    }
  } catch {
    el("#jsonEditor").style.display = "none";
    el("#jsonCode").innerHTML = highlightedJson(pretty);
    el("#jsonCode").classList.add("open");
  }
}

function closeJson() {
  el("#jsonDrawer").classList.remove("open");
  el("#jsonDrawer").setAttribute("aria-hidden", "true");
}

function paramsFromHash() {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(raw);
}

function paramsFromSearch() {
  return new URLSearchParams(window.location.search);
}

function themeFromLocation() {
  const hashTheme = paramsFromHash().get("theme");
  const searchTheme = paramsFromSearch().get("theme");
  return hashTheme || searchTheme || localStorage.getItem(THEME_KEY) || "light";
}

function parseParamsFromLocation() {
  const hashParams = paramsFromHash();
  const params = [...hashParams.keys()].length ? hashParams : paramsFromSearch();
  const out = {};
  params.forEach((value, key) => {
    if (key !== "theme") out[key] = value;
  });
  return Object.keys(out).length ? out : { ...DEFAULT_PARAMS };
}

function queryString(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) search.set(key, value);
  });
  return search.toString();
}

function visibleQueryParams(params) {
  return Object.fromEntries(Object.entries(params || {}).filter(([key]) => !HIDDEN_QUERY_KEYS.has(key)));
}

function writeLocationState() {
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const hash = queryString({ ...visibleQueryParams(state.params), theme });
  const next = `${window.location.pathname}${hash ? `#${hash}` : ""}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(null, "", next);
  }
}

function syncQueryInput() {
  const visibleParams = visibleQueryParams(state.params);
  el("#queryInput").value = queryString(visibleParams);
  el("#queryPairs").innerHTML = Object.entries(visibleParams).map(([key, value]) => `
    <div class="query-pair">
      <button type="button" data-remove-param="${escapeHtml(key)}">×</button>
      <span>${escapeHtml(key)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function applyQueryString(text) {
  let raw = String(text || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = url.hash ? url.hash.slice(1) : url.search.slice(1);
    } catch {}
  } else if (raw.startsWith("?") || raw.startsWith("#")) {
    raw = raw.slice(1);
  }
  const params = new URLSearchParams(raw);
  const next = {};
  params.forEach((value, key) => {
    if (key !== "theme") next[key] = value;
  });
  state.params = { ...BASE_PARAMS, ...next };
  writeLocationState();
  syncQueryInput();
}

function compactValue(value) {
  return window.cpamiOpenData.compactValue(value);
}

function reconstructAddress(flat) {
  const district = flat["門牌.行政區"] || "";
  const village = flat["門牌.村里鄰"] || "";
  const road = flat["門牌.路街段巷弄"] || "";
  const number = flat["門牌.號"] || "";
  const floor = flat["門牌.樓"] || "";
  return [district, village, road, number, floor].filter(Boolean).join("");
}

function primaryAddress(record) {
  const door = Array.isArray(record?.["門牌"]) ? record["門牌"].find(Boolean) : null;
  if (!door) return "";
  return reconstructAddress({
    "門牌.行政區": door["行政區"],
    "門牌.村里鄰": door["村里鄰"],
    "門牌.路街段巷弄": door["路街段巷弄"],
    "門牌.號": door["號"],
    "門牌.樓": door["樓"],
  });
}

function parentFields(record) {
  const out = {};
  Object.entries(record || {}).forEach(([key, value]) => {
    if (key === "_id") return;
    if (Array.isArray(value)) return;
    if (value && typeof value === "object") return;
    out[key] = value;
  });
  return out;
}

function explodeRecord(record, recordIndex) {
  const parent = parentFields(record);
  const address = primaryAddress(record);
  const nested = Object.entries(record || {}).filter(([, value]) => Array.isArray(value));
  const rows = [];
  nested.forEach(([section, list]) => {
    list.forEach((child, childIndex) => {
      const flat = { _record: recordIndex + 1, _section: section, "資料區塊": section, _child: childIndex + 1, ...parent };
      Object.entries(child || {}).forEach(([key, value]) => {
        flat[`${section}.${key}`] = value;
      });
      flat["完整地址"] = reconstructAddress(flat) || address;
      flat._raw = { parent: record, section, child };
      rows.push(flat);
    });
  });
  if (!rows.length) {
    const flat = { _record: recordIndex + 1, _section: "主資料", "資料區塊": "主資料", _child: 1, ...parent, ...window.cpamiOpenData.flattenPaths(record) };
    flat["完整地址"] = reconstructAddress(flat) || address;
    flat._raw = record;
    rows.push(flat);
  }
  return rows;
}

function normalizePayload(payload) {
  const records = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return records.flatMap((record, index) => explodeRecord(record, index));
}

function columnsForRows(rows) {
  const keys = new Set();
  rows.forEach((row) => Object.keys(row).forEach((key) => {
    if (!["_raw", "_record", "_child", "_section"].includes(key)) keys.add(key);
  }));
  const ordered = COLUMN_ORDER.filter((key) => keys.has(key));
  const rest = [...keys].filter((key) => !ordered.includes(key)).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  return [...ordered, ...rest].slice(0, 34);
}

function widthStyle(field) {
  const width = state.widths[field] || (field === "完整地址" ? 260 : field.length > 8 ? 160 : 110);
  return `style="width:${width}px;min-width:${width}px;max-width:${width}px"`;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const left = String(a[state.sortBy] ?? "");
    const right = String(b[state.sortBy] ?? "");
    const result = left.localeCompare(right, "zh-Hant", { numeric: true });
    return state.sortDir === "ASC" ? result : -result;
  });
}

function renderRows() {
  const cols = columnsForRows(state.rows);
  const rows = sortRows(state.rows);
  el("#gridHead").innerHTML = `<tr>${cols.map((field) => `
    <th ${widthStyle(field)} data-field="${escapeHtml(field)}">
      <button type="button" data-sort="${escapeHtml(field)}">${escapeHtml(field)}${state.sortBy === field ? (state.sortDir === "ASC" ? " ▲" : " ▼") : ""}</button>
      <span class="resize-handle" data-resize="${escapeHtml(field)}"></span>
    </th>
  `).join("")}</tr>`;
  el("#gridRows").innerHTML = rows.map((row, rowIndex) => `
    <tr data-row-index="${rowIndex}">${cols.map((field) => {
      const value = compactValue(row[field]);
      return `<td ${widthStyle(field)} title="${escapeHtml(value)}"><button class="pivot-cell" type="button" data-field="${escapeHtml(field)}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button></td>`;
    }).join("")}</tr>
  `).join("");
  el("#resultMeta").textContent = `1NF ${money.format(rows.length)} rows · API max 100 objects`;
}

function setLoadProgress(value, text = "") {
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  el("#loadStatusFill").style.width = `${Math.round(progress * 100)}%`;
  el("#loadStatusBar").setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  if (text) el("#loadStatusText").textContent = text;
  document.body.classList.add("loading-sqlite");
}

function hideLoadProgress() {
  setTimeout(() => document.body.classList.remove("loading-sqlite"), 1200);
}

async function runQuery() {
  syncQueryInput();
  setLoadProgress(0.12, "查詢彰化建照 OpenData...");
  try {
    const started = performance.now();
    const result = await window.cpamiOpenData.fetchJson(state.params);
    setLoadProgress(0.72, "轉成 1NF table...");
    state.raw = { query: state.params, meta: result.meta, data: result.data };
    state.rows = normalizePayload(result.data);
    if (!state.rows.some((row) => row[state.sortBy] != null)) state.sortBy = "資料區塊";
    renderRows();
    const elapsed = Math.round(performance.now() - started);
    el("#perfBadge").textContent = `BUILDLIC · ${result.data?.data?.length || 0} objects · ${state.rows.length} 1NF rows · ${elapsed}ms`;
    el("#detailTitle").textContent = "Query";
    el("#detailBody").innerHTML = `
      <div class="stat-line"><span>API objects</span><strong>${money.format(result.data?.data?.length || 0)}</strong></div>
      <div class="stat-line"><span>1NF rows</span><strong>${money.format(state.rows.length)}</strong></div>
      <div class="stat-line"><span>Fetch</span><strong>${escapeHtml(result.meta.source)}</strong></div>
      <button type="button" id="showRawPayload">Raw JSON</button>
    `;
    setLoadProgress(1, "Data ready");
  } catch (error) {
    state.raw = { query: state.params, url: window.cpamiOpenData.queryUrl(state.params), error: error.message };
    state.rows = [];
    renderRows();
    el("#detailTitle").textContent = "Query failed";
    el("#detailBody").innerHTML = `<p>${escapeHtml(error.message)}</p><a href="${escapeHtml(state.raw.url)}" target="_blank" rel="noreferrer">Open API URL</a>`;
    setLoadProgress(1, "Query failed");
  } finally {
    hideLoadProgress();
  }
}

function pivotQuery(field, value) {
  if (!field || !value) return;
  const next = { ...BASE_PARAMS, [field]: value };
  state.params = next;
  writeLocationState();
  runQuery();
}

function exportCsv() {
  const cols = columnsForRows(state.rows);
  const rows = sortRows(state.rows);
  const csv = [cols.join(",")].concat(rows.map((row) => cols.map((field) => `"${String(compactValue(row[field])).replace(/"/g, '""')}"`).join(","))).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `buildlic-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bind() {
  el("#runQuery").addEventListener("click", () => {
    applyQueryString(el("#queryInput").value);
    runQuery();
  });
  el("#queryInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    applyQueryString(el("#queryInput").value);
    runQuery();
  });
  el("#resetQuery").addEventListener("click", () => {
    state.params = { ...DEFAULT_PARAMS };
    writeLocationState();
    runQuery();
  });
  el("#queryPairs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-param]");
    if (!button) return;
    delete state.params[button.dataset.removeParam];
    writeLocationState();
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
    renderRows();
  });
  el("#gridHead").addEventListener("mousedown", (event) => {
    const handle = event.target.closest("[data-resize]");
    if (!handle) return;
    const field = handle.dataset.resize;
    const startX = event.clientX;
    const startWidth = state.widths[field] || 140;
    const move = (moveEvent) => {
      state.widths[field] = Math.max(72, startWidth + moveEvent.clientX - startX);
      renderRows();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  el("#gridRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-field]");
    if (!button) return;
    pivotQuery(button.dataset.field, button.dataset.value);
  });
  el("#gridRows").addEventListener("contextmenu", (event) => {
    const tr = event.target.closest("tr");
    if (!tr) return;
    event.preventDefault();
    const row = sortRows(state.rows)[Number(tr.dataset.rowIndex)];
    openJson(row["完整地址"] || row["核發執照字號"] || "1NF row", row._section || "", row._raw || row);
  });
  el("#detailBody").addEventListener("click", (event) => {
    if (event.target.id === "showRawPayload") openJson("BUILDLIC payload", window.cpamiOpenData.queryUrl(state.params), state.raw);
  });
  el("#openApi").addEventListener("click", () => window.open(window.cpamiOpenData.queryUrl(state.params), "_blank", "noopener"));
  el("#copyUrl").addEventListener("click", () => navigator.clipboard?.writeText(window.cpamiOpenData.queryUrl(state.params)));
  el("#exportCsv").addEventListener("click", exportCsv);
  el("#themeToggle").addEventListener("click", () => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark", { sync: true }));
  el("#closeJson").addEventListener("click", closeJson);
  el("#jsonDrawer").addEventListener("click", (event) => {
    if (event.target.id === "jsonDrawer") closeJson();
  });
}

function init() {
  setTheme(themeFromLocation());
  state.params = parseParamsFromLocation();
  writeLocationState();
  bind();
  runQuery();
}

document.addEventListener("DOMContentLoaded", init);
