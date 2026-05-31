const REGION_INDEX = "data/plvr/web-index.json";
const COMMUNITY_INDEX = "data/plvr/community-index.json";
const FILTER_KEY = "houseEx.filters";
const M2_PER_PING = 3.305785;

const knownCommunities = [
  {
    name: "寶鴻高鐵湛",
    aliases: ["寶鴻", "高鐵湛", "寶鴻高鐵湛"],
    city: "彰化縣",
    township: "社頭鄉",
    keywords: ["高鐵北二路"],
    hint: "高鐵北二路 162-198 號一帶",
    center: [23.8967, 120.5898],
  },
];

const cityCenters = {
  臺北市: [25.0375, 121.5637],
  新北市: [25.0169, 121.4628],
  桃園市: [24.9937, 121.301],
  臺中市: [24.1477, 120.6736],
  臺南市: [22.9999, 120.227],
  高雄市: [22.6273, 120.3014],
  新竹縣: [24.8387, 121.0177],
  新竹市: [24.8138, 120.9675],
  苗栗縣: [24.5602, 120.8214],
  彰化縣: [24.0753, 120.5443],
  南投縣: [23.9609, 120.9719],
  雲林縣: [23.7092, 120.4313],
  嘉義縣: [23.4518, 120.2555],
  嘉義市: [23.4801, 120.4491],
  屏東縣: [22.5519, 120.5487],
  宜蘭縣: [24.7021, 121.7378],
  花蓮縣: [23.9872, 121.6015],
  臺東縣: [22.7972, 121.0714],
  澎湖縣: [23.5711, 119.5794],
  金門縣: [24.4321, 118.3171],
  連江縣: [26.1602, 119.9517],
};

const townCenters = {
  "彰化縣|社頭鄉": [23.8967, 120.5898],
};

const state = {
  index: null,
  communityIndex: null,
  cityCommunityData: null,
  cityCommunities: [],
  allCommunities: [],
  allCommunitiesLoaded: false,
  sqliteReady: false,
  sqliteMetadata: null,
  sqliteCity: "",
  city: "",
  township: "",
  region: null,
  records: [],
  rows: [],
  filteredRows: [],
  tableTotal: 0,
  lastQueryMeta: null,
  includeDetails: false,
  activeCommunity: null,
  sort: { key: "addressBlock", dir: "asc" },
  compactMode: true,
  repeatSort: "gain",
  selectedRowId: "",
  selectedCommunity: null,
  annotationLimit: 13,
  map: null,
  markerLayer: null,
  chartHits: new Map(),
  visibleColumns: ["date", "address", "buildingNo", "target", "totalPrice", "unitPrice", "buildingPing", "age", "source"],
};

const columnDefs = [
  ["date", "日期"],
  ["address", "門牌 / 位置"],
  ["buildingNo", "棟及號"],
  ["target", "標的"],
  ["totalPrice", "總價"],
  ["unitPrice", "單價/坪"],
  ["buildingPing", "建坪"],
  ["landPing", "地坪"],
  ["age", "屋齡"],
  ["hasParking", "車位"],
  ["source", "來源"],
  ["floor", "樓層"],
  ["buildingType", "型態"],
];

const numberFormat = new Intl.NumberFormat("zh-TW");
const moneyFormat = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const pingFormat = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const el = (selector) => document.querySelector(selector);
const els = (selector) => [...document.querySelectorAll(selector)];
const debounce = (fn, wait = 180) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

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
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/巿/g, "市")
    .replace(/臺/g, "台")
    .replace(/\s+/g, "");
}

function formatWan(value) {
  if (!value) return "--";
  return `${moneyFormat.format(value / 10000)}萬`;
}

function formatUnit(value) {
  if (!value) return "--";
  return moneyFormat.format(value);
}

function m2ToPing(value) {
  return value ? value / M2_PER_PING : 0;
}

