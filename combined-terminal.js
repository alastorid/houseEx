const DATA_PATH = "data/auction/auction-plvr-address-matches.json";

const columns = [
  ["soldDate", "拍定日期", "date", 92],
  ["city", "縣市", "string", 82],
  ["district", "鄉鎮", "string", 86],
  ["address", "法拍地址", "string", 250],
  ["soldPrice", "拍定金額", "money", 96],
  ["plvrMatchCount", "實登", "number", 58],
  ["latestPlvrDate", "最新實登", "date", 92],
  ["latestPlvrPrice", "最新總價", "money", 92],
  ["latestUnitPrice", "最新單價/坪", "unitMoney", 96],
  ["latestBuildingPing", "建坪", "number", 74],
  ["latestBuildingType", "型態", "string", 92],
  ["priceDiff", "價差", "money", 92],
  ["priceDiffPct", "價差%", "number", 74],
  ["branch", "分署", "string", 86],
  ["caseNo", "案號", "string", 140],
  ["type", "類別", "string", 70],
  ["round", "拍次", "string", 78],
  ["url", "網址", "string", 72],
];

const state = {
  rows: [],
  filtered: [],
  source: null,
  city: "",
  district: "",
  keyword: "",
  priceMinWan: "",
  priceMaxWan: "",
  plvrMinWan: "",
  plvrMaxWan: "",
  sortBy: "plvrMatchCount",
  sortDir: "DESC",
  activeId: "",
};

const el = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/臺/g, "台")
    .replace(/巿/g, "市")
    .replace(/[－–—─―]/g, "-")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function setTheme(theme, sync = false) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  el("#themeToggle").textContent = theme === "dark" ? "☀" : "☾";
  if (sync) {
    const url = new URL(location.href);
    url.searchParams.set("theme", theme);
    history.replaceState(null, "", url);
  }
}

function setLoadProgress(value, text = "") {
  const fill = el("#loadStatusFill");
  const bar = el("#loadStatusBar");
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  fill.style.width = `${Math.round(progress * 100)}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  if (text) el("#loadStatusText").textContent = text;
}

async function fetchJsonWithProgress(path) {
  document.body.classList.add("loading");
  setLoadProgress(0.04, "讀取合併資料...");
  const response = await fetch(`${path}?v=20260602-combined`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const data = await response.json();
    setLoadProgress(0.85, "解析合併資料...");
    return data;
  }
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total) setLoadProgress(0.08 + (loaded / total) * 0.7, `下載 ${money.format(Math.round(loaded / 1024))} KB`);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  setLoadProgress(0.85, "解析合併資料...");
  return JSON.parse(new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, ""));
}

function enrichRow(row) {
  const matches = row.plvrMatches || [];
  const latest = [...matches].sort((a, b) => String(b.transactionDate).localeCompare(String(a.transactionDate)))[0] || {};
  const latestPlvrPrice = Number(latest.totalPrice) || 0;
  const soldPrice = Number(row.soldPrice) || 0;
  const priceDiff = latestPlvrPrice && soldPrice ? latestPlvrPrice - soldPrice : 0;
  const item = {
    ...row,
    latestPlvrDate: latest.transactionDate || "",
    latestPlvrPrice,
    latestUnitPrice: Number(latest.unitPricePing) || 0,
    latestBuildingPing: Number(latest.buildingAreaPing) || 0,
    latestBuildingType: latest.buildingType || "",
    priceDiff,
    priceDiffPct: soldPrice ? (priceDiff / soldPrice) * 100 : 0,
  };
  item.searchText = normalizeText([
    item.city,
    item.district,
    item.address,
    item.landNo,
    item.caseNo,
    item.branch,
    item.type,
    item.round,
    matches.map((match) => [match.city, match.district, match.address, match.buildingType, match.transactionTarget, match.sourceBatch, JSON.stringify(match.raw || {})].join(" ")).join(" "),
  ].join(" "));
  return item;
}

function uniqueOptions(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
}

function renderOptions() {
  const cities = uniqueOptions(state.rows, "city");
  el("#citySelect").innerHTML = `<option value="">全部</option>${cities.map((city) => `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join("")}`;
  el("#citySelect").value = state.city;
  const districtRows = state.city ? state.rows.filter((row) => row.city === state.city) : state.rows;
  const districts = uniqueOptions(districtRows, "district");
  el("#districtSelect").innerHTML = `<option value="">全部</option>${districts.map((district) => `<option value="${escapeHtml(district)}">${escapeHtml(district)}</option>`).join("")}`;
  el("#districtSelect").value = state.district;
  const source = state.source || {};
  el("#sourceNote").innerHTML = `法拍：${escapeHtml(source.auction || "法務部行政執行署")}<br>實登：${escapeHtml(source.plvr || "內政部實價登錄 Open Data")}<br>授權：<a href="${escapeHtml(source.licenseUrl || "https://data.gov.tw/licenses")}" target="_blank" rel="noreferrer">${escapeHtml(source.license || "政府資料開放授權條款-第1版")}</a>`;
}

function sortRows(rows) {
  const column = columns.find(([key]) => key === state.sortBy);
  const type = column?.[2] || "string";
  const dir = state.sortDir === "ASC" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[state.sortBy] ?? "";
    const bv = b[state.sortBy] ?? "";
    if (type === "number" || type === "money" || type === "unitMoney") return (Number(av || 0) - Number(bv || 0)) * dir;
    return String(av).localeCompare(String(bv), "zh-Hant", { numeric: true }) * dir;
  });
}

