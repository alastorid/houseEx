const REGION_INDEX = "data/plvr/web-index.json";

const knownCommunities = [
  {
    name: "寶鴻高鐵湛",
    aliases: ["寶鴻", "高鐵湛", "寶鴻高鐵湛"],
    city: "彰化縣",
    township: "社頭鄉",
    keywords: ["高鐵北二路"],
    hint: "高鐵北二路 162-198 號一帶",
  },
];

const state = {
  index: null,
  city: "",
  township: "",
  region: null,
  records: [],
  filtered: [],
  includeDetails: false,
  activeCommunity: null,
};

const numberFormat = new Intl.NumberFormat("zh-TW");
const moneyFormat = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });

const el = (selector) => document.querySelector(selector);

function twDateToIso(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 6) return "";
  const year = Number(digits.slice(0, digits.length - 4)) + 1911;
  const month = digits.slice(-4, -2).padStart(2, "0");
  const day = digits.slice(-2).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toNumber(value) {
  const clean = String(value || "").replace(/[,，\s]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function recordValues(record) {
  return record.values || {};
}

function addressOf(record) {
  const values = recordValues(record);
  return values["土地位置建物門牌"] || values["土地位置"] || "";
}

function transactionId(record) {
  return recordValues(record)["編號"] || "";
}

function isMainRecord(record) {
  return record.table_kind === "主檔";
}

function displayRecords() {
  return state.includeDetails ? state.filtered : state.filtered.filter(isMainRecord);
}

function formatWan(value) {
  if (!value) return "--";
  return `${moneyFormat.format(value / 10000)}萬`;
}

function formatUnit(value) {
  if (!value) return "--";
  return `${moneyFormat.format(value)}`;
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? nums.reduce((sum, v) => sum + v, 0) / nums.length : 0;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function parseMain(record) {
  const values = recordValues(record);
  return {
    record,
    id: transactionId(record),
    date: twDateToIso(values["交易年月日"]),
    rawDate: values["交易年月日"] || "",
    address: addressOf(record),
    target: values["交易標的"] || record.transaction_type || "",
    totalPrice: toNumber(values["總價元"]),
    unitPrice: toNumber(values["單價元平方公尺"]),
    buildingArea: toNumber(values["建物移轉總面積平方公尺"]),
    landArea: toNumber(values["土地移轉總面積平方公尺"]),
    rooms: values["建物現況格局-房"] || "",
    halls: values["建物現況格局-廳"] || "",
    baths: values["建物現況格局-衛"] || "",
    floor: values["移轉層次"] || "",
    totalFloor: values["總樓層數"] || "",
    buildingType: values["建物型態"] || "",
    builtDate: values["建築完成年月"] || "",
    note: values["備註"] || "",
    source: record._source_id,
    file: record._file,
  };
}

function sourceRank(source) {
  if (source === "current") return 99999999;
  const match = String(source).match(/^(\d{3})S([1-4])$/);
  if (match) return Number(match[1]) * 10 + Number(match[2]);
  return Number(String(source).replace(/\D/g, "")) || 0;
}

function buildMainRows(records = state.filtered) {
  const seen = new Map();
  for (const record of records.filter(isMainRecord)) {
    const row = parseMain(record);
    if (!row.address) continue;
    const key = row.id || `${normalizeText(row.address)}-${row.rawDate}-${row.totalPrice}-${row.unitPrice}`;
    const current = seen.get(key);
    if (!current || sourceRank(row.source) > sourceRank(current.source)) {
      seen.set(key, row);
    }
  }
  return [...seen.values()]
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || sourceRank(a.source) - sourceRank(b.source));
}

function inferCommunity(query) {
  const normalized = normalizeText(query);
  return knownCommunities.find((community) =>
    [community.name, ...community.aliases].some((alias) => normalized.includes(normalizeText(alias))),
  );
}

function communityMatches(record, community) {
  const text = normalizeText(`${addressOf(record)} ${recordValues(record)["備註"] || ""}`);
  return community.keywords.some((keyword) => text.includes(normalizeText(keyword)));
}

function applyFilter() {
  const query = el("#queryInput").value.trim();
  const inferred = inferCommunity(query);
  state.activeCommunity = inferred || null;

  if (inferred) {
    state.filtered = state.records.filter((record) => communityMatches(record, inferred));
  } else {
    const terms = normalizeText(query)
      .split(/[,+，、]/)
      .map((term) => term.trim())
      .filter(Boolean);
    state.filtered = terms.length
      ? state.records.filter((record) => {
          const text = normalizeText(`${addressOf(record)} ${recordValues(record)["備註"] || ""}`);
          return terms.every((term) => text.includes(term));
        })
      : state.records.slice();
  }
  renderAll();
}

function setStatus(message) {
  el("#loadStatus").textContent = message;
}

async function loadJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  if (!path.endsWith(".gz")) return response.json();
  if (!("DecompressionStream" in window)) {
    throw new Error("此瀏覽器不支援 gzip shard 解壓縮");
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

async function loadIndex() {
  state.index = await loadJson(REGION_INDEX);
  populateCities();
  const baohong = knownCommunities[0];
  selectRegion(baohong.city, baohong.township);
  el("#queryInput").value = "高鐵湛";
  renderQuickList();
  setStatus(`索引已載入：${numberFormat.format(state.index.total_region_shards)} 個區域檔。`);
}

function sortedCities() {
  return [...state.index.cities].sort((a, b) => a.city_name.localeCompare(b.city_name, "zh-Hant"));
}

function populateCities() {
  const options = sortedCities()
    .map((city) => `<option value="${city.city_name}">${city.city_name} (${numberFormat.format(city.record_count)})</option>`)
    .join("");
  el("#citySelect").innerHTML = options;
}

function populateTowns(cityName) {
  const city = state.index.cities.find((item) => item.city_name === cityName);
  const towns = [...(city?.townships || [])].sort((a, b) => a.township.localeCompare(b.township, "zh-Hant"));
  el("#townSelect").innerHTML = towns
    .map((town) => `<option value="${town.township}">${town.township} (${numberFormat.format(town.record_count)})</option>`)
    .join("");
}

function selectRegion(cityName, township) {
  el("#citySelect").value = cityName;
  populateTowns(cityName);
  el("#townSelect").value = township;
  state.city = cityName;
  state.township = township;
}

function currentTownEntry() {
  const city = state.index.cities.find((item) => item.city_name === state.city);
  return city?.townships.find((town) => town.township === state.township);
}

async function loadSelectedRegion() {
  const entry = currentTownEntry();
  if (!entry) throw new Error("找不到區域資料");
  el("#loadButton").disabled = true;
  setStatus(`正在載入 ${state.city}${state.township}：${numberFormat.format(entry.record_count)} 筆...`);
  try {
    state.region = await loadJson(entry.shard);
    state.records = state.region.records || [];
    setStatus(`已載入 ${state.city}${state.township}，${numberFormat.format(state.records.length)} 筆。`);
    applyFilter();
  } finally {
    el("#loadButton").disabled = false;
  }
}

function renderQuickList() {
  el("#quickList").innerHTML = knownCommunities
    .map(
      (community) => `
        <button class="quick-chip" type="button" data-community="${community.name}">
          <strong>${community.name}</strong>
          <span>${community.city}${community.township} · ${community.hint}</span>
        </button>
      `,
    )
    .join("");
}

function renderHeader(mainRows) {
  const title = state.activeCommunity?.name || el("#queryInput").value.trim() || `${state.city}${state.township}`;
  const subtitle = state.activeCommunity
    ? `${state.activeCommunity.city}${state.activeCommunity.township} · ${state.activeCommunity.hint}`
    : `${state.city}${state.township} · ${numberFormat.format(mainRows.length)} 筆主檔交易`;
  el("#viewTitle").textContent = title;
  el("#viewSubtitle").textContent = subtitle;
  el("#dataPill").textContent = state.region
    ? `${state.region.region.city_name} / ${state.region.region.township}`
    : "尚未載入";
}

function repeatGroups(mainRows) {
  const groups = new Map();
  for (const row of mainRows) {
    const key = normalizeText(row.address);
    if (!key.includes("號")) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .filter((rows) => rows.length > 1)
    .map((rows) => rows.sort((a, b) => (a.date || "").localeCompare(b.date || "")))
    .sort((a, b) => b.length - a.length || (b.at(-1)?.totalPrice || 0) - (a.at(-1)?.totalPrice || 0));
}

function renderKpis(mainRows) {
  const prices = mainRows.map((row) => row.totalPrice);
  const units = mainRows.map((row) => row.unitPrice);
  const repeats = repeatGroups(mainRows);
  const latest = [...mainRows].reverse().find((row) => row.date);
  el("#kpiCount").textContent = numberFormat.format(mainRows.length);
  el("#kpiAvgPrice").textContent = formatWan(avg(prices));
  el("#kpiAvgUnit").textContent = formatUnit(avg(units));
  el("#kpiRepeat").textContent = numberFormat.format(repeats.length);
  el("#kpiHigh").textContent = formatWan(Math.max(0, ...prices));
  el("#kpiLatest").textContent = latest ? `${latest.date} · ${formatWan(latest.totalPrice)}` : "--";
}

function chartBase(canvas) {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, rect.width * ratio);
  canvas.height = 280 * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, 280);
  return { ctx, width: rect.width, height: 280, pad: 34 };
}

function drawEmpty(canvas, message) {
  const { ctx, width, height } = chartBase(canvas);
  ctx.fillStyle = "#73808c";
  ctx.font = "14px system-ui";
  ctx.fillText(message, 20, height / 2);
}

function drawLineChart(canvas, rows, valueKey, color) {
  const points = rows.filter((row) => row.date && row[valueKey] > 0);
  if (points.length < 2) return drawEmpty(canvas, "資料不足，無法繪製趨勢。");
  const { ctx, width, height, pad } = chartBase(canvas);
  const values = points.map((point) => point[valueKey]);
  const min = Math.min(...values) * 0.94;
  const max = Math.max(...values) * 1.04;
  const x = (index) => pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / Math.max(max - min, 1)) * (height - pad * 2);

  ctx.strokeStyle = "#d9e1e7";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const gy = pad + i * ((height - pad * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(width - pad, gy);
    ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const px = x(index);
    const py = y(point[valueKey]);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = color;
  points.forEach((point, index) => {
    ctx.beginPath();
    ctx.arc(x(index), y(point[valueKey]), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "#5d6b78";
  ctx.font = "12px system-ui";
  ctx.fillText(points[0].date, pad, height - 10);
  ctx.textAlign = "right";
  ctx.fillText(points.at(-1).date, width - pad, height - 10);
  ctx.textAlign = "left";
  ctx.fillText(valueKey === "totalPrice" ? formatWan(max) : formatUnit(max), pad, 18);
}

function drawBarChart(canvas, entries, color) {
  if (!entries.length) return drawEmpty(canvas, "沒有可繪製的資料。");
  const { ctx, width, height, pad } = chartBase(canvas);
  const max = Math.max(...entries.map((entry) => entry.value));
  const barGap = 6;
  const barWidth = Math.max(8, (width - pad * 2 - barGap * (entries.length - 1)) / entries.length);
  entries.forEach((entry, index) => {
    const x = pad + index * (barWidth + barGap);
    const h = (entry.value / Math.max(max, 1)) * (height - pad * 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, height - pad - h, barWidth, h);
    ctx.fillStyle = "#5d6b78";
    ctx.font = "11px system-ui";
    ctx.save();
    ctx.translate(x + barWidth / 2, height - 10);
    ctx.rotate(-Math.PI / 5);
    ctx.textAlign = "right";
    ctx.fillText(entry.label, 0, 0);
    ctx.restore();
  });
}

function renderCharts(mainRows) {
  drawLineChart(el("#priceChart"), mainRows, "totalPrice", "#236b8e");
  drawLineChart(el("#unitChart"), mainRows, "unitPrice", "#8c5b2f");

  const byYear = new Map();
  for (const row of mainRows) {
    const year = row.date ? row.date.slice(0, 4) : "未知";
    byYear.set(year, (byYear.get(year) || 0) + 1);
  }
  drawBarChart(
    el("#volumeChart"),
    [...byYear.entries()].sort().map(([label, value]) => ({ label, value })),
    "#2f7d61",
  );

  const byType = new Map();
  for (const row of mainRows) byType.set(row.target || "未知", (byType.get(row.target || "未知") || 0) + 1);
  drawBarChart(
    el("#mixChart"),
    [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: label.slice(0, 8), value })),
    "#b0792f",
  );

  const prices = mainRows.map((row) => row.totalPrice).filter(Boolean);
  const first = mainRows.find((row) => row.totalPrice);
  const last = [...mainRows].reverse().find((row) => row.totalPrice);
  const delta = first && last && first !== last ? ((last.totalPrice - first.totalPrice) / first.totalPrice) * 100 : 0;
  el("#priceTrendNote").textContent = prices.length ? `中位數 ${formatWan(median(prices))} · 首末 ${delta.toFixed(1)}%` : "--";
}

function renderRepeatSales(mainRows) {
  const groups = repeatGroups(mainRows).slice(0, 12);
  el("#repeatGrid").innerHTML = groups.length
    ? groups
        .map((rows) => {
          const first = rows[0];
          const last = rows.at(-1);
          const delta = first.totalPrice ? ((last.totalPrice - first.totalPrice) / first.totalPrice) * 100 : 0;
          return `
            <article class="repeat-card">
              <div>
                <h3>${first.address}</h3>
                <span>${rows.length} 次交易 · ${first.date || "--"} 到 ${last.date || "--"}</span>
              </div>
              <strong class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%</strong>
              <ol>
                ${rows
                  .map(
                    (row) => `
                      <li>
                        <span>${row.date || row.rawDate}</span>
                        <b>${formatWan(row.totalPrice)}</b>
                        <small>${row.source}</small>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>
            </article>
          `;
        })
        .join("")
    : '<p class="empty">目前結果沒有同一完整門牌重複轉手紀錄。</p>';
}

function renderTable() {
  const rows = displayRecords().slice(0, 500);
  el("#recordRows").innerHTML = rows
    .map((record) => {
      const main = parseMain(record);
      const values = recordValues(record);
      const isDetail = !isMainRecord(record);
      return `
        <tr class="${isDetail ? "detail-row" : ""}">
          <td>${main.date || main.rawDate || "--"}</td>
          <td>${main.address || values["土地位置"] || values["車位所在樓層"] || "--"}</td>
          <td>${isDetail ? record.table_kind : main.target}</td>
          <td>${formatWan(main.totalPrice || toNumber(values["車位價格"]))}</td>
          <td>${formatUnit(main.unitPrice)}</td>
          <td>${main.buildingArea ? main.buildingArea.toFixed(2) : toNumber(values["建物移轉面積平方公尺"]) || "--"}</td>
          <td>${values["屋齡"] || "--"}</td>
          <td>${record._source_id}</td>
        </tr>
      `;
    })
    .join("");
}

function renderManager(mainRows) {
  const latest = [...mainRows].filter((row) => row.date).slice(-6).reverse();
  const high = [...mainRows].sort((a, b) => b.totalPrice - a.totalPrice).slice(0, 6);
  const lowUnit = [...mainRows].filter((row) => row.unitPrice > 0).sort((a, b) => a.unitPrice - b.unitPrice).slice(0, 6);
  const sections = [
    ["最新成交", latest],
    ["高總價標的", high],
    ["低單價觀察", lowUnit],
  ];
  el("#summaryGrid").innerHTML = sections
    .map(
      ([title, rows]) => `
        <article class="summary-card">
          <h3>${title}</h3>
          <ul>
            ${rows
              .map(
                (row) => `
                  <li>
                    <span>${row.address}</span>
                    <b>${formatWan(row.totalPrice)}</b>
                    <small>${row.date || "--"} · ${formatUnit(row.unitPrice)} 元/m²</small>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </article>
      `,
    )
    .join("");
}

function renderAll() {
  const mainRows = buildMainRows();
  renderHeader(mainRows);
  renderKpis(mainRows);
  renderCharts(mainRows);
  renderRepeatSales(mainRows);
  renderTable();
  renderManager(mainRows);
}

function downloadFiltered() {
  const payload = {
    generated_at: new Date().toISOString(),
    query: el("#queryInput").value,
    region: state.region?.region,
    records: state.filtered,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `plvr-filtered-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  el("#citySelect").addEventListener("change", (event) => {
    state.city = event.target.value;
    populateTowns(state.city);
    state.township = el("#townSelect").value;
  });
  el("#townSelect").addEventListener("change", (event) => {
    state.township = event.target.value;
  });
  el("#loadButton").addEventListener("click", loadSelectedRegion);
  el("#queryInput").addEventListener("input", () => {
    const inferred = inferCommunity(el("#queryInput").value);
    if (inferred && (state.city !== inferred.city || state.township !== inferred.township)) {
      selectRegion(inferred.city, inferred.township);
    }
    if (state.records.length) applyFilter();
  });
  el("#quickList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-community]");
    if (!button) return;
    const community = knownCommunities.find((item) => item.name === button.dataset.community);
    selectRegion(community.city, community.township);
    el("#queryInput").value = community.aliases.at(-1);
    loadSelectedRegion();
  });
  el("#toggleDetailRows").addEventListener("click", () => {
    state.includeDetails = !state.includeDetails;
    el("#toggleDetailRows").textContent = state.includeDetails ? "只顯示主檔交易" : "顯示土地/建物/車位明細";
    renderTable();
  });
  el("#downloadFiltered").addEventListener("click", downloadFiltered);
  window.addEventListener("resize", () => {
    if (state.filtered.length) renderCharts(buildMainRows());
  });
}

async function init() {
  bindEvents();
  try {
    await loadIndex();
    await loadSelectedRegion();
  } catch (error) {
    console.error(error);
    setStatus(`資料載入失敗：${error.message}`);
  }
}

init();
