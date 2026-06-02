const DATA_SOURCES = [
  {
    id: "moj-115q1",
    label: "行政執行署 aggregated",
    path: "data/auction/moj-executive-auctions.json",
    officialUrl: "https://data.gov.tw/dataset/177351",
  },
];

const BUSINESS_MATCH_PATH = "data/auction/business-address-matches.json";

const columns = [
  ["soldDate", "拍定日期", "date", 92],
  ["city", "縣市", "string", 82],
  ["district", "鄉鎮", "string", 86],
  ["address", "地址", "string", 260],
  ["businessCount", "稅籍", "number", 58],
  ["businessNames", "營業人", "string", 180],
  ["landNo", "地號", "string", 126],
  ["branch", "分署", "string", 86],
  ["caseNo", "執行案號", "string", 148],
  ["type", "類別", "string", 70],
  ["round", "拍次", "string", 78],
  ["soldPrice", "拍定金額", "money", 96],
  ["floorPrice", "拍賣底價", "money", 96],
  ["areaPing", "面積坪", "number", 82],
  ["use", "用途", "string", 86],
  ["url", "網址", "string", 72],
  ["raw", "Raw", "string", 58],
];

const state = {
  sourceId: DATA_SOURCES[0].id,
  source: DATA_SOURCES[0],
  rows: [],
  filtered: [],
  businessJoin: null,
  city: "",
  district: "",
  type: "",
  round: "",
  keyword: "",
  priceMinWan: "",
  priceMaxWan: "",
  areaMin: "",
  areaMax: "",
  sortBy: "soldDate",
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

function normalizeAddress(value) {
  return normalizeText(value)
    .replace(/之/g, "-")
    .replace(/[^\u4e00-\u9fa5a-z0-9-]/g, "");
}

function toNumber(value) {
  const num = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : 0;
}

function parseDate(value) {
  const parts = String(value || "").match(/\d+/g) || [];
  if (parts.length < 3) return "";
  const year = Number(parts[0]) + (Number(parts[0]) < 1911 ? 1911 : 0);
  return `${year}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
}

function caseNoOf(row) {
  return [row["執行案號-年度"], row["執行案號-案件種類代碼"], row["執行案號-流水號"]]
    .filter(Boolean)
    .join("-");
}

function stableId(row, index) {
  if (row["_auction_id"]) return row["_auction_id"];
  return normalizeText([row["分署別"], row["股別"], row["標別"], caseNoOf(row), row["地址"], row["地號"], row["拍定日期"], row["拍定金額"], index].join("|"));
}

function normalizeRow(row, index) {
  const address = row["地址"] || "";
  const item = {
    id: stableId(row, index),
    sourceId: state.sourceId,
    branch: row["分署別"] || "",
    department: row["股別"] || "",
    bidNo: row["標別"] || "",
    city: row["縣市"] || "",
    district: row["鄉鎮區"] || "",
    type: row["拍賣類別"] || "",
    landNo: row["地號"] || "",
    address,
    normalizedAddress: normalizeAddress(address),
    areaM2: toNumber(row["面積-平方公尺"]),
    areaPing: toNumber(row["面積-坪"]),
    amount: toNumber(row["金額"]),
    floorPrice: toNumber(row["拍賣底價"]),
    soldPrice: toNumber(row["拍定金額"]),
    soldDate: parseDate(row["拍定日期"]),
    soldDateRaw: row["拍定日期"] || "",
    use: row["用途"] || "",
    round: row["拍次"] || "",
    caseYear: row["執行案號-年度"] || "",
    caseKind: row["執行案號-案件種類代碼"] || "",
    caseSerial: row["執行案號-流水號"] || "",
    caseNo: caseNoOf(row),
    url: row["網址"] || "",
    businessMatches: [],
    businessCount: 0,
    businessNames: "",
    raw: row,
  };
  item.searchText = normalizeText([
    item.branch,
    item.department,
    item.bidNo,
    item.city,
    item.district,
    item.type,
    item.landNo,
    item.address,
    item.normalizedAddress,
    item.soldDate,
    item.soldDateRaw,
    item.round,
    item.use,
    item.caseNo,
    item.businessNames,
    item.soldPrice,
    Math.round(item.soldPrice / 10000),
    JSON.stringify(row),
  ].join(" "));
  return item;
}

function applyBusinessMatches(rows, join) {
  const matches = join?.matchesByAuctionId || {};
  return rows.map((row) => {
    const businessMatches = matches[row.id] || [];
    const names = [...new Set(businessMatches.map((item) => item.businessName).filter(Boolean))].slice(0, 3);
    row.businessMatches = businessMatches;
    row.businessCount = businessMatches.length;
    row.businessNames = names.join("、");
    row.searchText = normalizeText([
      row.searchText,
      row.businessNames,
      businessMatches.map((item) => [
        item.businessId,
        item.businessName,
        item.businessAddress,
        item.industryCode,
        item.industryName,
        item.industryCode1,
        item.industryName1,
      ].join(" ")).join(" "),
    ].join(" "));
    return row;
  });
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
  setLoadProgress(0.03, "讀取法拍資料...");
  const response = await fetch(`${path}?v=20260602-auction-terminal`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const data = await response.json();
    setLoadProgress(0.78, "解析法拍資料...");
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total) setLoadProgress(0.08 + (loaded / total) * 0.62, `下載法拍資料 ${money.format(Math.round(loaded / 1024))} KB`);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  setLoadProgress(0.78, "解析法拍資料...");
  return JSON.parse(new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, ""));
}

function auctionRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

async function fetchOptionalJson(path) {
  const response = await fetch(`${path}?v=20260602-business-join`);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status}: ${path}`);
  }
  return response.json();
}

