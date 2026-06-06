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

  function recordAddress(record) {
    const door = Array.isArray(record?.["門牌"]) ? record["門牌"].find(Boolean) : null;
    if (!door) return "";
    return [
      door["行政區"],
      door["村里鄰"],
      door["路街段巷弄"],
      door["號"],
      door["樓"],
    ].filter(Boolean).join("");
  }

  function bupicIndexKey(record) {
    const license = normalizeText(record?.["核發執照字號"]);
    const match = license.match(/^\((\d{2,3})\).+?字第(\d{1,7})號$/);
    const typeCode = LICENSE_TYPE_CODES[normalizeText(record?.["執照類別"])];
    if (!match || !typeCode) return "";
    const year = match[1].padStart(3, "0");
    const number = match[2].padStart(7, "0");
    const revision = String(record?.["變更設計次數"] || "00").replace(/\D/g, "").padStart(2, "0").slice(-2);
    return `${year}${typeCode}${number}${revision}IA5`;
  }

  function bupicDetailUrl(indexKey) {
    return `${BUPIC_DETAIL_URL}?INDEX_KEY=${encodeURIComponent(indexKey)}`;
  }

  function knownBupicIndexKey(address) {
    const normalized = normalizeAddress(address);
    const comparable = comparableAddress(address);
    return KNOWN_BUPIC_KEYS.get(normalized) || KNOWN_BUPIC_KEYS.get(comparable) || "";
  }

  async function resolveBupicDetails(address) {
    const knownKey = knownBupicIndexKey(address);
    if (knownKey) {
      return [{
        indexKey: knownKey,
        detailUrl: bupicDetailUrl(knownKey),
        address: normalizeAddress(address),
        source: "confirmed-address",
      }];
    }

    const { params } = paramsFromAddress(address);
    const result = await fetchJson(params);
    const target = comparableAddress(address);
    const records = Array.isArray(result.data?.data) ? result.data.data : [];
    return records
      .map((record) => {
        const indexKey = bupicIndexKey(record);
        const foundAddress = recordAddress(record);
        return {
          indexKey,
          detailUrl: indexKey ? bupicDetailUrl(indexKey) : "",
          address: foundAddress,
          license: record["核發執照字號"] || "",
          type: record["執照類別"] || "",
          source: "buildlic-opendata",
          record,
          matchesAddress: comparableAddress(foundAddress) === target,
        };
      })
      .filter((item) => item.indexKey && item.matchesAddress);
  }

  async function fetchTextWithTimeout(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        headers: { Accept: "application/json,text/plain,*/*" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(params) {
    const url = queryUrl(params);
    try {
      const text = await fetchTextWithTimeout(url);
      const data = JSON.parse(text.replace(/^\uFEFF/, ""));
      return { data, meta: { source: "cpami.chcg.gov.tw", url, fetchedAt: new Date().toISOString() } };
    } catch (error) {
      throw Object.assign(new Error(`OpenData query failed: ${error?.message || "unknown"}`), { url });
    }
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
    fetchJson,
    bupicIndexKey,
    bupicDetailUrl,
    knownBupicIndexKey,
    resolveBupicDetails,
    valuesAtPath,
    flattenPaths,
    compactValue,
  };
})();
