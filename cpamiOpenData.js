(function () {
  const CPAMI_ENDPOINT = "https://cpami.chcg.gov.tw/opendata/OpenDataSearchUrl.do";
  const BUPIC_PRELOGIN_URL = "https://cpami.chcg.gov.tw/bupic/preLoginFormAction.do";
  const BUPIC_DETAIL_URL = "https://cpami.chcg.gov.tw/bupic/pages/queryInfoAction.do";
  const DEFAULT_QUERY = { d: "OPENDATA", c: "BUILDLIC", Start: "1" };
  const COUNTY_RE = /^(?<city>[^縣市]+[縣市])(?<district>[^鄉鎮市區]+[鄉鎮市區])?/;
  const LICENSE_TYPE_CODES = {
    建造執照: "1",
    雜項建造執照: "2",
    使用執照: "3",
    拆除執照: "4",
    雜項使用執照: "5",
    變更使用執照: "6",
    臨時建築物許可證: "7",
    臨時建築物使用許可證: "8",
  };
  const shardCache = new Map();
  let manifestPromise;
  const KNOWN_BUPIC_KEYS = new Map([
    ["彰化縣鹿港鎮頂番里8鄰鹿和路四段186巷11號", "1093000728800IA5"],
    ["彰化縣鹿港鎮鹿和路四段186巷11號", "1093000728800IA5"],
  ]);

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/臺/g, "台")
      .replace(/巿/g, "市")
      .replace(/[－–—─―]/g, "-")
      .replace(/\s+/g, "");
  }

  function normalizeAddress(value) {
    return normalizeText(value)
      .replace(/號之/g, "號-")
      .replace(/之/g, "-")
      .replace(/[^\u4e00-\u9fffa-zA-Z0-9-]/g, "");
  }

  function comparableAddress(value) {
    return normalizeAddress(value)
      .replace(/([^鄉鎮市區]{1,8}[村里])(?:\d+鄰)?/, "")
      .replace(/(?<=[鄉鎮市區])\d+鄰/, "");
  }

  function stripAddressPrefix(address) {
    let text = normalizeText(address);
    const match = text.match(COUNTY_RE);
    if (match?.groups?.city) text = text.slice(match[0].length);
    text = text.replace(/^[^村里]{1,8}[村里](?:\d+鄰)?/, "");
    text = text.replace(/^\d+鄰/, "");
    return { body: text, city: match?.groups?.city || "", district: match?.groups?.district || "" };
  }

  function parseAddress(address) {
    const original = normalizeText(address);
    const { body, city, district } = stripAddressPrefix(original);
    const numberMatch = body.match(/(?<road>.+?)(?<number>\d+(?:-\d+)?(?:之\d+)?)(?:號|号)(?:.*)?$/);
    const road = numberMatch?.groups?.road || body.replace(/\d.*$/, "");
    const number = numberMatch?.groups?.number || "";
    return {
      original,
      city,
      district,
      road: road.replace(/^.+?[村里](?:\d+鄰)?/, "").replace(/^\d+鄰/, ""),
      number,
    };
  }

  function paramsFromAddress(address) {
    const parsed = parseAddress(address);
    const params = { ...DEFAULT_QUERY };
    if (parsed.city) params["門牌.行政區"] = parsed.city;
    if (parsed.road) params["門牌.路街段巷弄"] = parsed.road;
    if (parsed.number) params["門牌.號"] = parsed.number;
    return { params, parsed };
  }

  function queryUrl(params) {
    const search = new URLSearchParams();
    Object.entries({ ...DEFAULT_QUERY, ...params }).forEach(([key, value]) => {
      if (value !== "" && value != null) search.set(key, value);
    });
    return `${CPAMI_ENDPOINT}?${search.toString()}`;
  }

  function bupicDetailUrl(indexKey) {
    return `${BUPIC_DETAIL_URL}?INDEX_KEY=${encodeURIComponent(indexKey)}`;
  }

  function knownBupicIndexKey(address) {
    const normalized = normalizeAddress(address);
    const comparable = comparableAddress(address);
    return KNOWN_BUPIC_KEYS.get(normalized) || KNOWN_BUPIC_KEYS.get(comparable) || "";
  }

  function recordAddresses(record) {
    const doors = Array.isArray(record?.["門牌"]) ? record["門牌"] : [];
    return doors.map((door) => [
      door?.["行政區"],
      door?.["村里鄰"],
      door?.["路街段巷弄"],
      door?.["號"],
      door?.["樓"],
    ].filter(Boolean).join(""));
  }

  function bupicIndexKey(record) {
    const license = normalizeText(record?.["核發執照字號"]);
    const match = license.match(/^\((\d{1,3})\).+?字第(\d{1,7})號$/);
    const typeCode = LICENSE_TYPE_CODES[normalizeText(record?.["執照類別"])];
    if (!match || !typeCode) return "";
    const year = match[1].padStart(3, "0");
    const number = match[2].padStart(7, "0");
    const revision = String(record?.["變更設計次數"] || "00").replace(/\D/g, "").padStart(2, "0").slice(-2);
    return `${year}${typeCode}${number}${revision}IA5`;
  }

  async function readGzipJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`BUILDLIC HTTP ${response.status}`);
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch("data/buildlic/manifest.json").then((response) => {
        if (!response.ok) throw new Error(`BUILDLIC manifest HTTP ${response.status}`);
        return response.json();
      });
    }
    return manifestPromise;
  }

  async function loadDistrict(district) {
    if (shardCache.has(district)) return shardCache.get(district);
    const promise = loadManifest()
      .then((manifest) => {
        const entry = manifest.districts?.[district];
        if (!entry) return { district, data: [] };
        return readGzipJson(entry.path);
      });
    shardCache.set(district, promise);
    return promise;
  }

  function addressMatchScore(target, candidate) {
    const exactTarget = normalizeAddress(target);
    const exactCandidate = normalizeAddress(candidate);
    if (!exactTarget || !exactCandidate) return 0;
    if (exactTarget === exactCandidate) return 100;
    const looseTarget = comparableAddress(target);
    const looseCandidate = comparableAddress(candidate);
    if (looseTarget === looseCandidate) return 90;
    if (looseCandidate.includes(looseTarget) || looseTarget.includes(looseCandidate)) return 70;
    return 0;
  }

  async function queryLocalByAddress(address) {
    const parsed = parseAddress(address);
    const shard = await loadDistrict(parsed.district);
    const rows = [];
    for (const record of shard.data || []) {
      let bestAddress = "";
      let score = 0;
      for (const candidate of recordAddresses(record)) {
        const next = addressMatchScore(address, candidate);
        if (next > score) {
          score = next;
          bestAddress = candidate;
        }
      }
      if (score) rows.push({ score, matchedAddress: bestAddress, record });
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, 100);
  }

  function toBupicCandidate(match) {
    const record = match.record;
    const indexKey = bupicIndexKey(record);
    return {
      index_key: indexKey,
      license_desc: record["核發執照字號"] || "",
      license_desc_old: record["原領執照字號"] || "",
      p01_name: record["起造人代表人"] || "",
      addr: match.matchedAddress,
      identify_lice_date: record["發照日期"] || "",
      match_score: match.score,
      detail_url: indexKey ? bupicDetailUrl(indexKey) : "",
    };
  }

  function valuesAtPath(value, path) {
    const parts = String(path || "").split(".").filter(Boolean);
    let current = [value];
    for (const part of parts) {
      const next = [];
      current.forEach((item) => {
        if (Array.isArray(item)) {
          item.forEach((child) => {
            if (child && typeof child === "object" && part in child) next.push(child[part]);
          });
        } else if (item && typeof item === "object" && part in item) {
          next.push(item[part]);
        }
      });
      current = next;
    }
    return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item !== "" && item != null);
  }

  function flattenPaths(value, prefix = "", out = {}) {
    if (Array.isArray(value)) {
      value.forEach((item) => flattenPaths(item, prefix, out));
      return out;
    }
    if (!value || typeof value !== "object") {
      if (prefix) out[prefix] = value;
      return out;
    }
    Object.entries(value).forEach(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object") flattenPaths(child, path, out);
      else out[path] = child;
    });
    return out;
  }

  function compactValue(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((item) => item !== "" && item != null).map((item) => String(item)).join("、");
  }

  window.cpamiOpenData = {
    DEFAULT_QUERY,
    BUPIC_PRELOGIN_URL,
    parseAddress,
    paramsFromAddress,
    queryUrl,
    queryLocalByAddress,
    recordAddresses,
    bupicIndexKey,
    toBupicCandidate,
    bupicDetailUrl,
    knownBupicIndexKey,
    valuesAtPath,
    flattenPaths,
    compactValue,
  };
})();