function uniqueOptions(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
}

function renderOptions() {
  el("#sourceSelect").innerHTML = DATA_SOURCES.map((source) => `<option value="${source.id}">${escapeHtml(source.label)}</option>`).join("");
  el("#sourceSelect").value = state.sourceId;
  const cities = uniqueOptions(state.rows, "city");
  el("#citySelect").innerHTML = `<option value="">全部</option>${cities.map((city) => `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join("")}`;
  el("#citySelect").value = state.city;
  const districtRows = state.city ? state.rows.filter((row) => row.city === state.city) : state.rows;
  const districts = uniqueOptions(districtRows, "district");
  el("#districtSelect").innerHTML = `<option value="">全部</option>${districts.map((district) => `<option value="${escapeHtml(district)}">${escapeHtml(district)}</option>`).join("")}`;
  el("#districtSelect").value = state.district;
  el("#typeSelect").innerHTML = `<option value="">全部</option>${uniqueOptions(state.rows, "type").map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}`;
  el("#typeSelect").value = state.type;
  el("#roundSelect").innerHTML = `<option value="">全部</option>${uniqueOptions(state.rows, "round").map((round) => `<option value="${escapeHtml(round)}">${escapeHtml(round)}</option>`).join("")}`;
  el("#roundSelect").value = state.round;
  const businessSource = state.businessJoin?.source;
  const businessLine = businessSource
    ? `<br>稅籍：<a href="${escapeHtml(businessSource.datasetUrl)}" target="_blank" rel="noreferrer">${escapeHtml(businessSource.dataset)}</a><br>授權：<a href="${escapeHtml(businessSource.licenseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(businessSource.license)}</a>`
    : "";
  el("#sourceNote").innerHTML = `資料：${escapeHtml(state.source.label)}<br>官方：<a href="${escapeHtml(state.source.officialUrl)}" target="_blank" rel="noreferrer">JSON</a>${businessLine}`;
}

function sortRows(rows) {
  const column = columns.find(([key]) => key === state.sortBy);
  const type = column?.[2] || "string";
  const dir = state.sortDir === "ASC" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[state.sortBy] ?? "";
    const bv = b[state.sortBy] ?? "";
    if (type === "number" || type === "money") return (Number(av || 0) - Number(bv || 0)) * dir;
    return String(av).localeCompare(String(bv), "zh-Hant", { numeric: true }) * dir;
  });
}

