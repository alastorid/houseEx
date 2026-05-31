async function refreshRangeHints() {
  if (state.analyticsLoading || !state.city) return;
  state.analyticsLoading = true;
  try {
    const payload = filterPayload();
    for (const item of [
      ["building_area_ping", "buildingMin", "buildingMax", "buildingRangeLabel", "buildingFill", (v) => decimal.format(v), 0.5],
      ["land_area_ping", "landMin", "landMax", "landRangeLabel", "landFill", (v) => decimal.format(v), 0.5],
      ["total_price", "priceMin", "priceMax", "priceRangeLabel", "priceFill", (v) => money.format(v / 10000), 10],
      ["unit_price_ping", "unitMin", "unitMax", "unitRangeLabel", "unitFill", (v) => decimal.format(v / 10000), 1],
    ]) {
      const [field, minId, maxId, labelId, fillId, formatter, displayStep] = item;
      const result = await queryService.queryColumnAnalytics({ ...payload, field }).catch(() => ({ rows: [{ min: 0, max: 0 }] }));
      const row = result.rows[0] || { min: 0, max: 0 };
      const scale = field === "total_price" || field === "unit_price_ping" ? 10000 : 1;
      const inputMin = el(`#${minId}`);
      const inputMax = el(`#${maxId}`);
      const lo = Math.floor(row.min / scale);
      const hi = Math.ceil(row.max / scale);
      inputMin.min = String(lo);
      inputMin.max = String(hi);
      inputMin.step = String(displayStep);
      inputMax.min = String(lo);
      inputMax.max = String(hi);
      inputMax.step = String(displayStep);
      if (!state.rangeBounds[field]?.touched) {
        inputMin.value = String(lo);
        inputMax.value = String(hi);
      }
      state.rangeBounds[field] = { min: lo, max: hi, scale, fillId, labelId, minId, maxId, formatter, touched: state.rangeBounds[field]?.touched || false };
      updateRangeLabel(field);
    }
  } finally {
    state.analyticsLoading = false;
  }
}

function updateRangeLabel(field) {
  const bounds = state.rangeBounds[field];
  if (!bounds) return;
  const minInput = el(`#${bounds.minId}`);
  const maxInput = el(`#${bounds.maxId}`);
  let minValue = Number(minInput.value);
  let maxValue = Number(maxInput.value);
  if (minValue > maxValue) [minValue, maxValue] = [maxValue, minValue];
  const format = bounds.formatter || ((v) => decimal.format(v));
  el(`#${bounds.labelId}`).textContent = `${format(minValue * bounds.scale)} ~ ${format(maxValue * bounds.scale)}`;
  const spread = Math.max(bounds.max - bounds.min, 1);
  const left = ((minValue - bounds.min) / spread) * 100;
  const right = ((maxValue - bounds.min) / spread) * 100;
  const fill = el(`#${bounds.fillId}`);
  fill.style.left = `${left}%`;
  fill.style.width = `${Math.max(0, right - left)}%`;
}

function applyRangeFilters() {
  removeAutoFilters(["building_area_ping", "land_area_ping", "total_price", "unit_price_ping"]);
  for (const [field, minId, maxId] of [
    ["building_area_ping", "buildingMin", "buildingMax"],
    ["land_area_ping", "landMin", "landMax"],
    ["total_price", "priceMin", "priceMax"],
    ["unit_price_ping", "unitMin", "unitMax"],
  ]) {
    const bounds = state.rangeBounds[field];
    if (!bounds) continue;
    const min = Math.min(Number(el(`#${minId}`).value), Number(el(`#${maxId}`).value));
    const max = Math.max(Number(el(`#${minId}`).value), Number(el(`#${maxId}`).value));
    if (min > bounds.min || max < bounds.max) state.filters.push({ field, operator: "between", value: min * bounds.scale, value2: max * bounds.scale });
  }
  renderFilters();
  runQuery();
}