function applyFilters() {
  const terms = normalizeText(state.keyword).split(/[,+，、]/).filter(Boolean);
  const minPrice = state.priceMinWan === "" ? null : Number(state.priceMinWan) * 10000;
  const maxPrice = state.priceMaxWan === "" ? null : Number(state.priceMaxWan) * 10000;
  const minPlvr = state.plvrMinWan === "" ? null : Number(state.plvrMinWan) * 10000;
  const maxPlvr = state.plvrMaxWan === "" ? null : Number(state.plvrMaxWan) * 10000;
  state.filtered = sortRows(state.rows.filter((row) => {
    if (state.city && row.city !== state.city) return false;
    if (state.district && row.district !== state.district) return false;
    if (minPrice != null && row.soldPrice < minPrice) return false;
    if (maxPrice != null && row.soldPrice > maxPrice) return false;
    if (minPlvr != null && row.latestPlvrPrice < minPlvr) return false;
    if (maxPlvr != null && row.latestPlvrPrice > maxPlvr) return false;
    if (terms.length && !terms.every((term) => row.searchText.includes(term))) return false;
    return true;
  }));
  renderTable();
  renderMeta();
}

function formatCell(row, key, type) {
  if (key === "url") return row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">open</a>` : "";
  const value = row[key];
  if (type === "money") return value ? `${money.format(Math.round(value / 10000))}萬` : "";
  if (type === "unitMoney") return value ? `${money.format(Math.round(value))}` : "";
  if (type === "number") return Number.isFinite(Number(value)) ? decimal.format(Number(value)) : "";
  return escapeHtml(value);
}

function renderTable() {
  el("#gridHead").innerHTML = `<tr>${columns.map(([key, label, , width]) => {
    const marker = state.sortBy === key ? (state.sortDir === "ASC" ? " ▲" : " ▼") : "";
    return `<th data-sort="${key}" style="width:${width}px">${escapeHtml(label)}${marker}</th>`;
  }).join("")}</tr>`;
  el("#gridRows").innerHTML = state.filtered.slice(0, 1600).map((row) => {
    const active = row.auctionId === state.activeId ? " class=\"active\"" : "";
    return `<tr data-id="${escapeHtml(row.auctionId)}"${active}>${columns.map(([key, , type, width]) => `<td class="${type === "money" || type === "unitMoney" ? "money" : type === "number" ? "num" : ""}" style="width:${width}px" title="${escapeHtml(row[key])}">${formatCell(row, key, type)}</td>`).join("")}</tr>`;
  }).join("");
}

function renderMeta() {
  el("#resultMeta").textContent = `${money.format(state.filtered.length)} / ${money.format(state.rows.length)} joined rows`;
  el("#perfBadge").textContent = `${money.format(state.rows.length)} joins`;
}

function detailItem(label, value) {
  return `<span>${escapeHtml(label)}</span><span>${escapeHtml(value || "")}</span>`;
}

