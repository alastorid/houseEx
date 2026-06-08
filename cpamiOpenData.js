(function () {
  const CPAMI_ENDPOINT = "https://cpami.chcg.gov.tw/opendata/OpenDataSearchUrl.do";
  const BUPIC_PRELOGIN_URL = "https://cpami.chcg.gov.tw/bupic/preLoginFormAction.do";
  const BUPIC_SEARCH_URL = "https://cpami.chcg.gov.tw/bupic/pages/api/getLicdata";
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
  const BUPIC_DISTRICT_CODES = {
    彰化市: "500",
    芬園鄉: "502",
    花壇鄉: "503",
    秀水鄉: "504",
    鹿港鎮: "505",
    福興鄉: "506",
    線西鄉: "507",
    和美鎮: "508",
    伸港鄉: "509",
    員林市: "510",
    社頭鄉: "511",
    永靖鄉: "512",
    埔心鄉: "513",
    溪湖鎮: "514",
    大村鄉: "515",
    埔鹽鄉: "516",
    田中鎮: "520",
    北斗鎮: "521",
    田尾鄉: "522",
    埤頭鄉: "523",
    溪州鄉: "524",
    竹塘鄉: "525",
    二林鎮: "526",
    大城鄉: "527",
    芳苑鄉: "528",
    二水鄉: "530",
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

  function splitBupicRoad(value) {
    let text = normalizeText(value);
    let alley = "";
    let lane = "";
    const alleyMatch = text.match(/(.+?)(\d+)弄$/);
    if (alleyMatch) {
      text = alleyMatch[1];
      alley = alleyMatch[2];
    }
    const laneMatch = text.match(/(.+?)(\d+)巷$/);
    if (laneMatch) {
      text = laneMatch[1];
      lane = laneMatch[2];
    }
    return { road: text, lane, alley };
  }

  function bupicParamsFromAddress(address) {
    const parsed = parseAddress(address);
    const roadParts = splitBupicRoad(parsed.road);
    const number = String(parsed.number || "").replace(/號.*$/, "").replace(/之/g, "-");
    const params = {
      _search: "false",
      nd: String(Date.now()),
      rows: "200",
      page: "1",
      sidx: "",
      sord: "asc",
      qtype: "3",
      addradr: BUPIC_DISTRICT_CODES[parsed.district] || "",
      addrad2: roadParts.road,
      addrad3: roadParts.lane,
      addrad4: roadParts.alley,
      addrad5: number,
    };
    return { params, parsed };
  }

  function bupicRequest(address) {
    const callback = `jQuery${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const { params, parsed } = bupicParamsFromAddress(address);
    const body = new URLSearchParams(params);
    return {
      callback,
      parsed,
      params,
      url: `${BUPIC_SEARCH_URL}?callback=${encodeURIComponent(callback)}`,
      body: body.toString(),
      curl: `curl -X POST '${BUPIC_SEARCH_URL}?callback=${encodeURIComponent(callback)}' -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' --data '${body.toString().replace(/'/g, "'\\''")}'`,
    };
  }

  function parseJsonp(text) {
    const source = String(text || "").trim();
    const start = source.indexOf("(");
    const end = source.lastIndexOf(")");
    if (start < 0 || end <= start) throw new Error("BUPIC response is not JSONP");
    return JSON.parse(source.slice(start + 1, end));
  }

  async function queryBupicByAddress(address) {
    const request = bupicRequest(address);
    const response = await fetch(request.url, {
      method: "POST",
      mode: "cors",
      credentials: "include",
      referrer: BUPIC_PRELOGIN_URL,
      headers: {
        Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: request.body,
    });
    if (!response.ok) throw new Error(`BUPIC HTTP ${response.status}`);
    const payload = parseJsonp(await response.text());
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return {
      request,
      payload,
      rows: rows.map((row) => ({
        ...row,
        detail_url: row.index_key ? bupicDetailUrl(row.index_key) : "",
      })),
    };
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
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
        const separator = entry.path.includes("?") ? "&" : "?";
        return readGzipJson(`${entry.path}${separator}h=${encodeURIComponent(entry.hash || manifest.version || "")}`);
      });
    shardCache.set(district, promise);
    return promise;
  }

  function addressMatchScore(target, candidate) {
    const exactTarget = normalizeAddress(target);
    const exactCandidate = normalizeAddress(candidate);
    if (!exactTarget || !exactCandidate) return 0;
    const targetParts = parseAddress(target);
    const candidateParts = parseAddress(candidate);
    if (targetParts.number && !candidateParts.number) return 0;
    if (targetParts.road && !candidateParts.road) return 0;
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
    BUPIC_SEARCH_URL,
    parseAddress,
    paramsFromAddress,
    bupicParamsFromAddress,
    bupicRequest,
    queryBupicByAddress,
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
