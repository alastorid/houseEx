const queryService = (() => {
  const WORKER_VERSION = "20260601-load-feedback";
  const DEFAULT_TIMEOUT_MS = 15000;
  const latestByChannel = new Map();
  let worker;
  let nextId = 1;
  const pending = new Map();

  function abortError(message = "Query cancelled") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`sqlWorker.js?v=${WORKER_VERSION}`);
    worker.addEventListener("message", (event) => {
      if (event.data?.type === "status") {
        window.dispatchEvent(new CustomEvent("sqlite-status", { detail: event.data.status || {} }));
        return;
      }
      const { id, ok, result, error } = event.data || {};
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      request.signal?.removeEventListener("abort", request.abortHandler);
      if (latestByChannel.get(request.channel) !== id) {
        request.reject(abortError("Stale query ignored"));
        return;
      }
      if (ok) request.resolve(result);
      else request.reject(new Error(error || "SQL worker error"));
    });
    worker.addEventListener("error", (event) => {
      for (const [id, request] of pending.entries()) {
        clearTimeout(request.timer);
        request.reject(new Error(event.message || "SQL worker crashed"));
        pending.delete(id);
      }
    });
    return worker;
  }

  function cancelChannel(channel) {
    const latestId = latestByChannel.get(channel);
    for (const [id, request] of pending.entries()) {
      if (request.channel !== channel || id === latestId) continue;
      clearTimeout(request.timer);
      request.signal?.removeEventListener("abort", request.abortHandler);
      request.reject(abortError("Superseded by newer query"));
      pending.delete(id);
    }
  }

  function call(type, payload = {}, options = {}) {
    ensureWorker();
    const id = nextId;
    nextId += 1;
    const channel = options.channel || type;
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    latestByChannel.set(channel, id);
    cancelChannel(channel);

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const abortHandler = () => {
        pending.delete(id);
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, signal: options.signal, abortHandler, channel });
      options.signal?.addEventListener("abort", abortHandler, { once: true });
      worker.postMessage({ id, type, payload });
    });
  }

  return {
    init: (params, options) => call("init", params, { channel: "init", timeoutMs: 30000, ...options }),
    searchCommunities: (params, options) => call("searchCommunities", params, { channel: "search", timeoutMs: 5000, ...options }),
    searchAll: (params, options) => call("searchAll", params, { channel: "search", timeoutMs: 5000, ...options }),
    queryCommunities: (params, options) => call("queryCommunities", params, { channel: "communities", ...options }),
    loadCity: (params, options) => call("loadCity", params, { channel: `city:${params?.city || ""}`, timeoutMs: 45000, ...options }),
    queryTransactions: (params, options) => call("queryTransactions", params, { channel: "transactions", ...options }),
    queryTransactionDetail: (params, options) => call("queryTransactionDetail", params, { channel: "detail", timeoutMs: 5000, ...options }),
    queryRepeatSales: (params, options) => call("queryRepeatSales", params, { channel: "repeat-sales", ...options }),
    queryMapAnnotations: (params, options) => call("queryMapAnnotations", params, { channel: "map", timeoutMs: 8000, ...options }),
    queryColumnAnalytics: (params, options) => call("queryColumnAnalytics", params, { channel: "analytics", timeoutMs: 8000, ...options }),
    clearCache: (params, options) => call("clearCache", params, { channel: "cache", timeoutMs: 10000, ...options }),
  };
})();

window.queryService = queryService;