function formatPing(value) {
  if (!value) return "--";
  return pingFormat.format(value);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
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

function daysBetween(a, b) {
  const start = Date.parse(a);
  const end = Date.parse(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function annualReturn(firstPrice, lastPrice, days) {
  if (!firstPrice || !lastPrice || !days) return 0;
  return (Math.pow(lastPrice / firstPrice, 365 / days) - 1) * 100;
}

function recordValues(record) {
  return record.values || {};
}

function addressOf(record) {
  const values = recordValues(record);
  return values["土地位置建物門牌"] || values["土地位置"] || values["車位所在樓層"] || "";
}

function transactionId(record) {
  return recordValues(record)["編號"] || "";
}

function isMainRecord(record) {
  return record.table_kind === "主檔";
}

function sourceRank(source) {
  if (source === "current") return 99999999;
  const match = String(source).match(/^(\d{3})S([1-4])$/);
  if (match) return Number(match[1]) * 10 + Number(match[2]);
  return Number(String(source).replace(/\D/g, "")) || 0;
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rowPosition(row) {
  const exact = knownCommunities.find((community) =>
    community.city === row.cityName &&
    community.township === row.township &&
    community.keywords.some((keyword) => normalizeText(row.address).includes(normalizeText(keyword))),
  );
  const center = exact?.center || townCenters[`${row.cityName}|${row.township}`] || cityCenters[row.cityName] || [23.7, 121];
  const hash = hashText(row.address || row.id);
  const angle = ((hash % 360) * Math.PI) / 180;
  const radius = exact ? 0.0015 + ((hash >>> 8) % 18) / 10000 : 0.01 + ((hash >>> 8) % 70) / 10000;
  return [center[0] + Math.sin(angle) * radius, center[1] + Math.cos(angle) * radius];
}

function parseRecord(record, index) {
  const values = recordValues(record);
  const rawDate = values["交易年月日"] || "";
  const totalPrice = toNumber(values["總價元"] || values["車位總價元"] || values["車位價格"]);
  const unitPriceM2 = toNumber(values["單價元平方公尺"]);
  const unitPrice = unitPriceM2 ? unitPriceM2 * M2_PER_PING : 0;
  const buildingArea = toNumber(values["建物移轉總面積平方公尺"] || values["建物移轉面積平方公尺"]);
  const landArea = toNumber(values["土地移轉總面積平方公尺"]);
  const buildingNo = values["棟及號"] || "";
  const builtDate = values["建築完成年月"] || "";
  const date = twDateToIso(rawDate);
  const builtIso = twDateToIso(builtDate);
  const age = date && builtIso ? Math.max(0, (Date.parse(date) - Date.parse(builtIso)) / 31557600000) : 0;
  const address = addressOf(record);
  const id = transactionId(record) || `${record._source_id}-${record._file}-${index}-${rawDate}-${totalPrice}-${hashText(address)}`;
  const row = {
    record,
    id,
    index,
    isMain: isMainRecord(record),
    date,
    rawDate,
    month: date ? date.slice(0, 7) : "未知",
    address,
    buildingNo,
    addressBlock: normalizeText(`${address} ${buildingNo}`),
    road: extractRoad(address),
    cityName: record.city_name || state.region?.region?.city_name || state.city,
    township: values["鄉鎮市區"] || state.township,
    target: values["交易標的"] || record.transaction_type || "",
    totalPrice,
    unitPrice,
    unitPriceM2,
    buildingArea,
    buildingPing: m2ToPing(buildingArea),
    landArea,
    landPing: m2ToPing(landArea),
    age,
    ageLabel: age ? `${age.toFixed(1)} 年` : values["屋齡"] || "--",
    hasParking: /車位/.test(`${values["交易筆棟數"] || ""}${values["車位類別"] || ""}${record.table_kind || ""}`),
    source: record._source_id || "",
    sourceLabel: record._source_label || record._source_id || "",
    file: record._file || "",
    floor: values["移轉層次"] || "",
    totalFloor: values["總樓層數"] || "",
    buildingType: values["建物型態"] || "",
    note: values["備註"] || "",
  };
  row.position = rowPosition(row);
  row.searchText = buildSearchText(row);
  return row;
}

function rowFromSql(tx, index = 0) {
  const record = tx.raw_json ? JSON.parse(tx.raw_json) : { table_kind: "主檔", values: {} };
  const row = {
    record,
    id: tx.id,
    index,
    isMain: true,
    date: tx.transaction_date || "",
    rawDate: tx.transaction_date || "",
    month: tx.transaction_date ? tx.transaction_date.slice(0, 7) : "未知",
    address: tx.full_address || "",
    buildingNo: tx.building_no || "",
    addressBlock: normalizeText(`${tx.full_address || ""} ${tx.building_no || ""}`),
    road: tx.road || extractRoad(tx.full_address || ""),
    cityName: tx.city || "",
    township: tx.district || "",
    target: tx.transaction_target || "",
    totalPrice: Number(tx.total_price) || 0,
    unitPrice: Number(tx.unit_price_ping) || 0,
    unitPriceM2: Number(tx.unit_price_m2) || 0,
    buildingArea: Number(tx.building_area_m2) || 0,
    buildingPing: Number(tx.building_area_ping) || 0,
    landArea: Number(tx.land_area_m2) || 0,
    landPing: Number(tx.land_area_ping) || 0,
    age: Number(tx.building_age) || 0,
    ageLabel: tx.building_age ? `${Number(tx.building_age).toFixed(1)} 年` : "--",
    hasParking: Boolean(tx.has_parking),
    source: tx.source_batch || "",
    sourceLabel: tx.source_batch || "",
    file: "",
    floor: tx.floor || "",
    totalFloor: tx.total_floor || "",
    buildingType: tx.property_type || "",
    note: "",
    position: [Number(tx.lat) || 23.7, Number(tx.lng) || 121],
  };
  row.searchText = buildSearchText(row);
  return row;
}

function extractRoad(address) {
  const text = String(address || "");
  const match = text.match(/([\u4e00-\u9fa5A-Za-z0-9０-９]+(?:路|街|大道|巷|段))/);
  return match ? match[1] : "";
}

function buildSearchText(row) {
  const raw = Object.entries(recordValues(row.record))
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  return normalizeText([
    row.cityName,
    row.township,
    row.address,
    row.buildingNo,
    row.addressBlock,
    row.road,
    row.target,
    row.date,
    row.rawDate,
    row.totalPrice,
    formatWan(row.totalPrice),
    row.unitPrice,
    row.buildingPing,
    row.landPing,
    row.ageLabel,
    row.hasParking ? "有車位 車位" : "無車位",
    row.source,
    row.sourceLabel,
    row.file,
    row.floor,
    row.buildingType,
    row.note,
    raw,
  ].join(" "));
}

function displayRows() {
  const base = state.includeDetails ? state.filteredRows : state.filteredRows.filter((row) => row.isMain);
  return sortRows(base);
}

function mainRows() {
  const seen = new Map();
  for (const row of state.filteredRows.filter((item) => item.isMain && item.address)) {
    const key = transactionId(row.record) || `${normalizeText(row.address)}-${row.rawDate}-${row.totalPrice}-${row.unitPrice}`;
    const current = seen.get(key);
    if (!current || sourceRank(row.source) > sourceRank(current.source)) seen.set(key, row);
  }
  return sortRows([...seen.values()], { key: "date", dir: "asc" });
}

function sortRows(rows, sort = state.sort) {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key] ?? "";
    const bv = b[sort.key] ?? "";
    if (typeof av === "number" || typeof bv === "number") return ((av || 0) - (bv || 0)) * dir;
    return String(av).localeCompare(String(bv), "zh-Hant", { numeric: true }) * dir;
  });
}

function inferCommunity(query) {
  const normalized = normalizeText(query);
  return knownCommunities.find((community) =>
    [community.name, ...community.aliases].some((alias) => normalized.includes(normalizeText(alias))),
  );
}

function communityMatches(row, community) {
  const text = normalizeText(`${row.address} ${row.note}`);
  return community.keywords.some((keyword) => text.includes(normalizeText(keyword)));
}

function cityCommunityEntry(cityName = state.city) {
  return state.communityIndex?.cities?.find((item) => item.city_name === cityName);
}

async function loadCommunityIndex() {
  try {
    state.communityIndex = await loadJson(COMMUNITY_INDEX);
  } catch (error) {
    console.warn("community index unavailable", error);
    state.communityIndex = { cities: [] };
  }
}

async function loadCityCommunities(cityName = state.city) {
  const entry = cityCommunityEntry(cityName);
  if (!entry) {
    el("#communityStatus").textContent = "沒有社區索引";
    state.cityCommunities = [];
    renderCommunityList();
    return;
  }
  el("#communityStatus").textContent = `正在載入 ${cityName}...`;
  const payload = await loadJson(entry.shard);
  state.cityCommunityData = payload;
  state.cityCommunities = payload.communities || [];
  el("#communityStatus").textContent = `${numberFormat.format(state.cityCommunities.length)} 個社區`;
  renderCommunityList();
  renderCommunityTable();
}

async function loadAllCommunities() {
  if (state.allCommunitiesLoaded) return state.allCommunities;
  const entries = state.communityIndex?.cities || [];
  const payloads = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await loadJson(entry.shard);
      } catch (error) {
        console.warn("community shard unavailable", entry.city_name, error);
        return { communities: [] };
      }
    }),
  );
  state.allCommunities = payloads.flatMap((payload) => payload.communities || []);
  state.allCommunitiesLoaded = true;
  return state.allCommunities;
}

function renderCommunityList() {
  const query = normalizeText(el("#communitySearch")?.value || el("#queryInput").value || "");
  const items = state.cityCommunities
    .filter((item) => !query || normalizeText(item.search_text || item.name).includes(query))
    .slice(0, 80);
  el("#communityList").innerHTML = items.length
    ? items
        .map((item) => {
          const stats = item.stats || {};
          return `
            <button type="button" data-community-name="${escapeHtml(item.name)}">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.township)} · ${numberFormat.format(stats.count || 0)} 筆 · 中位 ${formatWan(stats.median_total_price || 0)}</span>
            </button>
          `;
        })
        .join("")
    : '<p class="empty">沒有符合的社區。</p>';
}

function communitySearchNeedle() {
  return normalizeText(el("#communityTableSearch")?.value || el("#communitySearch")?.value || el("#queryInput").value || "");
}

function filteredCityCommunities() {
  const needle = communitySearchNeedle();
  return state.cityCommunities
    .filter((item) => !needle || normalizeText(item.search_text || item.name).includes(needle))
    .sort((a, b) => (b.stats?.count || 0) - (a.stats?.count || 0) || String(a.name).localeCompare(String(b.name), "zh-Hant"));
}

