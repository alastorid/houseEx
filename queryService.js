const queryService = (() => {
  let worker;
  let nextId = 1;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("sqlWorker.js?v=20260531-sqlite-worker");
    worker.addEventListener("message", (event) => {
      const { id, ok, result, error } = event.data || {};
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (ok) request.resolve(result);
      else request.reject(new Error(error || "SQL worker error"));
    });
    return worker;
  }

  function call(type, payload = {}) {
    ensureWorker();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  }

  return {
    init: () => call("init"),
    searchCommunities: (params) => call("searchCommunities", params),
    queryCommunities: (params) => call("queryCommunities", params),
    loadCity: (params) => call("loadCity", params),
    queryTransactions: (params) => call("queryTransactions", params),
    queryTransactionDetail: (params) => call("queryTransactionDetail", params),
    queryRepeatSales: (params) => call("queryRepeatSales", params),
    queryMapAnnotations: (params) => call("queryMapAnnotations", params),
  };
})();

window.queryService = queryService;