function openDetail(id) {
  const row = state.rows.find((item) => item.auctionId === id);
  if (!row) return;
  state.activeId = id;
  el("#detailTitle").textContent = row.address || "Combined";
  const auctionFields = [
    ["拍定日期", row.soldDate],
    ["拍定金額", row.soldPrice ? `${money.format(Math.round(row.soldPrice / 10000))}萬` : ""],
    ["分署", row.branch],
    ["案號", row.caseNo],
    ["縣市", row.city],
    ["鄉鎮", row.district],
    ["地址", row.address],
    ["地號", row.landNo],
    ["類別", row.type],
    ["拍次", row.round],
  ];
  const plvrRows = (row.plvrMatches || []).slice(0, 80).map((match) => `<tr>
    <td>${escapeHtml(match.transactionDate)}</td>
    <td>${escapeHtml(match.address)}</td>
    <td class="money">${match.totalPrice ? `${money.format(Math.round(match.totalPrice / 10000))}萬` : ""}</td>
    <td class="money">${match.unitPricePing ? money.format(Math.round(match.unitPricePing)) : ""}</td>
    <td class="num">${match.buildingAreaPing ? decimal.format(match.buildingAreaPing) : ""}</td>
    <td>${escapeHtml(match.buildingType)}</td>
    <td>${escapeHtml(match.matchMethod)} ${escapeHtml(match.confidence)}</td>
  </tr>`).join("");
  el("#detailBody").innerHTML = `<div class="detail-grid">${auctionFields.map(([label, value]) => detailItem(label, value)).join("")}</div>
    <section class="business-matches"><h3>實價登錄匹配</h3>
      <div class="mini-table"><table><thead><tr><th>日期</th><th>地址</th><th>總價</th><th>單價/坪</th><th>建坪</th><th>型態</th><th>比對</th></tr></thead><tbody>${plvrRows}</tbody></table></div>
    </section>`;
  renderTable();
}

function exportCsv() {
  const header = columns.map(([, label]) => label);
  const lines = [header.join(",")];
  for (const row of state.filtered) {
    lines.push(columns.map(([key]) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `combined-filtered-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  el("#citySelect").addEventListener("change", (event) => {
    state.city = event.target.value;
    state.district = "";
    renderOptions();
    applyFilters();
  });
  el("#districtSelect").addEventListener("change", (event) => {
    state.district = event.target.value;
    applyFilters();
  });
  for (const id of ["keywordInput", "priceMin", "priceMax", "plvrMin", "plvrMax"]) {
    el(`#${id}`).addEventListener("input", () => {
      state.keyword = el("#keywordInput").value;
      state.priceMinWan = el("#priceMin").value;
      state.priceMaxWan = el("#priceMax").value;
      state.plvrMinWan = el("#plvrMin").value;
      state.plvrMaxWan = el("#plvrMax").value;
      applyFilters();
    });
  }
  el("#gridHead").addEventListener("click", (event) => {
    const key = event.target.closest("[data-sort]")?.dataset.sort;
    if (!key) return;
    if (state.sortBy === key) state.sortDir = state.sortDir === "ASC" ? "DESC" : "ASC";
    else {
      state.sortBy = key;
      state.sortDir = "ASC";
    }
    applyFilters();
  });
  el("#gridRows").addEventListener("click", (event) => {
    const id = event.target.closest("tr")?.dataset.id;
    if (id) openDetail(id);
  });
  el("#exportCsv").addEventListener("click", exportCsv);
  el("#themeToggle").addEventListener("click", () => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark", true));
}

async function loadSource() {
  try {
    const payload = await fetchJsonWithProgress(DATA_PATH);
    state.source = payload.source || {};
    state.rows = (payload.rows || []).map(enrichRow);
    renderOptions();
    applyFilters();
    setLoadProgress(1, `完成 ${money.format(state.rows.length)} 筆合併資料`);
    setTimeout(() => document.body.classList.remove("loading"), 900);
  } catch (error) {
    el("#loadStatusText").textContent = `合併資料載入失敗：${error.message}`;
    console.error(error);
  }
}

async function init() {
  bindEvents();
  setTheme(new URLSearchParams(location.search).get("theme") || "dark");
  await loadSource();
}

init();