function primaryTarget(community) {
  const targets = Object.entries(community.targets || {});
  if (!targets.length) return "--";
  const [target, count] = targets.sort((a, b) => b[1] - a[1])[0];
  return `${target} ${numberFormat.format(count)}`;
}

function renderCommunityTable() {
  const rows = filteredCityCommunities();
  const shown = rows.slice(0, 800);
  const tbody = el("#communityRows");
  if (!tbody) return;
  el("#communityTableMeta").textContent = `${state.city || "--"} · 顯示 ${numberFormat.format(shown.length)} / ${numberFormat.format(rows.length)} 個社區`;
  tbody.innerHTML = shown
    .map((community) => {
      const stats = community.stats || {};
      return `
        <tr data-community-name="${escapeHtml(community.name)}">
          <td><strong>${escapeHtml(community.name)}</strong></td>
          <td>${escapeHtml(community.township || "--")}</td>
          <td>${numberFormat.format(stats.count || 0)}</td>
          <td>${formatWan(stats.median_total_price || 0)}</td>
          <td>${formatUnit((stats.median_unit_price || 0) * M2_PER_PING)}</td>
          <td>${formatWan(stats.max_total_price || 0)}</td>
          <td>${escapeHtml(stats.latest_date || "--")}</td>
          <td>${escapeHtml(primaryTarget(community))}</td>
        </tr>
      `;
    })
    .join("");
}

function selectIndexedCommunity(name) {
  const item = state.cityCommunities.find((community) => community.name === name);
  if (!item) return;
  navigateToCommunity(item);
}

function navigateToCommunity(item) {
  state.selectedCommunity = item;
  selectRegion(item.city, item.township);
  el("#queryInput").value = item.name;
  loadSelectedRegion();
}

async function resolveCommunitySearch(query) {
  const clean = normalizeText(query);
  if (!clean) return null;
  if (state.sqliteReady) {
    try {
      const result = await queryService.searchCommunities({ keyword: query, limit: 5 });
      setQueryMeta(result.meta);
      const matches = result.rows || [];
      const exact = matches.find((item) => normalizeText(item.community_name) === clean);
      const item = exact || matches[0];
      if (item) {
        return {
          name: item.community_name,
          city: item.city,
          township: item.district,
          stats: {
            count: item.transaction_count,
            median_total_price: item.median_total_price,
            median_unit_price: item.median_unit_price_ping / M2_PER_PING,
          },
          shard: item.shard,
          search_text: item.search_text,
        };
      }
    } catch (error) {
      console.warn("SQLite community search failed", error);
    }
  }
  const local = state.cityCommunities.find((item) => normalizeText(item.name) === clean);
  if (local) return local;
  const all = await loadAllCommunities();
  const exact = all.filter((item) => normalizeText(item.name) === clean);
  if (exact.length) return exact.sort((a, b) => (b.stats?.count || 0) - (a.stats?.count || 0))[0];
  return null;
}

async function commitSearch() {
  const query = el("#queryInput").value.trim();
  const community = await resolveCommunitySearch(query);
  if (community && (state.city !== community.city || state.township !== community.township)) {
    navigateToCommunity(community);
    return;
  }
  if (community) {
    state.selectedCommunity = community;
    el("#queryInput").value = community.name;
  }
  applyFilter({ commitSearch: true });
}

function suggestionSources() {
  const rows = state.rows.length ? state.rows : [];
  const repeats = state.rows.length ? repeatGroups(mainRows()) : [];
  const items = [];
  for (const community of knownCommunities) {
    items.push({ label: community.name, meta: `${community.city}${community.township}`, query: community.name, rank: 100 });
    for (const alias of community.aliases) items.push({ label: alias, meta: community.name, query: alias, rank: 95 });
    for (const keyword of community.keywords) items.push({ label: keyword, meta: community.name, query: keyword, rank: 90 });
  }
  for (const community of state.cityCommunities.slice(0, 500)) {
    const stats = community.stats || {};
    items.push({
      label: community.name,
      meta: `${community.city}${community.township} · ${numberFormat.format(stats.count || 0)} 筆`,
      query: community.name,
      rank: 92,
    });
  }
  if (state.city) items.push({ label: state.city, meta: "縣市", query: state.city, rank: 80 });
  if (state.township) items.push({ label: state.township, meta: "鄉鎮市區", query: state.township, rank: 80 });

  const pushUniqueRows = (key, meta, rank, limit = 80) => {
    const seen = new Set();
    for (const row of rows) {
      const value = typeof key === "function" ? key(row) : row[key];
      if (!value || seen.has(value)) continue;
      seen.add(value);
      items.push({ label: String(value), meta, query: String(value), rank });
      if (seen.size >= limit) break;
    }
  };

  pushUniqueRows("road", "路段", 76);
  pushUniqueRows("address", "門牌", 74, 160);
  pushUniqueRows("date", "交易日期", 68);
  pushUniqueRows("source", "來源批次", 66);
  pushUniqueRows("target", "交易標的", 64);
  pushUniqueRows((row) => (row.hasParking ? "有車位" : ""), "車位", 62, 1);
  pushUniqueRows((row) => (row.totalPrice ? formatWan(row.totalPrice) : ""), "總價", 58);
  pushUniqueRows("buildingNo", "棟及號", 57);
  pushUniqueRows((row) => (row.unitPrice ? `${formatUnit(row.unitPrice)} 元/坪` : ""), "單價", 56);
  pushUniqueRows((row) => (row.buildingPing ? `${formatPing(row.buildingPing)} 坪` : ""), "建坪", 54);

  for (const group of repeats.slice(0, 40)) {
    items.push({
      label: `${formatPct(group.pct)} ${group.first.address}`,
      meta: "重複轉手",
      query: group.first.address,
      rank: 88,
    });
  }
  return items;
}

function renderSuggestions() {
  const box = el("#suggestList");
  const query = el("#queryInput").value.trim();
  const needle = normalizeText(query);
  if (!needle) {
    box.classList.remove("open");
    box.innerHTML = "";
    return;
  }
  const seen = new Set();
  const suggestions = suggestionSources()
    .filter((item) => {
      const hay = normalizeText(`${item.label} ${item.meta}`);
      return hay.includes(needle) || needle.includes(normalizeText(item.label));
    })
    .sort((a, b) => b.rank - a.rank || String(a.label).length - String(b.label).length)
    .filter((item) => {
      const key = normalizeText(item.query);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  box.innerHTML = suggestions
    .map(
      (item) => `
        <button type="button" data-suggest="${escapeHtml(item.query)}">
          <span>${escapeHtml(item.label)}</span>
          <small>${escapeHtml(item.meta)}</small>
        </button>
      `,
    )
    .join("");
  box.classList.toggle("open", suggestions.length > 0);
}

function saveFilters() {
  const payload = {
    city: state.city,
    township: state.township,
    compactMode: state.compactMode,
    annotationLimit: state.annotationLimit,
    dark: document.documentElement.classList.contains("dark"),
  };
  localStorage.setItem(FILTER_KEY, JSON.stringify(payload));
}

function readSavedFilters() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
  } catch {
    return {};
  }
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.city) params.set("city", state.city);
  if (state.township) params.set("town", state.township);
  const query = el("#queryInput").value.trim();
  if (query) params.set("q", query);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  return {
    city: params.get("city"),
    township: params.get("town"),
    query: params.get("q"),
  };
}