function applyFilters() {
  const terms = normalizeText(state.keyword).split(/[,+，、]/).filter(Boolean);
  const minPrice = state.priceMinWan === "" ? null : Number(state.priceMinWan) * 10000;
  const maxPrice = state.priceMaxWan === "" ? null : Number(state.priceMaxWan) * 10000;
  const minArea = state.areaMin === "" ? null : Number(state.areaMin);
  const maxArea = state.areaMax === "" ? null : Number(state.areaMax);
  state.filtered = sortRows(state.rows.filter((row) => {
    if (state.city && row.city !== state.city) return false;
    if (state.district && row.district !== state.district) return false;
    if (state.type && row.type !== state.type) return false;
    if (state.round && row.round !== state.round) return false;
    if (minPrice != null && row.soldPrice < minPrice) return false;
    if (maxPrice != null && row.soldPrice > maxPrice) return false;
    if (minArea != null && row.areaPing < minArea) return false;
    if (maxArea != null && row.areaPing > maxArea) return false;
    if (terms.length && !terms.every((term) => row.searchText.includes(term))) return false;
    return true;
  }));
  renderTable();
  renderMeta();
}

function formatCell(row, key, type) {
  if (key === "url") return row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">open</a>` : "";
  if (key === "raw") return "JSON";
  const value = row[key];
  if (type === "money") return value ? `${money.format(Math.round(value / 10000))}萬` : "";
  if (type === "number") return value ? decimal.format(value) : "";
  return escapeHtml(value);
}

function formatBusinessMatches(matches) {
  if (!matches?.length) return `<div class="empty-note">沒有稅籍登記地址匹配。</div>`;
  return `<section class="business-matches">
    <h3>稅籍登記匹配</h3>
    ${matches.slice(0, 80).map((item) => `<article class="business-match">
      <div><strong>${escapeHtml(item.businessName || item.businessId)}</strong><span>${escapeHtml(item.confidence)} · ${escapeHtml(item.matchMethod)}</span></div>
      <div class="detail-grid small">
        <span>統一編號</span><span>${escapeHtml(item.businessId)}</span>
        <span>營業地址</span><span>${escapeHtml(item.businessAddress)}</span>
        <span>資本額</span><span>${item.capital ? `${money.format(Number(item.capital))}元` : ""}</span>
        <span>設立日期</span><span>${escapeHtml(item.setupDate)}</span>
        <span>組織</span><span>${escapeHtml(item.organization)}</span>
        <span>行業</span><span>${escapeHtml([item.industryName, item.industryName1].filter(Boolean).join("、"))}</span>
      </div>
    </article>`).join("")}
    ${matches.length > 80 ? `<div class="empty-note">只顯示前 80 筆，共 ${money.format(matches.length)} 筆。</div>` : ""}
  </section>`;
}

function renderTable() {
  el("#gridHead").innerHTML = `<tr>${columns.map(([key, label, , width]) => {
    const marker = state.sortBy === key ? (state.sortDir === "ASC" ? " ▲" : " ▼") : "";
    return `<th data-sort="${key}" style="width:${width}px">${escapeHtml(label)}${marker}</th>`;
  }).join("")}</tr>`;
  el("#gridRows").innerHTML = state.filtered.slice(0, 1200).map((row) => {
    const active = row.id === state.activeId ? " class=\"active\"" : "";
    return `<tr data-id="${escapeHtml(row.id)}"${active}>${columns.map(([key, , type, width]) => {
      return `<td class="${type === "money" ? "money" : type === "number" ? "num" : ""}" style="width:${width}px" title="${escapeHtml(key === "raw" ? JSON.stringify(row.raw) : row[key])}">${formatCell(row, key, type)}</td>`;
    }).join("")}</tr>`;
  }).join("");
}

function renderMeta() {
  const maxPrice = state.filtered.reduce((max, row) => Math.max(max, row.soldPrice || 0), 0);
  el("#resultMeta").textContent = `${money.format(state.filtered.length)} / ${money.format(state.rows.length)} rows · max ${money.format(Math.round(maxPrice / 10000))}萬`;
  el("#perfBadge").textContent = `${money.format(state.rows.length)} auction rows`;
}

