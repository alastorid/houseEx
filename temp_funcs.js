function applyNumericFilters() {
  removeAutoFilters(["building_area_ping", "land_area_ping", "total_price", "unit_price_ping"]);
  for (const [field, minId, maxId, scale] of [
    ["building_area_ping", "minBuilding", "maxBuilding", 1],
    ["land_area_ping", "minLand", "maxLand", 1],
    ["total_price", "minPrice", "maxPrice", 10000],
    ["unit_price_ping", "minUnit", "maxUnit", 10000],
  ]) {
    const min = el(`#${minId}`).value.trim();
    const max = el(`#${maxId}`).value.trim();
    if (min) state.filters.push({ field, operator: ">=", value: Number(min) * scale });
    if (max) state.filters.push({ field, operator: "<=", value: Number(max) * scale });
  }
  state.offset = 0;
  renderFilters();
  runQuery();
}

function renderFilters() {
  el("#activeFilters").innerHTML = state.filters.map((filter, index) => (
    `<div class="filter-line">${humanFilter(filter)}<button type="button" data-remove-filter="${index}">×</button></div>`
  )).join("");
}