function setStatus(message) {
  el("#loadStatus").textContent = message;
}

function setQueryMeta(meta) {
  if (!meta) return;
  state.lastQueryMeta = meta;
  const badge = el("#perfBadge");
  if (!badge) return;
  const cache = meta.cacheHit ? " · cache" : "";
  badge.textContent = `SQLite · ${meta.db || "index"} · ${numberFormat.format(meta.rowCount || 0)} rows · ${meta.elapsedMs}ms${cache}`;
}

async function loadJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  if (!path.endsWith(".gz")) return response.json();
  if (!("DecompressionStream" in window)) throw new Error("此瀏覽器不支援 gzip shard 解壓縮");
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function loadIndex() {
  if (window.queryService) {
    try {
      const result = await queryService.init();
      state.sqliteMetadata = result.metadata;
      setQueryMeta(result.meta);
      state.sqliteReady = true;
    } catch (error) {
      console.warn("SQLite worker unavailable, using JSON shards", error);
      state.sqliteReady = false;
    }
  }
  state.index = await loadJson(REGION_INDEX);
  await loadCommunityIndex();
  populateCities();
  const urlState = applyUrlState();
  const saved = readSavedFilters();
  if (saved.dark) document.documentElement.classList.add("dark");
  const savedLimit = Number(saved.annotationLimit);
  state.annotationLimit = Number.isFinite(savedLimit) ? Math.max(1, Math.min(9999, Math.round(savedLimit))) : 13;
  el("#annotationLimit").value = String(state.annotationLimit);
  el("#annotationLimitValue").textContent = numberFormat.format(state.annotationLimit);
  const fallback = knownCommunities[0];
  selectRegion(urlState.city || saved.city || fallback.city, urlState.township || saved.township || fallback.township);
  el("#queryInput").value = urlState.query || "高鐵湛";
  loadCityCommunities(state.city).catch((error) => {
    console.warn(error);
    el("#communityStatus").textContent = "社區索引載入失敗";
  });
  setStatus(`索引已載入：${numberFormat.format(state.index.total_region_shards)} 個區域檔。`);
}

function sortedCities() {
  return [...state.index.cities].sort((a, b) => a.city_name.localeCompare(b.city_name, "zh-Hant"));
}

function populateCities() {
  el("#citySelect").innerHTML = sortedCities()
    .map((city) => `<option value="${escapeHtml(city.city_name)}">${escapeHtml(city.city_name)} (${numberFormat.format(city.record_count)})</option>`)
    .join("");
}

function populateTowns(cityName) {
  const city = state.index.cities.find((item) => item.city_name === cityName);
  const towns = [...(city?.townships || [])].sort((a, b) => a.township.localeCompare(b.township, "zh-Hant"));
  el("#townSelect").innerHTML = towns
    .map((town) => `<option value="${escapeHtml(town.township)}">${escapeHtml(town.township)} (${numberFormat.format(town.record_count)})</option>`)
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
  document.body.classList.add("loading");
  setStatus(`正在載入 ${state.city}${state.township}：${numberFormat.format(entry.record_count)} 筆...`);
  try {
    if (state.sqliteReady && state.sqliteMetadata?.cities?.[state.city]) {
      const cityLoad = await queryService.loadCity({ city: state.city });
      setQueryMeta(cityLoad.meta);
      state.sqliteCity = state.city;
      const query = el("#queryInput").value.trim();
      const txResult = await queryService.queryTransactions({
        city: state.city,
        district: state.township,
        communityName: state.selectedCommunity?.city === state.city && state.selectedCommunity?.township === state.township ? state.selectedCommunity.name : "",
        keyword: state.selectedCommunity ? "" : query,
        sortBy: "full_address",
        sortDir: "ASC",
        limit: 1000,
        offset: 0,
      });
      setQueryMeta(txResult.meta);
      const txRows = txResult.rows || [];
      state.tableTotal = txResult.total || txRows.length;
      state.rows = txRows.map(rowFromSql);
      state.records = state.rows.map((row) => row.record);
      state.region = { region: { city_name: state.city, township: state.township }, records: state.records, source: "sqlite" };
      setStatus(`已用 SQLite 載入 ${state.city}${state.township}，${numberFormat.format(state.rows.length)} / ${numberFormat.format(state.tableTotal)} 筆。`);
      applyFilter({ commitSearch: true, skipClientFilter: true });
      return;
    }
    state.region = await loadJson(entry.shard);
    state.records = state.region.records || [];
    state.rows = state.records.map(parseRecord);
    state.tableTotal = state.rows.length;
    setStatus(`已載入 ${state.city}${state.township}，${numberFormat.format(state.records.length)} 筆。`);
    applyFilter({ commitSearch: true });
  } finally {
    document.body.classList.remove("loading");
    el("#loadButton").disabled = false;
  }
}

function applyFilter({ commitSearch = false, skipClientFilter = false } = {}) {
  const query = el("#queryInput").value.trim();
  const inferred = inferCommunity(query);
  state.activeCommunity = inferred || state.selectedCommunity || null;
  const terms = normalizeText(query)
    .split(/[,+，、]/)
    .map((term) => term.trim())
    .filter(Boolean);

  state.filteredRows = skipClientFilter
    ? state.rows.slice()
    : state.rows.filter((row) => {
        if (inferred && !communityMatches(row, inferred)) return false;
        if (!inferred && terms.length && !terms.every((term) => row.searchText.includes(term))) return false;
        return true;
      });

  saveFilters();
  syncUrl();
  renderAll();
}

function renderHeader(rows) {
  const query = el("#queryInput").value.trim();
  const title = state.activeCommunity?.name || query || `${state.city}${state.township}`;
  const subtitle = state.activeCommunity
    ? `${state.activeCommunity.city}${state.activeCommunity.township} · ${state.activeCommunity.hint}`
    : `${state.city}${state.township} · ${numberFormat.format(rows.length)} 筆主檔交易`;
  el("#viewTitle").textContent = title;
  el("#viewSubtitle").textContent = subtitle;
  el("#dataPill").textContent = state.region ? `${state.region.region.city_name} / ${state.region.region.township}` : "尚未載入";
}

function repeatGroups(rows = mainRows()) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeText(row.address);
    if (!key.includes("號")) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .filter((items) => items.length > 1)
    .map((items) => {
      const rowsSorted = sortRows(items, { key: "date", dir: "asc" });
      const first = rowsSorted[0];
      const last = rowsSorted.at(-1);
      const days = daysBetween(first.date, last.date);
      const delta = last.totalPrice - first.totalPrice;
      const pct = first.totalPrice ? (delta / first.totalPrice) * 100 : 0;
      const unitDelta = last.unitPrice - first.unitPrice;
      return { rows: rowsSorted, first, last, days, delta, pct, unitDelta, annual: annualReturn(first.totalPrice, last.totalPrice, days) };
    });
}