function openDetail(id) {
  const row = state.rows.find((item) => item.id === id);
  if (!row) return;
  state.activeId = id;
  el("#detailTitle").textContent = row.address || row.landNo || "Auction";
  const fields = [
    ["拍定日期", row.soldDate || row.soldDateRaw],
    ["拍定金額", row.soldPrice ? `${money.format(Math.round(row.soldPrice / 10000))}萬` : ""],
    ["拍賣底價", row.floorPrice ? `${money.format(Math.round(row.floorPrice / 10000))}萬` : ""],
    ["分署", row.branch],
    ["案號", row.caseNo],
    ["股別", row.department],
    ["縣市", row.city],
    ["鄉鎮", row.district],
    ["地址", row.address],
    ["地號", row.landNo],
    ["面積", row.areaPing ? `${decimal.format(row.areaPing)} 坪` : ""],
    ["類別", row.type],
    ["拍次", row.round],
    ["用途", row.use],
    ["網址", row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">open</a>` : ""],
  ];
  el("#detailBody").innerHTML = `<div class="detail-grid">${fields.map(([label, value]) => `<span>${escapeHtml(label)}</span><span>${typeof value === "string" && value.startsWith("<a ") ? value : escapeHtml(value)}</span>`).join("")}</div>${formatBusinessMatches(row.businessMatches)}<pre class="raw-box">${escapeHtml(JSON.stringify({ auction: row.raw, businessMatches: row.businessMatches }, null, 2))}</pre>`;
  renderTable();
}

function exportCsv() {
  const header = columns.filter(([key]) => key !== "raw").map(([, label]) => label);
  const lines = [header.join(",")];
  for (const row of state.filtered) {
    lines.push(columns.filter(([key]) => key !== "raw").map(([key]) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `auction-filtered-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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

function bindEvents() {
  el("#sourceSelect").addEventListener("change", async (event) => {
    state.sourceId = event.target.value;
    state.source = DATA_SOURCES.find((source) => source.id === state.sourceId) || DATA_SOURCES[0];
    await loadSource();
  });
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
  el("#typeSelect").addEventListener("change", (event) => {
    state.type = event.target.value;
    applyFilters();
  });
  el("#roundSelect").addEventListener("change", (event) => {
    state.round = event.target.value;
    applyFilters();
  });
  for (const id of ["keywordInput", "priceMin", "priceMax", "areaMin", "areaMax"]) {
    el(`#${id}`).addEventListener("input", () => {
      state.keyword = el("#keywordInput").value;
      state.priceMinWan = el("#priceMin").value;
      state.priceMaxWan = el("#priceMax").value;
      state.areaMin = el("#areaMin").value;
      state.areaMax = el("#areaMax").value;
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
  const started = performance.now();
  try {
    const rawPayload = await fetchJsonWithProgress(state.source.path);
    const rawRows = auctionRowsFromPayload(rawPayload);
    setLoadProgress(0.84, "讀取稅籍地址匹配...");
    state.businessJoin = await fetchOptionalJson(BUSINESS_MATCH_PATH);
    setLoadProgress(0.9, "合併稅籍匹配...");
    state.rows = applyBusinessMatches(rawRows.map(normalizeRow), state.businessJoin);
    state.city = "";
    state.district = "";
    state.type = "";
    state.round = "";
    renderOptions();
    applyFilters();
    setLoadProgress(1, `完成 ${money.format(state.rows.length)} 筆 · 稅籍匹配 ${money.format(state.businessJoin?.matchedAuctionCount || 0)} 筆`);
    setTimeout(() => document.body.classList.remove("loading"), 900);
    el("#perfBadge").textContent = `${money.format(state.rows.length)} rows · ${Math.round(performance.now() - started)}ms`;
  } catch (error) {
    el("#loadStatusText").textContent = `法拍資料載入失敗：${error.message}`;
    console.error(error);
  }
}

async function init() {
  bindEvents();
  setTheme(new URLSearchParams(location.search).get("theme") || "dark");
  await loadSource();
}

init();
