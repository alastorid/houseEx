(function () {
  const CPAMI_ENDPOINT = "https://cpami.chcg.gov.tw/opendata/OpenDataSearchUrl.do";
  const BUPIC_PRELOGIN_URL = "https://cpami.chcg.gov.tw/bupic/preLoginFormAction.do";
  const BUPIC_DETAIL_URL = "https://cpami.chcg.gov.tw/bupic/pages/queryInfoAction.do";
  const DEFAULT_QUERY = { d: "OPENDATA", c: "BUILDLIC", Start: "1" };
  const COUNTY_RE = /^(?<city>[^縣市]+[縣市])(?<district>[^鄉鎮市區]+[鄉鎮市區])?/;
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
    bupicDetailUrl,
    knownBupicIndexKey,
    valuesAtPath,
    flattenPaths,
    compactValue,
  };
})();