function renderKpis(rows) {
  const prices = rows.map((row) => row.totalPrice);
  const units = rows.map((row) => row.unitPrice);
  const repeats = repeatGroups(rows);
  const latest = sortRows(rows.filter((row) => row.date), { key: "date", dir: "desc" })[0];
  el("#kpiCount").textContent = numberFormat.format(rows.length);
  el("#kpiAvgPrice").textContent = formatWan(avg(prices));
  el("#kpiAvgUnit").textContent = formatUnit(avg(units));
  el("#kpiRepeat").textContent = numberFormat.format(repeats.length);
  el("#kpiHigh").textContent = formatWan(Math.max(0, ...prices));
  el("#kpiLatest").textContent = latest ? `${latest.date} · ${formatWan(latest.totalPrice)}` : "--";
}

function initMap() {
  if (state.map || !window.L) return;
  state.map = L.map("map", { zoomControl: false }).setView([23.8967, 120.5898], 15);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    crossOrigin: true,
  }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
  state.map.on("zoomend", () => renderMap(mainRows()));
}

function markerColor(unit, min, max) {
  if (!unit) return "#6b7280";
  const t = Math.max(0, Math.min(1, (unit - min) / Math.max(max - min, 1)));
  if (t > 0.72) return "#b14d45";
  if (t > 0.44) return "#b9792f";
  return "#176f72";
}

function renderMap(rows) {
  initMap();
  if (!state.map) return;
  state.markerLayer.clearLayers();
  const limit = Math.max(1, Math.min(9999, Number(state.annotationLimit) || 13));
  const sortedForMap = sortRows(rows, { key: "date", dir: "desc" });
  const selected = state.selectedRowId ? sortedForMap.find((row) => row.id === state.selectedRowId) : null;
  const sample = selected
    ? [selected, ...sortedForMap.filter((row) => row.id !== state.selectedRowId).slice(0, Math.max(0, limit - 1))]
    : sortedForMap.slice(0, limit);
  if (!sample.length) return;
  const units = sample.map((row) => row.unitPrice).filter(Boolean);
  const minUnit = Math.min(...units, 0);
  const maxUnit = Math.max(...units, 1);
  const zoom = state.map.getZoom();
  const points = zoom < 15 ? clusterRows(sample) : sample.map((row) => ({ rows: [row], position: row.position }));

  for (const point of points) {
    const rowsInPoint = point.rows;
    const main = rowsInPoint.at(-1);
    const count = rowsInPoint.length;
    const color = markerColor(avg(rowsInPoint.map((row) => row.unitPrice)), minUnit, maxUnit);
    const radius = Math.min(26, 7 + Math.sqrt(count) * 2 + Math.log10(Math.max(main.totalPrice, 1)) / 2);
    const marker = L.circleMarker(point.position, {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.72,
      weight: state.selectedRowId && rowsInPoint.some((row) => row.id === state.selectedRowId) ? 4 : 1.5,
      className: "price-marker",
    }).addTo(state.markerLayer);
    const medianUnit = median(rowsInPoint.map((row) => row.unitPrice));
    const label = count > 1
      ? `${count}筆<br>${formatUnit(medianUnit)}`
      : `${formatWan(main.totalPrice)}<br>${formatUnit(main.unitPrice)}`;
    const labelMarker = L.marker(point.position, {
      interactive: true,
      icon: L.divIcon({
        className: "map-data-label",
        html: `<span>${label}</span>`,
        iconSize: [72, 34],
        iconAnchor: [36, -4],
      }),
    }).addTo(state.markerLayer);
    labelMarker.on("click", () => {
      if (count > 1) openDrawer("cluster", rowsInPoint);
      else selectRow(main.id, { fly: false, open: true });
    });
    marker.bindTooltip(`${escapeHtml(main.address || state.township)}<br>${count} 筆 · 中位單價 ${formatUnit(medianUnit)} · 均價 ${formatWan(avg(rowsInPoint.map((row) => row.totalPrice)))}`);
    marker.on("click", () => {
      if (count > 1 && zoom < 15) {
        openDrawer("cluster", rowsInPoint);
        state.map.flyTo(point.position, Math.min(17, zoom + 2));
      } else {
        selectRow(main.id, { fly: false, open: true });
      }
    });
  }

  const bounds = L.latLngBounds(sample.map((row) => row.position));
  if (bounds.isValid() && !state.mapTouched) {
    state.map.fitBounds(bounds.pad(0.25), { maxZoom: state.activeCommunity ? 16 : 14 });
    state.mapTouched = true;
  }
  el("#annotationLimitValue").textContent = numberFormat.format(limit);
  el("#legend").textContent = `${numberFormat.format(sample.length)} / ${numberFormat.format(rows.length)} 筆`;
}

function clusterRows(rows) {
  const precision = state.map.getZoom() < 13 ? 0.018 : 0.007;
  const groups = new Map();
  for (const row of rows) {
    const key = `${Math.round(row.position[0] / precision)}:${Math.round(row.position[1] / precision)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((items) => ({
    rows: items,
    position: [avg(items.map((row) => row.position[0])), avg(items.map((row) => row.position[1]))],
  }));
}

function chartBase(canvas) {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, rect.width * ratio);
  canvas.height = 280 * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, 280);
  state.chartHits.set(canvas.id, []);
  return { ctx, width: rect.width, height: 280, pad: 34 };
}

function drawEmpty(canvas, message) {
  const { ctx, width, height } = chartBase(canvas);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
  ctx.font = "14px system-ui";
  ctx.fillText(message, 20, height / 2);
}

function drawLineChart(canvas, rows, valueKey, color, noteFormatter = null) {
  const points = rows.filter((row) => row.date && row[valueKey] > 0);
  if (points.length < 2) return drawEmpty(canvas, "資料不足，無法繪製趨勢。");
  const { ctx, width, height, pad } = chartBase(canvas);
  const values = points.map((point) => point[valueKey]);
  const min = Math.min(...values) * 0.94;
  const max = Math.max(...values) * 1.04;
  const x = (index) => pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / Math.max(max - min, 1)) * (height - pad * 2);

  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--line");
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
  const hits = [];
  points.forEach((point, index) => {
    const px = x(index);
    const py = y(point[valueKey]);
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    hits.push({ x: px, y: py, radius: 12, row: point });
  });
  state.chartHits.set(canvas.id, hits);

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
  ctx.font = "12px system-ui";
  ctx.fillText(points[0].date, pad, height - 10);
  ctx.textAlign = "right";
  ctx.fillText(points.at(-1).date, width - pad, height - 10);
  ctx.textAlign = "left";
  ctx.fillText(noteFormatter ? noteFormatter(max) : formatWan(max), pad, 18);
}

function drawBarChart(canvas, entries, color) {
  if (!entries.length) return drawEmpty(canvas, "沒有可繪製的資料。");
  const { ctx, width, height, pad } = chartBase(canvas);
  const max = Math.max(...entries.map((entry) => entry.value));
  const barGap = 6;
  const barWidth = Math.max(8, (width - pad * 2 - barGap * (entries.length - 1)) / entries.length);
  const hits = [];
  entries.forEach((entry, index) => {
    const x = pad + index * (barWidth + barGap);
    const h = (entry.value / Math.max(max, 1)) * (height - pad * 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, height - pad - h, barWidth, h);
    hits.push({ x, y: height - pad - h, w: barWidth, h, entry });
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
    ctx.font = "11px system-ui";
    ctx.save();
    ctx.translate(x + barWidth / 2, height - 10);
    ctx.rotate(-Math.PI / 5);
    ctx.textAlign = "right";
    ctx.fillText(entry.label, 0, 0);
    ctx.restore();
  });
  state.chartHits.set(canvas.id, hits);
}

function aggregateMonthly(rows, key, mode) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.date || !row[key]) continue;
    if (!groups.has(row.month)) groups.set(row.month, []);
    groups.get(row.month).push(row);
  }
  return [...groups.entries()].sort().map(([label, items]) => {
    const values = items.map((row) => row[key]).filter(Boolean);
    const value = mode === "avg" ? avg(values) : mode === "max" ? Math.max(...values) : mode === "min" ? Math.min(...values) : median(values);
    return { label, value, rows: items };
  });
}

function renderCharts(rows) {
  drawLineChart(el("#priceChart"), rows, "totalPrice", "#236b8e");
  const unitEntries = aggregateMonthly(rows, "unitPrice", el("#unitMode").value);
  drawBarChart(el("#unitChart"), unitEntries, "#8c5b2f");
  drawBarChart(
    el("#volumeChart"),
    aggregateMonthly(rows, "totalPrice", "avg").map((entry) => ({ label: entry.label, value: entry.rows.length, rows: entry.rows })),
    "#2f7d61",
  );
  const byType = new Map();
  for (const row of rows) {
    const key = row.target || "未知";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(row);
  }
  drawBarChart(
    [...byType.entries()].length ? el("#mixChart") : el("#mixChart"),
    [...byType.entries()].sort((a, b) => b[1].length - a[1].length).map(([label, items]) => ({ label: label.slice(0, 8), value: items.length, rows: items, fullLabel: label })),
    "#b9792f",
  );
  const prices = rows.map((row) => row.totalPrice).filter(Boolean);
  const first = rows.find((row) => row.totalPrice);
  const last = [...rows].reverse().find((row) => row.totalPrice);
  const delta = first && last && first !== last ? ((last.totalPrice - first.totalPrice) / first.totalPrice) * 100 : 0;
  el("#priceTrendNote").textContent = prices.length ? `中位數 ${formatWan(median(prices))} · 首末 ${formatPct(delta)}` : "--";
}

function renderRepeatSales(rows) {
  let groups = repeatGroups(rows);
  if (state.repeatSort === "loss") groups = groups.sort((a, b) => a.pct - b.pct);
  else if (state.repeatSort === "days") groups = groups.sort((a, b) => a.days - b.days);
  else groups = groups.sort((a, b) => b.pct - a.pct);
  el("#repeatGrid").innerHTML = groups.slice(0, 12).map((group) => `
    <button class="repeat-card" type="button" data-repeat="${escapeHtml(normalizeText(group.first.address))}">
      <div>
        <h3>${escapeHtml(group.first.address)}</h3>
        <span>${group.rows.length} 次 · ${group.first.date || "--"} 到 ${group.last.date || "--"}</span>
      </div>
      <strong class="${group.pct >= 0 ? "up" : "down"}">${formatPct(group.pct)}</strong>
      <dl>
        <div><dt>持有天數</dt><dd>${numberFormat.format(group.days)}</dd></div>
        <div><dt>年化</dt><dd>${formatPct(group.annual)}</dd></div>
        <div><dt>總價差</dt><dd>${formatWan(group.delta)}</dd></div>
        <div><dt>單價差</dt><dd>${formatUnit(group.unitDelta)}</dd></div>
      </dl>
    </button>
  `).join("") || '<p class="empty">目前結果沒有同一完整門牌重複轉手紀錄。</p>';
}

function radarSections(rows) {
  const sortedLatest = sortRows(rows.filter((row) => row.date), { key: "date", dir: "desc" });
  const highPrice = sortRows(rows, { key: "totalPrice", dir: "desc" });
  const highUnit = sortRows(rows.filter((row) => row.unitPrice), { key: "unitPrice", dir: "desc" });
  const lowUnit = sortRows(rows.filter((row) => row.unitPrice), { key: "unitPrice", dir: "asc" });
  const repeats = repeatGroups(rows).sort((a, b) => b.pct - a.pct);
  const recent90 = rows.filter((row) => row.date && daysBetween(row.date, sortedLatest[0]?.date) <= 90);
  const unitValues = rows.map((row) => row.unitPrice).filter(Boolean);
  const unitAvg = avg(unitValues);
  const anomalies = rows.filter((row) => row.unitPrice && (row.unitPrice > unitAvg * 1.7 || row.unitPrice < unitAvg * 0.45));
  return [
    ["最新成交", sortedLatest.slice(0, 5)],
    ["高總價標的", highPrice.slice(0, 5)],
    ["低單價觀察", lowUnit.slice(0, 5)],
    ["高單價標的", highUnit.slice(0, 5)],
    ["漲幅最大", repeats.slice(0, 5).map((group) => ({ ...group.last, radarNote: formatPct(group.pct) }))],
    ["異常交易", anomalies.slice(0, 5)],
    ["最近 90 天", recent90.slice(0, 5)],
  ];
}

function renderRadar(rows) {
  el("#summaryGrid").innerHTML = radarSections(rows).map(([title, items]) => `
    <article class="summary-card">
      <h3>${escapeHtml(title)}</h3>
      <ul>
        ${items.map((row) => `
          <li>
            <button type="button" data-row="${escapeHtml(row.id)}">
              <span>${escapeHtml(row.address || row.road || row.target || "--")}</span>
              <b>${escapeHtml(row.radarNote || formatWan(row.totalPrice))}</b>
              <small>${escapeHtml(row.date || "--")} · ${escapeHtml(formatUnit(row.unitPrice))} 元/坪 · ${escapeHtml(row.source)}</small>
            </button>
          </li>
        `).join("") || "<li><span>--</span></li>"}
      </ul>
    </article>
  `).join("");
}

function renderColumns() {
  el("#recordHead").innerHTML = `<tr>${columnDefs
    .filter(([key]) => state.visibleColumns.includes(key))
    .map(([key, label]) => `<th><button type="button" data-sort="${key}">${label}${state.sort.key === key ? (state.sort.dir === "asc" ? " ↑" : " ↓") : ""}</button></th>`)
    .join("")}</tr>`;
  el("#columnPanel").innerHTML = columnDefs.map(([key, label]) => `
    <button class="column-tag ${state.visibleColumns.includes(key) ? "active" : ""}" type="button" data-column-toggle="${key}">
      ${label}
    </button>
  `).join("");
}

function cellValue(row, key) {
  const map = {
    date: row.date || row.rawDate || "--",
    address: row.address || "--",
    buildingNo: row.buildingNo || "--",
    target: row.isMain ? row.target : row.record.table_kind,
    totalPrice: formatWan(row.totalPrice),
    unitPrice: formatUnit(row.unitPrice),
    buildingPing: formatPing(row.buildingPing),
    landPing: formatPing(row.landPing),
    age: row.ageLabel,
    hasParking: row.hasParking ? "有" : "無",
    source: row.source,
    floor: row.floor || "--",
    buildingType: row.buildingType || "--",
  };
  return map[key] ?? "";
}

function renderTable() {
  const rows = displayRows();
  const maxRows = 900;
  const shown = rows.slice(0, maxRows);
  const total = Math.max(state.tableTotal || 0, rows.length);
  el("#tableMeta").textContent = `顯示 ${numberFormat.format(shown.length)} / ${numberFormat.format(total)} 筆。大量資料採 SQL 分頁與分批顯示。`;
  renderColumns();
  el("#recordRows").innerHTML = shown.map((row) => `
    <tr class="${row.isMain ? "" : "detail-row"} ${row.id === state.selectedRowId ? "selected" : ""} ${isAnomaly(row) ? "anomaly" : ""}" data-row="${escapeHtml(row.id)}">
      ${state.visibleColumns.map((key) => `<td>${escapeHtml(cellValue(row, key))}</td>`).join("")}
    </tr>
  `).join("");
}

function isAnomaly(row) {
  const rows = mainRows();
  const unitAvg = avg(rows.map((item) => item.unitPrice));
  return row.unitPrice && unitAvg && (row.unitPrice > unitAvg * 1.7 || row.unitPrice < unitAvg * 0.45);
}

function openDrawer(type, payload) {
  el("#detailDrawer").classList.add("open");
  el("#detailDrawer").setAttribute("aria-hidden", "false");
  if (type === "cluster") return renderClusterDrawer(payload);
  if (type === "repeat") return renderRepeatDrawer(payload);
  if (type === "metric") return renderMetricDrawer(payload);
  renderRowDrawer(payload);
}

function closeDrawer() {
  el("#detailDrawer").classList.remove("open");
  el("#detailDrawer").setAttribute("aria-hidden", "true");
}

function rowById(id) {
  return state.rows.find((row) => row.id === id);
}

function selectRow(id, { fly = true, open = true } = {}) {
  const row = rowById(id);
  if (!row) return;
  state.selectedRowId = id;
  renderTable();
  renderMap(mainRows());
  const tr = el(`tr[data-row="${CSS.escape(id)}"]`);
  tr?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (fly && state.map) state.map.flyTo(row.position, 17);
  if (open) openDrawer("row", row);
}

function rowsSameAddress(row) {
  const key = normalizeText(`${row.address} ${row.buildingNo}`);
  return mainRows().filter((item) => normalizeText(`${item.address} ${item.buildingNo}`) === key);
}

function rowsSameRoad(row) {
  return mainRows().filter((item) => row.road && item.road === row.road).slice(-12);
}

function renderRowDrawer(row) {
  el("#drawerType").textContent = row.isMain ? "Transaction" : row.record.table_kind;
  el("#drawerTitle").textContent = row.address || row.target || "詳細資料";
  const history = rowsSameAddress(row);
  const road = rowsSameRoad(row);
  el("#drawerBody").innerHTML = `
    <div class="drawer-actions">
      <button type="button" data-copy="${escapeHtml(row.address)}">複製地址</button>
      <button type="button" data-share="${escapeHtml(row.id)}">分享連結</button>
    </div>
    <div class="detail-grid">
      ${detailItem("區域", `${row.cityName}${row.township}`)}
      ${detailItem("交易日期", row.date || row.rawDate || "--")}
      ${detailItem("總價", formatWan(row.totalPrice))}
      ${detailItem("單價", `${formatUnit(row.unitPrice)} 元/坪`)}
      ${detailItem("建坪", `${formatPing(row.buildingPing)} 坪`)}
      ${detailItem("地坪", `${formatPing(row.landPing)} 坪`)}
      ${detailItem("棟及號", row.buildingNo || "--")}
      ${detailItem("屋齡", row.ageLabel)}
      ${detailItem("車位", row.hasParking ? "有" : "無")}
      ${detailItem("來源", row.source)}
    </div>
    ${miniList("同門牌歷史交易", history, true)}
    ${miniList("同路段相近交易", road, true)}
    <h3>原始資料 JSON</h3>
    <pre>${escapeHtml(JSON.stringify(row.record, null, 2))}</pre>
  `;
}

function detailItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function miniList(title, rows, clickable = false) {
  return `<h3>${escapeHtml(title)}</h3><ul class="mini-list">${rows.map((row) => `
    <li>${clickable ? `<button type="button" data-row="${escapeHtml(row.id)}">` : ""}
      <span>${escapeHtml(row.date || "--")} · ${escapeHtml(row.address || "--")}${row.buildingNo ? ` · ${escapeHtml(row.buildingNo)}` : ""}</span>
      <b>${escapeHtml(formatWan(row.totalPrice))}</b>
    ${clickable ? "</button>" : ""}</li>
  `).join("") || "<li>--</li>"}</ul>`;
}

function renderClusterDrawer(rows) {
  el("#drawerType").textContent = "Map Cluster";
  el("#drawerTitle").textContent = `${rows.length} 筆交易群`;
  el("#drawerBody").innerHTML = `${miniList("群組交易", sortRows(rows, { key: "date", dir: "desc" }).slice(0, 30), true)}`;
}

function renderRepeatDrawer(addressKey) {
  const group = repeatGroups(mainRows()).find((item) => normalizeText(item.first.address) === addressKey);
  if (!group) return;
  el("#drawerType").textContent = "Repeat Sale";
  el("#drawerTitle").textContent = group.first.address;
  el("#drawerBody").innerHTML = `
    <div class="detail-grid">
      ${detailItem("漲跌幅", formatPct(group.pct))}
      ${detailItem("年化報酬率", formatPct(group.annual))}
      ${detailItem("持有天數", numberFormat.format(group.days))}
      ${detailItem("總價差", formatWan(group.delta))}
      ${detailItem("單價差", `${formatUnit(group.unitDelta)} 元/坪`)}
    </div>
    ${miniList("交易時間線", group.rows, true)}
  `;
}

function renderMetricDrawer(metric) {
  const rows = mainRows();
  const content = {
    count: ["成交筆數", rows],
    avgPrice: ["平均總價", rows.filter((row) => row.totalPrice)],
    avgUnit: ["平均單價", rows.filter((row) => row.unitPrice)],
    repeat: ["重複轉手門牌", repeatGroups(rows).flatMap((group) => group.rows)],
    high: ["最高總價", sortRows(rows, { key: "totalPrice", dir: "desc" }).slice(0, 20)],
    latest: ["最新成交", sortRows(rows, { key: "date", dir: "desc" }).slice(0, 20)],
  }[metric];
  el("#drawerType").textContent = "Metric";
  el("#drawerTitle").textContent = content?.[0] || "摘要";
  el("#drawerBody").innerHTML = miniList(content?.[0] || "資料", content?.[1] || [], true);
}

function renderAll() {
  const rows = mainRows();
  renderHeader(rows);
  renderKpis(rows);
  renderMap(rows);
  renderCharts(rows);
  renderRadar(rows);
  renderRepeatSales(rows);
  renderTable();
}

function downloadFiltered(format) {
  const rows = displayRows();
  if (format === "csv") {
    const header = state.visibleColumns.map((key) => columnDefs.find(([id]) => id === key)?.[1] || key);
    const lines = [header, ...rows.map((row) => state.visibleColumns.map((key) => cellValue(row, key)))];
    const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    triggerDownload(csv, "text/csv;charset=utf-8", `plvr-filtered-${Date.now()}.csv`);
    return;
  }
  const payload = {
    generated_at: new Date().toISOString(),
    query: el("#queryInput").value,
    region: state.region?.region,
    rows,
  };
  triggerDownload(JSON.stringify(payload, null, 2), "application/json", `plvr-filtered-${Date.now()}.json`);
}

function triggerDownload(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const debouncedApply = debounce(() => applyFilter(), 220);

function bindEvents() {
  el("#citySelect").addEventListener("change", (event) => {
    state.city = event.target.value;
    populateTowns(state.city);
    state.township = el("#townSelect").value;
    state.cityCommunities = [];
    el("#communityList").innerHTML = "";
    el("#communityStatus").textContent = "尚未載入";
    loadCityCommunities(state.city).catch((error) => {
      console.warn(error);
      el("#communityStatus").textContent = "社區索引載入失敗";
    });
    saveFilters();
  });
  el("#townSelect").addEventListener("change", (event) => {
    state.township = event.target.value;
    saveFilters();
  });
  el("#loadButton").addEventListener("click", () => loadSelectedRegion());
  el("#queryInput").addEventListener("input", () => {
    const inferred = inferCommunity(el("#queryInput").value);
    if (inferred && (state.city !== inferred.city || state.township !== inferred.township)) selectRegion(inferred.city, inferred.township);
    renderSuggestions();
    renderCommunityList();
    renderCommunityTable();
    if (state.records.length) debouncedApply();
  });
  el("#queryInput").addEventListener("search", () => commitSearch());
  el("#queryInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") commitSearch();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== el("#queryInput")) {
      event.preventDefault();
      el("#queryInput").focus();
    }
    if (event.key === "Escape") closeDrawer();
  });
  el("#loadCityCommunities").addEventListener("click", () => loadCityCommunities(state.city));
  el("#communitySearch").addEventListener("input", debounce(renderCommunityList, 120));
  el("#communityTableSearch").addEventListener("input", debounce(renderCommunityTable, 120));
  el("#communityList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-community-name]");
    if (button) selectIndexedCommunity(button.dataset.communityName);
  });
  el("#communityRows").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-community-name]");
    if (row) selectIndexedCommunity(row.dataset.communityName);
  });
  el("#suggestList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-suggest]");
    if (!button) return;
    el("#queryInput").value = button.dataset.suggest;
    el("#suggestList").classList.remove("open");
    commitSearch();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".control-panel")) el("#suggestList").classList.remove("open");
  });
  for (const id of ["unitMode"]) {
    el(`#${id}`).addEventListener("input", () => applyFilter());
    el(`#${id}`).addEventListener("change", () => applyFilter());
  }
  el("#annotationLimit").addEventListener("input", (event) => {
    state.annotationLimit = Math.max(1, Math.min(9999, Number(event.target.value) || 13));
    el("#annotationLimitValue").textContent = numberFormat.format(state.annotationLimit);
    renderMap(mainRows());
  });
  el("#annotationLimit").addEventListener("change", () => {
    saveFilters();
    renderMap(mainRows());
  });
  el("#toggleDetailRows").addEventListener("click", () => {
    state.includeDetails = !state.includeDetails;
    el("#toggleDetailRows").textContent = state.includeDetails ? "只顯示主檔交易" : "顯示土地/建物/車位明細";
    renderTable();
  });
  el("#modeToggle").addEventListener("click", () => {
    state.compactMode = !state.compactMode;
    document.body.classList.toggle("pro-mode", !state.compactMode);
    el("#modeToggle").textContent = state.compactMode ? "專業模式" : "簡潔模式";
    saveFilters();
  });
  el("#columnToggle").addEventListener("click", () => el("#columnPanel").classList.toggle("open"));
  el("#columnPanel").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-column-toggle]");
    if (!button) return;
    const key = button.dataset.columnToggle;
    const isVisible = state.visibleColumns.includes(key);
    if (isVisible && state.visibleColumns.length <= 1) return;
    state.visibleColumns = isVisible
      ? state.visibleColumns.filter((item) => item !== key)
      : [...state.visibleColumns, key];
    renderTable();
  });
  el("#recordHead").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === "asc" ? "desc" : "asc" };
    renderTable();
  });
  el("#recordRows").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-row]");
    if (row) selectRow(row.dataset.row);
  });
  el("#summaryGrid").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-row]");
    if (button) selectRow(button.dataset.row);
  });
  el("#repeatGrid").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-repeat]");
    if (button) openDrawer("repeat", button.dataset.repeat);
  });
  els("[data-repeat-sort]").forEach((button) => button.addEventListener("click", () => {
    state.repeatSort = button.dataset.repeatSort;
    els("[data-repeat-sort]").forEach((item) => item.classList.toggle("active", item === button));
    renderRepeatSales(mainRows());
  }));
  el("#kpiGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-metric]");
    if (button) openDrawer("metric", button.dataset.metric);
  });
  for (const canvas of els("canvas")) {
    canvas.addEventListener("click", (event) => handleChartClick(canvas, event));
  }
  el("#downloadFiltered").addEventListener("click", () => downloadFiltered("json"));
  el("#downloadCsv").addEventListener("click", () => downloadFiltered("csv"));
  el("#clearCache").addEventListener("click", async () => {
    try {
      setStatus("正在清除快取...");
      const result = await queryService.clearCache();
      setQueryMeta(result.meta);
      setStatus("快取已清除。");
    } catch (error) {
      setStatus(`快取清除失敗：${error.message}`);
    }
  });
  el("#closeDrawer").addEventListener("click", closeDrawer);
  el("#drawerBody").addEventListener("click", async (event) => {
    const rowButton = event.target.closest("button[data-row]");
    if (rowButton) selectRow(rowButton.dataset.row);
    const copyButton = event.target.closest("button[data-copy]");
    if (copyButton) await navigator.clipboard.writeText(copyButton.dataset.copy);
    const shareButton = event.target.closest("button[data-share]");
    if (shareButton) {
      const url = new URL(location.href);
      url.searchParams.set("row", shareButton.dataset.share);
      await navigator.clipboard.writeText(url.toString());
    }
  });
  el("#themeToggle").addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    saveFilters();
    renderAll();
  });
  window.addEventListener("resize", debounce(() => renderAll(), 250));
}

function handleChartClick(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hits = state.chartHits.get(canvas.id) || [];
  const hit = hits.find((item) => {
    if (item.row) return Math.hypot(item.x - x, item.y - y) <= item.radius;
    return x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h;
  });
  if (!hit) return;
  if (hit.row) selectRow(hit.row.id);
  if (hit.entry?.rows?.length === 1) selectRow(hit.entry.rows[0].id);
  else if (hit.entry?.rows?.length) openDrawer("cluster", hit.entry.rows);
}

async function init() {
  bindEvents();
  try {
    await loadIndex();
    const initialCommunity = await resolveCommunitySearch(el("#queryInput").value.trim());
    if (initialCommunity) {
      state.selectedCommunity = initialCommunity;
      selectRegion(initialCommunity.city, initialCommunity.township);
      el("#queryInput").value = initialCommunity.name;
    }
    await loadSelectedRegion();
    const selected = new URLSearchParams(location.search).get("row");
    if (selected) selectRow(selected, { fly: true, open: true });
  } catch (error) {
    console.error(error);
    setStatus(`資料載入失敗：${error.message}`);
  }
}

init();
