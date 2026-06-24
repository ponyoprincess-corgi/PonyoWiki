"use strict";

const DEFAULT_BRIDGE = "http://127.0.0.1:8767";
const CACHE_URL = "data/towers_export.json";
const SESSION_KEY = "ponyoDesignerNotes";
const DETAIL_WIDTH_KEY = "ponyoDetailWidth";
const REQUIRED_EXPORT_VERSION = "designer-domains-v1";
const CACHE_MAX_AGE_HOURS = 4;

const CATEGORY_CONFIG = [
  ["Dashboard", "Dashboard"],
  ["Items / Resources", "Items"],
  ["Recipes / Crafting", "Recipe Audit"],
  ["Stations", "Stations"],
  ["Creatures", "Creatures"],
  ["Spawner Values", "Spawners"],
  ["Villages / Buildings", "Villages"],
  ["Loot Tables", "Loot"],
  ["Progression / Unlocks", "Progression"],
  ["Quests", "Quests"],
  ["Biomes / Ecosystems", "Biomes"],
  ["Data Tables", "Data Tables"],
  ["Blueprints", "Blueprints"],
  ["Maps / Levels", "Maps"],
  ["Validation", "Validation"],
  ["All Records", "All Records"]
];

const state = {
  records: [],
  views: [],
  byId: new Map(),
  byPath: new Map(),
  notes: loadNotes(),
  selectedId: null,
  activeCategory: "Items / Resources",
  activeLens: "overview",
  activeTab: "impact",
  query: "",
  filters: {
    category: "All",
    type: "All",
    station: "All",
    warningsOnly: false
  },
  meta: null,
  bridgeHealth: null,
  validation: [],
  changeLog: [],
  lastSyncError: "",
  autoRefreshAttempted: false,
  autoRefreshInFlight: false
};

const el = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindControls();
  renderSkeleton();
  boot();
});

function cacheElements() {
  [
    "sourceSummary", "categoryNav", "globalSearch", "bridgeUrl", "syncButton", "exportButton",
    "statusStrip", "quickStats", "viewTitle", "viewSubtitle", "recordCount", "categoryFilter",
    "categoryFilterLabel", "typeFilterLabel", "stationFilterLabel", "typeFilter", "stationFilter",
    "warningFilter", "dashboard", "recordsList", "paneResizer", "detailHeader",
    "detailBody", "drawerBody"
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function bindControls() {
  el.bridgeUrl.value = localStorage.getItem("ponyoBridgeUrl") || DEFAULT_BRIDGE;
  el.bridgeUrl.addEventListener("change", () => {
    localStorage.setItem("ponyoBridgeUrl", getBridgeUrl());
  });
  el.syncButton.addEventListener("click", () => syncFromUnreal({ force: true }));
  el.exportButton.addEventListener("click", exportSession);
  el.globalSearch.addEventListener("input", (event) => {
    state.query = event.target.value;
    inferCategoryFromQuery();
    renderAll();
  });
  el.categoryFilter.addEventListener("change", (event) => {
    state.filters.category = event.target.value;
    renderAll();
  });
  el.typeFilter.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    renderAll();
  });
  el.stationFilter.addEventListener("change", (event) => {
    state.filters.station = event.target.value;
    renderAll();
  });
  el.warningFilter.addEventListener("change", (event) => {
    state.filters.warningsOnly = event.target.checked;
    renderAll();
  });
  bindPaneResizer();
  document.querySelectorAll(".lens-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeLens = button.dataset.lens;
      document.querySelectorAll(".lens-button").forEach((item) => item.classList.toggle("active", item === button));
      renderAll();
    });
  });
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll(".tab-button").forEach((item) => item.classList.toggle("active", item === button));
      renderDrawer();
    });
  });
}

function bindPaneResizer() {
  const savedWidth = Number(localStorage.getItem(DETAIL_WIDTH_KEY));
  if (savedWidth) setDetailWidth(savedWidth);
  let dragging = false;
  const beginDrag = (event) => {
    dragging = true;
    el.paneResizer.classList.add("dragging");
    document.body.classList.add("resizing");
    event.preventDefault();
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    el.paneResizer.classList.remove("dragging");
    document.body.classList.remove("resizing");
    localStorage.setItem(DETAIL_WIDTH_KEY, String(getDetailWidth()));
  };
  const drag = (clientX) => {
    if (!dragging) return;
    const bounds = document.querySelector(".workbench").getBoundingClientRect();
    const width = bounds.right - clientX - 18;
    setDetailWidth(width);
  };
  el.paneResizer.addEventListener("pointerdown", beginDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("pointermove", (event) => drag(event.clientX));
  el.paneResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const delta = event.key === "ArrowLeft" ? 40 : -40;
    setDetailWidth(getDetailWidth() + delta);
    localStorage.setItem(DETAIL_WIDTH_KEY, String(getDetailWidth()));
    event.preventDefault();
  });
}

function setDetailWidth(width) {
  const shellWidth = document.querySelector(".workbench")?.clientWidth || window.innerWidth;
  const minWidth = 420;
  const maxWidth = Math.max(420, shellWidth - 420);
  const clamped = Math.max(minWidth, Math.min(width, maxWidth));
  document.documentElement.style.setProperty("--detail-width", `${clamped}px`);
}

function getDetailWidth() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--detail-width");
  return Number.parseInt(value, 10) || 620;
}

async function boot() {
  setStatus("Loading cached Towers export.", "warn");
  const loaded = await loadCachedExport();
  renderAll();
  await refreshBridgeHealth();
  if (!loaded) {
    setStatus("No cached export found. Start Towers and use Sync From Unreal.", "warn");
  }
  renderAll();
  autoPrefetchIfNeeded(loaded);
}

async function loadCachedExport() {
  try {
    const snapshot = await loadCachedExportSnapshot();
    loadSnapshot(snapshot, "Loaded cached real export.");
    return true;
  } catch (error) {
    try {
      const snapshot = await loadBridgeCachedExportSnapshot();
      loadSnapshot(snapshot, "Loaded cached real export through the PonyoWiki bridge.");
      return true;
    } catch (bridgeError) {
      state.lastSyncError = `Cached export unavailable: ${error.message}; bridge cache unavailable: ${bridgeError.message}`;
      return false;
    }
  }
}

async function refreshBridgeHealth() {
  try {
    const response = await fetchWithTimeout(`${getBridgeUrl()}/api/health`, { method: "GET" }, 6000);
    const payload = await response.json();
    state.bridgeHealth = payload;
    if (payload.success && payload.unrealMcp?.success) {
      const port = payload.unrealMcp.port;
      setStatus(`Cached data loaded. UnrealMCP is available on ${payload.unrealMcp.host}:${port}.`, "ok");
    }
  } catch (error) {
    state.bridgeHealth = null;
  }
}

async function syncFromUnreal(options = {}) {
  const isAuto = Boolean(options.auto);
  setStatus(isAuto ? "Refreshing from Unreal in the background." : "Syncing real data from Towers through UnrealMCP.", "warn");
  el.syncButton.disabled = true;
  el.syncButton.textContent = isAuto ? "Refreshing..." : "Syncing...";
  try {
    const response = await fetchWithTimeout(`${getBridgeUrl()}/api/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "Towers", requireRealData: true })
    }, 240000);
    const responseText = await response.text();
    const payload = parseBridgeJson(responseText);
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const snapshot = payload.snapshot
      ? normalizeSnapshot(payload.snapshot)
      : await loadBestCachedExportSnapshot();
    loadSnapshot(snapshot, isAuto ? "Fresh Unreal data loaded automatically." : "Synced fresh real export from Unreal.");
    state.changeLog.unshift({
      time: new Date().toLocaleString(),
      title: isAuto ? "Auto-refreshed from Unreal" : "Synced from Unreal",
      body: `${snapshot.records.length} records loaded through UnrealMCP.`
    });
    return true;
  } catch (error) {
    const recovered = await recoverFromFetchResponseFailure(error, isAuto);
    if (recovered) return true;
    state.lastSyncError = error.message;
    setStatus(`${isAuto ? "Auto-refresh" : "Sync"} failed: ${error.message}. Cached data is still usable.`, "error");
    return false;
  } finally {
    el.syncButton.disabled = false;
    el.syncButton.textContent = "Sync From Unreal";
    renderAll();
  }
}

async function recoverFromFetchResponseFailure(error, isAuto) {
  try {
    const snapshot = await loadBestCachedExportSnapshot();
    if (!snapshot.records.length) return false;
    loadSnapshot(snapshot, `${isAuto ? "Auto-refresh" : "Sync"} response failed, but the latest cache loaded successfully.`);
    state.lastSyncError = "";
    state.changeLog.unshift({
      time: new Date().toLocaleString(),
      title: isAuto ? "Auto-refresh recovered from cache" : "Sync recovered from cache",
      body: `${snapshot.records.length} records loaded from the latest cache after bridge response failure: ${error.message}`
    });
    return true;
  } catch {
    return false;
  }
}

function parseBridgeJson(responseText) {
  try {
    return JSON.parse(responseText);
  } catch (error) {
    return {
      success: true,
      responseIncomplete: true,
      warning: `UnrealMCP response did not contain complete JSON: ${error.message}`
    };
  }
}

async function loadCachedExportSnapshot() {
  const response = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Refresh succeeded but cache reload failed: HTTP ${response.status}`);
  }
  return normalizeSnapshot(await response.json());
}

async function loadBestCachedExportSnapshot() {
  try {
    return await loadCachedExportSnapshot();
  } catch {
    return await loadBridgeCachedExportSnapshot();
  }
}

async function loadBridgeCachedExportSnapshot() {
  const records = [];
  let meta = null;
  let offset = 0;
  const limit = 750;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetchWithTimeout(`${getBridgeUrl()}/api/cache?offset=${offset}&limit=${limit}&t=${Date.now()}`, { method: "GET" }, 45000);
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    if (!meta) meta = payload.meta || {};
    records.push(...(payload.records || []));
    if (payload.nextOffset == null) break;
    offset = payload.nextOffset;
  }
  if (!records.length) throw new Error("Bridge cache returned no records");
  return normalizeSnapshot({ meta, records });
}

async function autoPrefetchIfNeeded(cacheLoaded) {
  if (state.autoRefreshAttempted || state.autoRefreshInFlight) return;
  if (!state.bridgeHealth?.success || !state.bridgeHealth?.unrealMcp?.success) {
    if (cacheLoaded) setStatus("Loaded cached data. UnrealMCP is unavailable, so auto-refresh is skipped.", "warn");
    return;
  }
  if (cacheLoaded && isCacheFreshEnough()) return;
  state.autoRefreshAttempted = true;
  state.autoRefreshInFlight = true;
  try {
    await syncFromUnreal({ auto: true });
  } finally {
    state.autoRefreshInFlight = false;
  }
}

function isCacheFreshEnough() {
  if (state.meta?.exportVersion !== REQUIRED_EXPORT_VERSION) return false;
  if (!cacheHasRequiredTypedFields()) return false;
  const exportedAt = Date.parse(state.meta?.exportedAt || "");
  if (!Number.isFinite(exportedAt)) return false;
  const ageHours = (Date.now() - exportedAt) / 3600000;
  return ageHours <= CACHE_MAX_AGE_HOURS;
}

function cacheHasRequiredTypedFields() {
  const recipes = state.views.filter((view) => view.kind === "recipe");
  const items = state.views.filter((view) => view.kind === "item");
  const typedRecipes = recipes.filter((view) => hasTypedRecipeData(view)).length;
  const typedItems = items.filter((view) => hasTypedItemData(view)).length;
  if (recipes.length && typedRecipes === 0) return false;
  if (items.length && typedItems === 0) return false;
  return true;
}

function loadSnapshot(snapshot, statusText) {
  state.records = snapshot.records;
  state.meta = snapshot.meta;
  buildViewModels();
  state.validation = validateViews();
  if (!state.selectedId && state.views.length) {
    const preferred = state.views.find((view) => view.kind === "item") || state.views[0];
    state.selectedId = preferred.id;
  }
  setStatus(statusText, "ok");
}

function normalizeSnapshot(input) {
  const records = Array.isArray(input?.records) ? input.records : [];
  return {
    meta: input?.meta || {
      projectName: "Towers",
      exportedAt: "",
      sourceKind: "unknown",
      sourceSummary: "No metadata"
    },
    records: records.map((record) => ({
      id: String(record.id || record.source?.assetPath || cryptoRandomId()),
      category: String(record.category || "All Records"),
      displayName: cleanName(record.displayName || record.fields?.assetName || record.source?.assetPath || "Unnamed"),
      description: String(record.description || ""),
      tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
      source: record.source || {},
      fields: record.fields || {},
      relationships: record.relationships || { usedBy: [], dependsOn: [] },
      editableFields: Array.isArray(record.editableFields) ? record.editableFields : [],
      warnings: Array.isArray(record.warnings) ? record.warnings : [],
      notes: record.notes || ""
    }))
  };
}

function buildViewModels() {
  state.byId = new Map();
  state.byPath = new Map();
  state.records.forEach((record) => {
    state.byId.set(record.id, record);
    if (record.source?.assetPath) {
      state.byPath.set(record.source.assetPath, record);
      state.byPath.set(normalizeAssetRef(record.source.assetPath), record);
    }
  });

  const baseViews = state.records.map((record) => toViewModel(record));
  const rawItemViews = baseViews.filter((view) => view.kind === "item");
  const recipeViews = baseViews.filter((view) => view.kind === "recipe");
  const stationViews = baseViews.filter((view) => view.kind === "station");

  recipeViews.forEach((recipe) => {
    recipe.outputItems = recipe.recipeOutputs
      .map((output) => ({ ...output, view: resolveItemRef(output.ref, rawItemViews) }))
      .filter((output) => output.view);
    recipe.ingredientItems = recipe.recipeIngredients
      .map((ingredient) => ({ ...ingredient, view: resolveItemRef(ingredient.ref, rawItemViews) }))
      .filter((ingredient) => ingredient.view);
    recipe.outputItem = recipe.outputItems[0]?.view || guessOutputItem(recipe, rawItemViews);
    recipe.relatedItems = recipe.ingredientItems.map((ingredient) => ingredient.view);
    if (!recipe.relatedItems.length) recipe.relatedItems = guessRelatedItems(recipe, rawItemViews);
  });
  rawItemViews.forEach((item) => {
    item.producedBy = recipeViews.filter((recipe) => recipe.outputItem?.id === item.id);
    item.usedByRecipes = recipeViews.filter((recipe) => recipe.relatedItems.some((candidate) => candidate.id === item.id));
    item.useCount = item.producedBy.length + item.usedByRecipes.length;
  });

  buildCraftingContext(recipeViews, stationViews);
  const groupedItemViews = groupItemVariants(rawItemViews, recipeViews);
  const rawToGroup = new Map();
  groupedItemViews.forEach((group) => group.variants.forEach((variant) => rawToGroup.set(variant.id, group)));
  recipeViews.forEach((recipe) => {
    recipe.outputItems = collapseRecipeItemLinks(recipe.outputItems, rawToGroup);
    recipe.ingredientItems = collapseRecipeItemLinks(recipe.ingredientItems, rawToGroup);
    recipe.outputItem = recipe.outputItems[0]?.view || null;
    recipe.relatedItems = uniqueViews(recipe.ingredientItems.map((ingredient) => ingredient.view).filter(Boolean));
  });
  groupedItemViews.forEach((item) => {
    item.producedBy = recipeViews.filter((recipe) => recipe.outputItem?.id === item.id);
    item.usedByRecipes = recipeViews.filter((recipe) => recipe.relatedItems.some((candidate) => candidate.id === item.id));
    item.useCount = item.producedBy.length + item.usedByRecipes.length;
  });

  state.views = [...baseViews.filter((view) => view.kind !== "item"), ...groupedItemViews];
  groupedItemViews.forEach((view) => state.byId.set(view.id, view.record));
}

function buildCraftingContext(recipeViews, stationViews) {
  const recipesByPath = new Map(recipeViews.map((recipe) => [normalizeAssetRef(recipe.path), recipe]));
  const recipeLists = stationViews.filter((view) => view.primary.includes("RecipeList"));
  const managers = stationViews.filter((view) => view.primary.includes("CraftingManager"));
  const listsByAssetName = new Map(recipeLists.map((list) => [assetNameFromPath(list.path), list]));

  recipeViews.forEach((recipe) => {
    recipe.recipeLists = [];
    recipe.stationManagers = [];
    recipe.stationContext = [];
  });

  recipeLists.forEach((list) => {
    list.listRecipes = normalizeAssetList(list.recipeData.craftingListEntries)
      .map((ref) => recipesByPath.get(normalizeAssetRef(ref)))
      .filter(Boolean);
    list.listLabel = recipeListLabel(list);
    list.listRecipes.forEach((recipe) => {
      recipe.recipeLists.push(list);
      recipe.stationContext.push(list.listLabel);
    });
  });

  managers.forEach((manager) => {
    const listName = primaryAssetName(manager.recipeData.craftingRecipeListDataAsset);
    const list = listsByAssetName.get(listName);
    manager.managerLabel = cleanStationLabel(manager.name);
    if (!list) return;
    manager.recipeList = list;
    list.manager = manager;
    list.listRecipes.forEach((recipe) => {
      recipe.stationManagers.push(manager);
      recipe.stationContext.unshift(manager.managerLabel);
    });
  });

  recipeViews.forEach((recipe) => {
    const fallback = recipe.station && recipe.station !== "Recipes" && recipe.station !== "Unassigned" ? [recipe.station] : [];
    const labels = unique([...recipe.stationContext, ...fallback]).filter(Boolean);
    recipe.stationContext = labels.length ? labels : ["Station known; building owner not exported yet"];
    recipe.station = recipe.stationContext.join(", ");
  });
}

function groupItemVariants(rawItemViews, recipeViews) {
  const groups = new Map();
  rawItemViews.forEach((item) => {
    const key = `${item.itemFamily.toLowerCase()}::${item.name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  return [...groups.values()].map((variants) => {
    const canonical = chooseCanonicalVariant(variants);
    const grouped = {
      ...canonical,
      id: variants.length > 1 ? `ITEMGROUP:${canonical.itemFamily}:${canonical.name}` : canonical.id,
      record: canonical.record,
      variants,
      canonicalVariant: canonical,
      isGroupedItem: variants.length > 1,
      path: canonical.path,
      fields: canonical.fields,
      itemData: canonical.itemData,
      recipeData: canonical.recipeData,
      description: canonical.description,
      tags: unique(variants.flatMap((variant) => variant.tags)),
      warnings: uniqueWarnings(variants.flatMap((variant) => variant.warnings || [])),
      producedBy: uniqueViews(variants.flatMap((variant) => variant.producedBy)),
      usedByRecipes: uniqueViews(variants.flatMap((variant) => variant.usedByRecipes)),
      relatedItems: [],
      outputItems: [],
      ingredientItems: [],
      outputItem: null
    };
    grouped.useCount = grouped.producedBy.length + grouped.usedByRecipes.length;
    grouped.variantCount = variants.length;
    grouped.variantStatus = variantStatus(canonical, grouped);
    return grouped;
  });
}

function chooseCanonicalVariant(variants) {
  return [...variants].sort((a, b) => {
    const aScore = variantScore(a);
    const bScore = variantScore(b);
    return bScore - aScore || a.path.length - b.path.length || a.id.localeCompare(b.id);
  })[0];
}

function variantScore(variant) {
  let score = 0;
  if (variant.producedBy.length) score += 100;
  if (variant.usedByRecipes.length) score += 25;
  if (hasTypedItemData(variant)) score += 10;
  if (!/test|debug|cheat/i.test(variant.path)) score += 5;
  if (!/[A-Z]$/.test(assetNameFromPath(variant.path))) score += 2;
  return score;
}

function collapseRecipeItemLinks(items, rawToGroup) {
  const seen = new Set();
  const collapsed = [];
  items.forEach((item) => {
    const group = rawToGroup.get(item.view?.id);
    if (!group || seen.has(group.id)) return;
    seen.add(group.id);
    collapsed.push({ ...item, rawView: item.view, view: group });
  });
  return collapsed;
}

function normalizeAssetList(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => typeof item === "string" ? item : Object.values(item || {}).join(" ")).filter(Boolean);
}

function primaryAssetName(value) {
  const match = String(value || "").match(/primary_asset_name:\s*"([^"]+)"/i);
  return match ? match[1] : "";
}

function recipeListLabel(list) {
  return cleanStationLabel(list.name.replace(/^DA_?/i, "").replace(/^RecipeList_?/i, ""));
}

function cleanStationLabel(value) {
  return cleanName(value).replace(/^RecipeList\s*/i, "").replace(/^CRFTManager Config\s*/i, "").trim() || "Station known";
}

function assetNameFromPath(path) {
  return String(path || "").split("/").pop() || "";
}

function uniqueViews(views) {
  const seen = new Set();
  return views.filter((view) => {
    if (!view || seen.has(view.id)) return false;
    seen.add(view.id);
    return true;
  });
}

function uniqueWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.type || ""}:${warning.message || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function variantStatus(variant, group) {
  if (variant.producedBy.length) return "Recipe-backed";
  if (variant.usedByRecipes.length) return "Used as ingredient";
  if (group?.producedBy?.length) return "Variant without recipe";
  if (hasTypedItemData(variant)) return "No known source";
  return "Source data not exported";
}

function toViewModel(record) {
  const path = record.source?.assetPath || "";
  const primary = record.source?.primaryAssetType || record.fields?.primaryAssetType || "";
  const type = record.source?.assetType || record.fields?.assetClass || "Unknown";
  const category = record.category;
  const kind = inferKind(record, primary, path);
  const name = cleanName(record.displayName || record.fields?.assetName || path.split("/").pop());
  const station = inferStation(record, path, primary);
  const group = inferRecipeGroup(path, name, primary);
  const itemFamily = inferItemFamily(path, name, primary);
  const tier = inferTier(path, name);
  const note = state.notes[record.id] || "";
  const recipeData = normalizeRecipeFields(record.fields?.recipe || {});
  const itemData = normalizeItemFields(record.fields?.item || {});
  const merchantData = record.fields?.merchant || {};
  const creatureData = normalizeCreatureFields(record, path, name, primary, type);
  const questData = normalizeQuestFields(record, path, name, primary, type);
  const ecosystemData = normalizeEcosystemFields(record, path, name, primary, type);
  const buildingData = normalizeBuildingFields(record, path, name, primary, type, itemData);
  return {
    id: record.id,
    record,
    kind,
    category,
    name,
    description: record.description || humanizeDescription(record, kind),
    path,
    type,
    primary,
    station,
    group,
    itemFamily,
    tier,
    tags: [...new Set([...(record.tags || []), kind, primary, station].filter(Boolean))],
    warnings: record.warnings || [],
    fields: record.fields || {},
    recipeData,
    itemData,
    merchantData,
    creatureData,
    questData,
    ecosystemData,
    buildingData,
    recipeOutputs: recipeData.outputs,
    recipeIngredients: recipeData.ingredients,
    note,
    producedBy: [],
    usedByRecipes: [],
    relatedItems: [],
    outputItems: [],
    ingredientItems: [],
    outputItem: null,
    useCount: 0
  };
}

function inferKind(record, primary, path) {
  const text = `${record.category} ${primary} ${path} ${record.source?.assetType || ""}`.toLowerCase();
  if (primary === "CraftingRecipe" || text.includes("/crafting/recipes/")) return "recipe";
  if (primary.includes("RecipeList") || primary.includes("CraftingManager") || text.includes("station")) return "station";
  if (record.category === "Items / Resources" || primary.includes("ItemDefinition") || primary.includes("HarvestResource")) return "item";
  if (record.category === "Creatures" || text.includes("creature") || text.includes("aicharacter")) return "creature";
  if (record.category === "Quests" || text.includes("quest")) return "quest";
  if (record.category === "Biomes / Ecosystems" || text.includes("ecosystem") || text.includes("plant") || text.includes("biome")) return "ecosystem";
  if (record.category === "Spawner Values" || text.includes("spawn")) return "spawner";
  if (record.category === "Villages / Buildings" || text.includes("building")) return "building";
  if (record.category === "Loot Tables" || text.includes("loot")) return "loot";
  if (record.category === "Progression / Unlocks" || text.includes("unlock") || text.includes("progress")) return "progression";
  if (record.category === "Data Tables") return "datatable";
  return "record";
}

function inferStation(record, path, primary) {
  const parts = path.split("/").filter(Boolean);
  if (primary.includes("CraftingManager")) return "Crafting Manager";
  if (primary.includes("RecipeList")) return cleanName(parts[parts.length - 2] || "Recipe List");
  if (path.includes("/Crafting/Recipes/")) return cleanName(parts[parts.length - 2] || "General Crafting");
  if (path.includes("/Buildings/")) return cleanName(parts[parts.length - 2] || "Building");
  return "Unassigned";
}

function inferRecipeGroup(path, name, primary) {
  const parts = path.split("/").filter(Boolean);
  if (primary.includes("CraftingManager")) return "Crafting Managers";
  if (primary.includes("RecipeList")) return "Recipe Lists";
  if (path.includes("/ItemDefinitions/") && path.includes("/Recipe/")) return "Recipe Unlock Items";
  if (path.includes("/Buildings/")) return "Buildings";

  const recipeIndex = parts.findIndex((part) => part.toLowerCase() === "recipes");
  if (recipeIndex >= 0 && parts[recipeIndex + 1]) {
    const candidate = parts[recipeIndex + 1];
    if (!looksLikeAssetName(candidate)) return cleanName(candidate);
    const stationName = inferRecipeGroupFromStation(path);
    if (stationName) return stationName;
    return inferRecipeFamilyFromName(name);
  }
  if (path.includes("/ItemDefinitions/")) return "Items";
  return "General";
}

function inferItemFamily(path, name, primary) {
  const parts = path.split("/").filter(Boolean);
  const itemIndex = parts.findIndex((part) => part.toLowerCase() === "itemdefinitions");
  if (itemIndex >= 0 && parts[itemIndex + 1]) return cleanName(parts[itemIndex + 1]);
  if (path.includes("/Harvesting/") || primary.includes("Harvest")) return "Harvesting";
  if (primary.includes("ItemAbility")) return "Ability";
  if (primary.includes("MeleeWeapon")) return "Equipment";
  if (primary.includes("Merchant")) return "Merchant";
  if (/recipeunlock/i.test(name)) return "Recipe Unlock";
  return cleanName(primary || "Items");
}

function normalizeCreatureFields(record, path, name, primary, type) {
  const text = `${path} ${name} ${primary} ${type}`;
  return {
    family: inferCreatureFamily(path, name, primary, type),
    role: inferCreatureRole(text),
    biome: inferBiomeLabel(text),
    temperament: inferTemperament(text),
    combat: primary.includes("CombatProfile") || type.includes("CombatProfile") ? "Combat profile" : "Needs typed combat export",
    spawns: "Spawner links need typed spawner/entity export",
    rewards: "Drops/resources need typed loot or harvest export",
    abilityVfx: inferAbilityVfxLabel(primary, type)
  };
}

function normalizeQuestFields(record, path, name, primary, type) {
  const text = `${path} ${name} ${primary} ${type}`;
  return {
    group: text.toLowerCase().includes("questnpc") ? "Quest NPC" : text.toLowerCase().includes("abilit") ? "Quest Ability Setup" : "Quest Source",
    npc: text.toLowerCase().includes("sprite") ? "Sprite" : "Quest NPC not exported",
    requirements: "Quest requirements not exported yet",
    objectives: "Quest objective steps not exported yet",
    rewards: "Quest rewards not exported yet",
    unlocks: "Quest progression tags not exported yet",
    sourceState: "Quest source not exported yet"
  };
}

function normalizeEcosystemFields(record, path, name, primary, type) {
  const text = `${path} ${name} ${primary} ${type}`;
  const group = inferEcosystemGroup(text);
  return {
    group,
    biome: inferBiomeLabel(text),
    growth: inferEcosystemGrowth(text, group),
    outputs: inferEcosystemOutputs(text, group),
    usedBy: inferEcosystemUsage(text, group),
    issue: inferEcosystemIssue(record, group)
  };
}

function normalizeBuildingFields(record, path, name, primary, type, itemData) {
  const text = `${path} ${name} ${primary} ${type}`;
  return {
    group: inferBuildingGroup(text),
    villageSet: inferVillageSet(text),
    functionLabel: inferBuildingFunction(text, itemData),
    recipeCost: "Recipe/cost visible when placeable item has a matched recipe",
    upgradeRepair: inferUpgradeRepair(text),
    placement: "Footprint and placement rules need typed building export",
    status: inferBuildingStatus(record, text)
  };
}

function inferCreatureFamily(path, name, primary, type) {
  const source = primary.includes("CombatProfile") || type.includes("CombatProfile") ? assetNameFromPath(path) : (name || assetNameFromPath(path));
  const cleaned = cleanName(source)
    .replace(/\b(Abilities|Initial|AI|AICombatProfile|ProceduralCreature|Combat Profile|Ecosystem Creature|CreatureVFX|VFX|Asset|DA|BP)\b/gi, " ")
    .replace(/\b(x\d+|Temperate|Tropical|Arid|Dry|Common|Uncommon|Rare)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Creature";
}

function inferCreatureRole(text) {
  const lower = text.toLowerCase();
  if (lower.includes("combatprofile")) return "Combat";
  if (lower.includes("vfx") || lower.includes("fx")) return "VFX";
  if (lower.includes("abilit")) return "Ability setup";
  if (lower.includes("config")) return "Configuration";
  return "Creature data";
}

function inferTemperament(text) {
  const lower = text.toLowerCase();
  if (lower.includes("hostile") || lower.includes("combat") || lower.includes("aggressive")) return "Aggressive / combat";
  if (lower.includes("passive") || lower.includes("ambient")) return "Passive / ambient";
  return "Needs typed AI export";
}

function inferAbilityVfxLabel(primary, type) {
  if (`${primary} ${type}`.includes("Ability")) return "Ability config indexed";
  if (`${primary} ${type}`.includes("VFX") || `${primary} ${type}`.includes("FX")) return "VFX config indexed";
  return "Ability/VFX links need typed export";
}

function inferEcosystemGroup(text) {
  const lower = text.toLowerCase();
  if (lower.includes("seed") || lower.includes("crop")) return "Seeds / Crops";
  if (lower.includes("growthevent")) return "Growth Events";
  if (lower.includes("withered") || lower.includes("corruption")) return "Withered / Corruption";
  if (lower.includes("fog") || lower.includes("atmos") || lower.includes("environment")) return "Environment";
  if (lower.includes("preview")) return "Placeable Previews";
  if (lower.includes("plant") || lower.includes("tree") || lower.includes("crystal")) return "Plants";
  return "Ecosystem Data";
}

function inferBiomeLabel(text) {
  const lower = text.toLowerCase();
  const labels = [];
  if (lower.includes("temperate")) labels.push("Temperate");
  if (lower.includes("tropical")) labels.push("Tropical");
  if (lower.includes("arid")) labels.push("Arid");
  if (lower.includes("dry")) labels.push("Dry");
  if (lower.includes("strange")) labels.push("Strange");
  return labels.length ? labels.join(", ") : "Biome not exported";
}

function inferEcosystemGrowth(text, group) {
  if (group === "Growth Events") return "Growth event config indexed";
  if (group === "Seeds / Crops" || group === "Plants") return "Growth timing needs typed ecosystem export";
  if (group === "Withered / Corruption") return "Wither rules need typed ecosystem export";
  return "Growth/spawn data not exported yet";
}

function inferEcosystemOutputs(text, group) {
  if (group === "Seeds / Crops") return "Seed/crop outputs need item graph links";
  if (group === "Plants") return "Harvest outputs need typed plant export";
  if (group === "Placeable Previews") return "Preview only";
  return "Outputs not exported yet";
}

function inferEcosystemUsage(text, group) {
  if (group === "Placeable Previews") return "Used by building placement previews";
  if (group === "Environment") return "Used by world/environment tuning";
  return "Usage links need typed references";
}

function inferEcosystemIssue(record, group) {
  if (group === "Placeable Previews") return "Preview-only record";
  if (record.warnings?.length) return "Needs typed ecosystem export";
  return "Indexed";
}

function inferBuildingGroup(text) {
  const lower = text.toLowerCase();
  if (lower.includes("itemdefinitions/placeable/building")) return "Placeable Building Items";
  if (lower.includes("/decoration/")) return "Decoration";
  if (lower.includes("broken")) return "Broken / Repair";
  if (lower.includes("citadel")) return "Citadel";
  if (lower.includes("questlocations")) return "Quest Locations";
  if (lower.includes("uniqueecos")) return "Unique Ecosystem";
  if (lower.includes("portal")) return "Portals";
  if (lower.includes("village")) return "Village Sets";
  if (lower.includes("todelete")) return "To Delete / Review";
  return "Building Configs";
}

function inferVillageSet(text) {
  const lower = text.toLowerCase();
  const sets = ["Citadel", "Farm", "Mining", "Bathhouse", "Shrine", "Artisan", "Construction", "Campfire"];
  return sets.filter((label) => lower.includes(label.toLowerCase())).join(", ") || "Village set not exported";
}

function inferBuildingFunction(text, itemData) {
  if (itemData?.stationName) return itemData.stationName;
  const lower = text.toLowerCase();
  if (lower.includes("craftingtable")) return "Construction / crafting";
  if (lower.includes("blacksmith") || lower.includes("anvil")) return "Crafting station";
  if (lower.includes("merchant")) return "Merchant";
  if (lower.includes("quest")) return "Quest location";
  if (lower.includes("decoration") || lower.includes("deco")) return "Decoration";
  return "Function needs typed building export";
}

function inferUpgradeRepair(text) {
  const lower = text.toLowerCase();
  if (lower.includes("broken")) return "Repair variant indexed";
  if (lower.includes("upgrade")) return "Upgrade variant indexed";
  return "Upgrade/repair chain not exported yet";
}

function inferBuildingStatus(record, text) {
  if (text.toLowerCase().includes("todelete")) return { label: "Review / To Delete", tone: "warn" };
  if (record.warnings?.length) return { label: "Needs typed building export", tone: "warn" };
  return { label: "Indexed", tone: "info" };
}

function looksLikeAssetName(value) {
  const text = String(value || "");
  return /^(DA_|BP_|WBP_|DT_|CRFT_|Recipe_?)/i.test(text) || text.includes(".");
}

function inferRecipeGroupFromStation(path) {
  const parts = path.split("/").filter(Boolean);
  const recipesIndex = parts.findIndex((part) => part.toLowerCase() === "recipes");
  const parent = recipesIndex > 0 ? cleanName(parts[recipesIndex - 1]) : "";
  if (parent && !["Crafting", "DataAssets", "Data"].includes(parent)) return parent;
  return "";
}

function inferRecipeFamilyFromName(name) {
  const words = cleanName(name).split(/\s+/).filter(Boolean);
  const recipeIndex = words.findIndex((word) => word.toLowerCase() === "recipe");
  const start = recipeIndex >= 0 ? recipeIndex + 1 : 0;
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (/^(crft|cvrt)$/i.test(word) || /^(common|uncommon|rare|epic|legendary|basic)$/i.test(word)) continue;
    if (/^t\d+$/i.test(word) || /^tier\d+$/i.test(word)) continue;
    return word;
  }
  return "General Crafting";
}

function inferTier(path, name) {
  const text = `${path} ${name}`.toLowerCase();
  const tierMatch = text.match(/tier[_\s-]?(\d+)/i);
  if (tierMatch) return `Tier ${tierMatch[1]}`;
  if (text.includes("basic") || text.includes("common")) return "Early";
  if (text.includes("rare") || text.includes("advanced")) return "Mid";
  if (text.includes("epic") || text.includes("legendary")) return "Late";
  return "Unrated";
}

function normalizeRecipeFields(recipeFields) {
  const outputs = normalizeRecipeItems(recipeFields.RewardItemInfos || [], "CraftedItemDefinition", "CraftedItemCount");
  const ingredients = normalizeRecipeItems(recipeFields.RecipeRequirementsInfo || [], "IngredientItemDefinition", "RequiredCount");
  const overrideIngredients = normalizeRecipeItems(recipeFields.OverrideIngredientInfo || [], "IngredientItemDefinition", "RequiredCount");
  return {
    outputs,
    ingredients,
    overrideIngredients,
    processingTime: scalarDisplay(recipeFields.ProcessingTime),
    rewardXp: scalarDisplay(recipeFields.RewardXp),
    configFlags: recipeFields.ConfigFlags,
    unlockedByDefault: recipeFields.bIsUnlockedByDefault,
    showRewardAsUnlock: recipeFields.bDoesShowRewardAsUnlockNotification,
    identityTag: recipeFields.RecipeIdentityTag,
    filterTag: recipeFields.RecipeFilterTag,
    craftingListEntries: recipeFields.CraftingListEntries || [],
    craftingRecipeListDataAsset: recipeFields.CraftingRecipeListDataAsset || ""
  };
}

function formatRecipeItemList(items, fallback) {
  if (!items.length) return fallback;
  return items.map((item) => {
    const count = item.count !== "" && item.count != null ? `${item.count} x ` : "";
    const label = item.view ? item.view.name : item.label;
    return `${count}${label}`;
  }).join(", ");
}

function renderRecipeItemLinks(items, fallback) {
  if (!items.length) return escapeHtml(fallback);
  return items.map((item) => {
    const count = item.count !== "" && item.count != null ? `<span class="mini-count">${escapeHtml(item.count)}x</span>` : "";
    const label = item.view ? item.view.name : item.label;
    return item.view
      ? `<span class="linked-amount">${count}${linkButton(item.view, label)}</span>`
      : `<span class="chip">${count}${escapeHtml(label)}</span>`;
  }).join(" ");
}

function firstProducerRecipe(view) {
  return view.producedBy[0] || null;
}

function recipeOutputForItem(recipe, itemView) {
  if (!recipe || !itemView) return null;
  return recipe.outputItems.find((item) => item.view?.id === itemView.id) || null;
}

function hasTypedRecipeData(recipe) {
  if (!recipe) return false;
  return Boolean(
    recipe.recipeOutputs.length ||
    recipe.recipeIngredients.length ||
    recipe.recipeData.processingTime ||
    recipe.recipeData.configFlags ||
    recipe.record?.fields?.typedExport
  );
}

function hasTypedItemData(view) {
  const item = view.itemData || {};
  return Boolean(
    item.maxStackSize ||
    item.scrapAmount ||
    item.itemValue ||
    item.rarity ||
    item.itemTypeName ||
    item.stationName ||
    item.identityTag ||
    item.ownedTags ||
    view.record?.fields?.typedExport
  );
}

function normalizeRecipeItems(items, itemKey, countKey) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      ref: item?.[itemKey] || "",
      count: item?.[countKey] ?? "",
      label: cleanName(item?.[itemKey] || "")
    }))
    .filter((item) => item.ref || item.label);
}

function normalizeItemFields(itemFields) {
  const ui = itemFields.UIData || {};
  return {
    itemName: itemFields.ItemName,
    itemDescription: itemFields.ItemDescription,
    tipDescription: itemFields.ItemTipDescription,
    maxStackSize: itemFields.MaxStackSize,
    scrapAmount: itemFields.ScrapAmount,
    itemValue: itemFields.ItemDescriptionValue,
    requiredToolTag: itemFields.RequiredToolTag,
    identityTag: itemFields.IdentityTag,
    ownedTags: itemFields.OwnedTags,
    questTags: itemFields.QuestTags,
    rarity: ui.ItemRarityType || itemFields.Rarity,
    itemTypeName: ui.ItemTypeName,
    stationName: ui.StationName,
    icon: ui.ItemIconSprite
  };
}

function scalarDisplay(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function displayOrPending(value, label = "Needs typed export") {
  return value === "" || value == null ? label : escapeHtml(value);
}

function normalizeAssetRef(value) {
  let text = String(value || "").trim();
  text = text.replace(/^[A-Za-z]+(?:GeneratedClass)?'/, "").replace(/'$/, "");
  text = text.replace(/^Class'/, "").replace(/^BlueprintGeneratedClass'/, "");
  const objectMatch = text.match(/(\/Game\/[^'\s]+)/);
  if (objectMatch) text = objectMatch[1];
  text = text.replace(/\.[^/.]+_C$/, "").replace(/\.[^/.]+$/, "").replace(/_C$/, "");
  return text;
}

function resolveItemRef(ref, itemViews) {
  const normalized = normalizeAssetRef(ref);
  if (!normalized) return null;
  return itemViews.find((item) => normalizeAssetRef(item.path) === normalized) || null;
}

function guessOutputItem(recipe, items) {
  const recipeTokens = tokenSet(recipe.name);
  const pathTokens = tokenSet(recipe.path);
  let best = null;
  let bestScore = 0;
  items.forEach((item) => {
    const itemTokens = tokenSet(item.name);
    let score = overlapScore(recipeTokens, itemTokens) * 3 + overlapScore(pathTokens, itemTokens);
    if (recipe.name.toLowerCase().includes(item.name.toLowerCase())) score += 8;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  });
  return bestScore >= 4 ? best : null;
}

function guessRelatedItems(recipe, items) {
  const textTokens = tokenSet(`${recipe.name} ${recipe.path}`);
  return items
    .map((item) => ({ item, score: overlapScore(textTokens, tokenSet(item.name)) }))
    .filter((entry) => entry.score >= 2 && entry.item.id !== recipe.outputItem?.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((entry) => entry.item);
}

function validateViews() {
  const issues = [];
  const recipes = state.views.filter((view) => view.kind === "recipe");
  const items = state.views.filter((view) => view.kind === "item");
  recipes.forEach((recipe) => {
    if (!recipe.outputItem) {
      issues.push(issue("warn", recipe, "Recipe output not resolved", "Typed recipe details are not loaded yet; output was inferred from the asset name/path."));
    }
    if (recipe.station === "Unassigned") {
      issues.push(issue("warn", recipe, "Recipe station unknown", "Station/list ownership was not resolved from the registry path."));
    }
    if (!recipe.description) {
      issues.push(issue("info", recipe, "Missing description", "Add a designer-facing description when the typed exporter exposes this field."));
    }
  });
  items.filter((item) => item.useCount === 0).slice(0, 250).forEach((item) => {
    issues.push(issue("info", item, "No relationship found", "This item was not matched to a recipe by the current registry-level relationship pass."));
  });
  state.views.forEach((view) => {
    if (view.warnings.some((warning) => warning.type === "no_safe_fields_exported")) {
      issues.push(issue("info", view, "Values not loaded", "This record is indexed from Asset Registry only. Add a typed exporter for editable values."));
    }
  });
  return issues;
}

function issue(level, view, title, body) {
  return { level, viewId: view.id, title, body, category: view.category, name: view.name };
}

function renderSkeleton() {
  renderCategoryNav();
  CATEGORY_CONFIG.forEach(([value, label]) => {
    el.categoryFilter.add(new Option(label, value));
  });
  el.categoryFilter.add(new Option("All", "All"), 0);
  el.categoryFilter.value = "All";
}

function renderAll() {
  renderCategoryNav();
  renderFilterOptions();
  renderHeader();
  renderDashboard();
  renderRecords();
  renderDetail();
  renderDrawer();
}

function renderCategoryNav() {
  const counts = countByCategory();
  el.categoryNav.innerHTML = CATEGORY_CONFIG.map(([category, label]) => {
    const specialCount = countSpecialCategory(category);
    const count = category === "Dashboard" ? state.views.length : (specialCount || counts.get(category) || 0);
    return `
      <button class="nav-button ${state.activeCategory === category ? "active" : ""}" data-category="${escapeAttr(category)}" type="button">
        <span>${escapeHtml(label)}</span>
        <span class="nav-count">${count}</span>
      </button>
    `;
  }).join("");
  el.categoryNav.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCategory = button.dataset.category;
      state.filters.category = "All";
      renderAll();
    });
  });
}

function renderFilterOptions() {
  let groupValues = ["All"];
  if (state.activeCategory === "Recipes / Crafting") {
    groupValues = ["All", ...unique(state.views.filter((view) => view.kind === "recipe").map((view) => view.group)).sort()];
    el.categoryFilterLabel.textContent = "Recipe category";
    el.typeFilterLabel.textContent = "Recipe asset type";
    el.stationFilterLabel.textContent = "Station / list";
  } else if (state.activeCategory === "Items / Resources") {
    groupValues = ["All", ...unique(state.views.filter((view) => view.kind === "item").map((view) => view.itemFamily)).sort()];
    el.categoryFilterLabel.textContent = "Item family";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "Used or made at";
  } else if (state.activeCategory === "Creatures") {
    groupValues = ["All", ...unique(filteredByActiveCategory(false).map((view) => view.creatureData.family)).sort()];
    el.categoryFilterLabel.textContent = "Creature family";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "Biome / ecosystem";
  } else if (state.activeCategory === "Quests") {
    groupValues = ["All", ...unique(filteredByActiveCategory(false).map((view) => view.questData.group)).sort()];
    el.categoryFilterLabel.textContent = "Quest source";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "NPC / location";
  } else if (state.activeCategory === "Biomes / Ecosystems") {
    groupValues = ["All", ...unique(filteredByActiveCategory(false).map((view) => view.ecosystemData.group)).sort()];
    el.categoryFilterLabel.textContent = "Ecosystem group";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "Biome";
  } else if (state.activeCategory === "Villages / Buildings") {
    groupValues = ["All", ...unique(filteredByActiveCategory(false).map((view) => view.buildingData.group)).sort()];
    el.categoryFilterLabel.textContent = "Building group";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "Village set";
  } else {
    groupValues = ["All", ...unique(filteredByActiveCategory(false).map((view) => view.category)).sort()];
    el.categoryFilterLabel.textContent = "Category";
    el.typeFilterLabel.textContent = "Data type";
    el.stationFilterLabel.textContent = "Station / list";
  }
  const types = unique(filteredByActiveCategory(false).map((view) => view.primary || view.type || view.kind)).sort();
  let stations = unique(state.views.filter((view) => view.kind === "recipe" || view.kind === "station").map((view) => view.station)).sort();
  if (state.activeCategory === "Creatures") stations = unique(filteredByActiveCategory(false).map((view) => view.creatureData.biome)).sort();
  if (state.activeCategory === "Quests") stations = unique(filteredByActiveCategory(false).map((view) => view.questData.npc)).sort();
  if (state.activeCategory === "Biomes / Ecosystems") stations = unique(filteredByActiveCategory(false).map((view) => view.ecosystemData.biome)).sort();
  if (state.activeCategory === "Villages / Buildings") stations = unique(filteredByActiveCategory(false).map((view) => view.buildingData.villageSet)).sort();
  refillSelect(el.categoryFilter, groupValues, state.filters.category);
  refillSelect(el.typeFilter, ["All", ...types], state.filters.type);
  refillSelect(el.stationFilter, ["All", ...stations], state.filters.station);
}

function renderHeader() {
  const total = state.views.length;
  const recipes = state.views.filter((view) => view.kind === "recipe").length;
  const items = state.views.filter((view) => view.kind === "item").length;
  const selected = getSelectedView();
  const exported = state.meta?.exportedAt ? new Date(state.meta.exportedAt).toLocaleString() : "No export";
  el.sourceSummary.textContent = state.meta ? `${total} records - ${exported}` : "No real export loaded";
  el.quickStats.innerHTML = [
    stat("Records", total),
    stat("Recipes", recipes),
    stat("Items", items),
    stat("Issues", state.validation.length)
  ].join("");
  const activeLabel = CATEGORY_CONFIG.find(([category]) => category === state.activeCategory)?.[1] || state.activeCategory;
  el.viewTitle.textContent = activeLabel;
  el.viewSubtitle.textContent = subtitleForActiveView(selected);
}

function renderDashboard() {
  const views = filteredByActiveCategory(false);
  const metrics = dashboardMetrics(views);
  el.dashboard.innerHTML = metrics.map((metric) => `
    <div class="metric-card">
      <span class="metric-value">${escapeHtml(metric.value)}</span>
      <span>${escapeHtml(metric.label)}</span>
    </div>
  `).join("");
}

function renderRecords() {
  const views = filteredViews();
  el.recordCount.textContent = `${views.length}`;
  if (!views.length) {
    el.recordsList.innerHTML = `<div class="empty-state"><h3>No matching records</h3><p>Try a broader query or clear filters.</p></div>`;
    return;
  }
  if (!views.some((view) => view.id === state.selectedId)) {
    state.selectedId = views[0].id;
  }
  if (state.activeCategory === "Items / Resources") {
    renderItemSections(views);
    return;
  }
  if (state.activeCategory === "Recipes / Crafting") {
    renderRecipeSections(views);
    return;
  }
  if (isDesignerDomainCategory(state.activeCategory)) {
    renderDesignerDomainSections(views);
    return;
  }
  el.recordsList.innerHTML = views.slice(0, 700).map((view) => renderRecordCard(view)).join("");
  el.recordsList.querySelectorAll(".record-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id;
      renderAll();
    });
  });
}

function renderRecipeSections(views) {
  const groups = groupViews(views, (view) => view.group || "General");
  const index = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, items]) => `<button class="chip-button ${state.filters.category === group ? "active" : ""}" data-recipe-group="${escapeAttr(group)}" type="button">${escapeHtml(group)} ${items.length}</button>`)
    .join("");
  const sections = Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, items]) => renderRecipeSection(group, items))
    .join("");
  el.recordsList.innerHTML = `<div class="category-index">${index}</div>${sections}`;
  el.recordsList.querySelectorAll("[data-recipe-group]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.category = button.dataset.recipeGroup;
      renderAll();
    });
  });
  el.recordsList.querySelectorAll(".recipe-row[data-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      renderAll();
    });
  });
}

function renderRecipeSection(group, items) {
  const stations = unique(items.map((view) => view.station)).slice(0, 4).join(", ");
  return `
    <section class="recipe-section">
      <div class="recipe-section-header">
        <div>
          <h3>${escapeHtml(group)}</h3>
          <p>${escapeHtml(stations || "No station/list resolved yet")}</p>
        </div>
        <span class="count-pill">${items.length} recipes</span>
      </div>
      <div class="recipe-table">
        <div class="recipe-row header">
          <span>Recipe</span>
          <span>Output</span>
          <span>Ingredients</span>
          <span>Station / list</span>
          <span>Data status</span>
        </div>
        ${items.map(renderRecipeTableRow).join("")}
      </div>
    </section>
  `;
}

function renderRecipeTableRow(view) {
  const output = view.outputItems.length
    ? formatRecipeItemList(view.outputItems, "Not resolved")
    : (view.outputItem ? view.outputItem.name : "Not resolved");
  const ingredients = view.ingredientItems.length
    ? formatRecipeItemList(view.ingredientItems.slice(0, 4), "Needs typed recipe export")
    : view.relatedItems.length
    ? view.relatedItems.slice(0, 3).map((item) => item.name).join(", ")
    : "Needs typed recipe export";
  const status = recipeDataStatus(view);
  return `
    <button class="recipe-row ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      <span class="recipe-cell-title"><strong>${escapeHtml(view.name)}</strong><span>${escapeHtml(view.primary || "CraftingRecipe")}</span></span>
      <span>${escapeHtml(output)}</span>
      <span class="recipe-cell-muted">${escapeHtml(ingredients)}</span>
      <span>${escapeHtml(view.station)}</span>
      <span class="badge ${status.tone}">${escapeHtml(status.label)}</span>
    </button>
  `;
}

function renderItemSections(views) {
  const groups = groupViews(views, (view) => view.itemFamily || "Items");
  const index = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, items]) => `<button class="chip-button ${state.filters.category === group ? "active" : ""}" data-item-family="${escapeAttr(group)}" type="button">${escapeHtml(group)} ${items.length}</button>`)
    .join("");
  const sections = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, items]) => renderItemSection(group, items))
    .join("");
  el.recordsList.innerHTML = `<div class="category-index">${index}</div>${sections}`;
  el.recordsList.querySelectorAll("[data-item-family]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.category = button.dataset.itemFamily;
      renderAll();
    });
  });
  el.recordsList.querySelectorAll(".item-row[data-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      renderAll();
    });
  });
}

function renderItemSection(group, items) {
  return `
    <section class="recipe-section">
      <div class="recipe-section-header">
        <div>
          <h3>${escapeHtml(group)}</h3>
          <p>${escapeHtml(itemSectionSummary(items))}</p>
        </div>
        <span class="count-pill">${items.length} items</span>
      </div>
      <div class="recipe-table">
        <div class="item-row header">
          <span>Item</span>
          <span>How to get</span>
          <span>Used in</span>
          <span>Crafting link</span>
          <span>Balance</span>
        </div>
        ${items.map(renderItemTableRow).join("")}
      </div>
    </section>
  `;
}

function renderItemTableRow(view) {
  const source = itemAcquisitionSummary(view);
  const crafting = itemCraftingSummary(view);
  const balance = itemBalanceStatus(view);
  const producer = firstProducerRecipe(view);
  const output = recipeOutputForItem(producer, view);
  const craftedAmount = output?.count ? ` x${output.count}` : "";
  return `
    <button class="item-row ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      <span class="recipe-cell-title"><strong>${escapeHtml(view.name)}</strong><span>${escapeHtml(view.primary || view.type)}</span></span>
      <span>${escapeHtml(source)}</span>
      <span>${escapeHtml(itemUsageSummary(view))}</span>
      <span class="recipe-cell-muted">${escapeHtml(crafting)}${escapeHtml(craftedAmount)}</span>
      <span class="badge ${balance.tone}">${escapeHtml(balance.label)}</span>
    </button>
  `;
}

function renderDesignerDomainSections(views) {
  const config = designerDomainConfig(state.activeCategory);
  const groups = groupViews(views, (view) => config.group(view));
  const index = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, items]) => `<button class="chip-button ${state.filters.category === group ? "active" : ""}" data-domain-group="${escapeAttr(group)}" type="button">${escapeHtml(group)} ${items.length}</button>`)
    .join("");
  const sections = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, items]) => renderDesignerDomainSection(group, items, config))
    .join("");
  el.recordsList.innerHTML = `<div class="category-index">${index}</div>${sections}`;
  el.recordsList.querySelectorAll("[data-domain-group]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.category = button.dataset.domainGroup;
      renderAll();
    });
  });
  el.recordsList.querySelectorAll(".domain-row[data-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      renderAll();
    });
  });
}

function renderDesignerDomainSection(group, items, config) {
  return `
    <section class="recipe-section">
      <div class="recipe-section-header">
        <div>
          <h3>${escapeHtml(group)}</h3>
          <p>${escapeHtml(config.summary(items))}</p>
        </div>
        <span class="count-pill">${items.length} records</span>
      </div>
      <div class="recipe-table">
        <div class="domain-row header ${escapeAttr(config.rowClass)}">
          ${config.columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}
        </div>
        ${items.map((view) => renderDesignerDomainRow(view, config)).join("")}
      </div>
    </section>
  `;
}

function renderDesignerDomainRow(view, config) {
  const cells = config.cells(view);
  return `
    <button class="domain-row ${escapeAttr(config.rowClass)} ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      ${cells.map((cell, index) => index === 0
        ? `<span class="recipe-cell-title"><strong>${escapeHtml(cell.title || cell)}</strong><span>${escapeHtml(cell.subtitle || view.primary || view.type)}</span></span>`
        : `<span class="${index === cells.length - 1 ? "badge-cell" : "recipe-cell-muted"}">${cell.html || escapeHtml(cell)}</span>`
      ).join("")}
    </button>
  `;
}

function designerDomainConfig(category) {
  if (category === "Creatures") {
    return {
      rowClass: "creature-row",
      columns: ["Creature", "Role", "Biome", "Combat", "Spawns", "Rewards"],
      group: (view) => view.creatureData.family,
      summary: (items) => `${unique(items.map((view) => view.creatureData.role)).join(", ")}. ${items.filter((view) => view.warnings.length).length} need typed creature export.`,
      cells: (view) => [
        { title: view.name, subtitle: view.creatureData.family },
        view.creatureData.role,
        view.creatureData.biome,
        view.creatureData.combat,
        view.creatureData.spawns,
        view.creatureData.rewards
      ]
    };
  }
  if (category === "Quests") {
    return {
      rowClass: "quest-row",
      columns: ["Quest", "NPC", "Requirements", "Objectives", "Rewards", "Unlocks"],
      group: (view) => view.questData.group,
      summary: (items) => `${items.length} indexed quest-related assets. Quest chains are under-exported until a typed quest exporter is added.`,
      cells: (view) => [
        { title: view.name, subtitle: view.questData.sourceState },
        view.questData.npc,
        view.questData.requirements,
        view.questData.objectives,
        view.questData.rewards,
        view.questData.unlocks
      ]
    };
  }
  if (category === "Biomes / Ecosystems") {
    return {
      rowClass: "ecosystem-row",
      columns: ["Ecosystem Entry", "Biome", "Growth / Spawn", "Outputs", "Used By", "Issues"],
      group: (view) => view.ecosystemData.group,
      summary: (items) => `${unique(items.map((view) => view.ecosystemData.biome)).slice(0, 4).join(", ")}. ${items.filter((view) => view.ecosystemData.issue !== "Indexed").length} need follow-up.`,
      cells: (view) => [
        { title: view.name, subtitle: view.primary || view.type },
        view.ecosystemData.biome,
        view.ecosystemData.growth,
        view.ecosystemData.outputs,
        view.ecosystemData.usedBy,
        view.ecosystemData.issue
      ]
    };
  }
  return {
    rowClass: "building-row",
    columns: ["Building", "Type", "Recipe / Cost", "Function", "Village Set", "Status"],
    group: (view) => view.buildingData.group,
    summary: (items) => `${unique(items.map((view) => view.buildingData.villageSet)).slice(0, 4).join(", ")}. ${items.filter((view) => view.producedBy?.length).length} recipe-backed placeables.`,
    cells: (view) => {
      const producer = firstProducerRecipe(view);
      const producedOutput = recipeOutputForItem(producer, view);
      return [
        { title: view.name, subtitle: view.primary || view.type },
        view.buildingData.group,
        producer ? `${producer.name}${producedOutput?.count ? ` x${producedOutput.count}` : ""}` : view.buildingData.recipeCost,
        view.buildingData.functionLabel,
        view.buildingData.villageSet,
        { html: `<span class="badge ${view.buildingData.status.tone}">${escapeHtml(view.buildingData.status.label)}</span>` }
      ];
    }
  };
}

function renderRecordCard(view) {
  if (view.kind === "recipe") return renderRecipeCard(view);
  if (view.kind === "item") return renderItemCard(view);
  return renderGenericCard(view);
}

function renderRecipeCard(view) {
  const output = view.outputItem
    ? `<span class="link-chip">Produces ${escapeHtml(view.outputItem.name)}</span>`
    : `<span class="badge warn">Output unknown</span>`;
  const items = view.relatedItems.slice(0, 4).map((item) => `<span class="chip">${escapeHtml(item.name)}</span>`).join("");
  return `
    <button class="record-card ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      <div class="record-top">
        <div>
          <div class="record-title">${escapeHtml(view.name)}</div>
          <div class="record-subtitle">${escapeHtml(view.station)} - ${escapeHtml(view.tier)}</div>
        </div>
        <span class="badge info">Recipe</span>
      </div>
      <div class="chip-row">${output}<span class="chip">${escapeHtml(view.primary || "CraftingRecipe")}</span></div>
      <div class="chip-row">${items || `<span class="chip">Ingredients pending typed export</span>`}</div>
    </button>
  `;
}

function renderItemCard(view) {
  const balance = itemBalanceStatus(view);
  return `
    <button class="record-card ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      <div class="record-top">
        <div>
          <div class="record-title">${escapeHtml(view.name)}</div>
          <div class="record-subtitle">${escapeHtml(view.itemFamily)} - ${escapeHtml(view.primary || view.type)}</div>
        </div>
        <span class="badge ${balance.tone}">${escapeHtml(balance.label)}</span>
      </div>
      <div class="chip-row">
        <span class="chip">${escapeHtml(itemAcquisitionSummary(view))}</span>
        <span class="chip">Produced by ${view.producedBy.length}</span>
        <span class="chip">Used by ${view.usedByRecipes.length}</span>
      </div>
    </button>
  `;
}

function renderGenericCard(view) {
  return `
    <button class="record-card ${state.selectedId === view.id ? "active" : ""}" data-id="${escapeAttr(view.id)}" type="button">
      <div class="record-top">
        <div>
          <div class="record-title">${escapeHtml(view.name)}</div>
          <div class="record-subtitle">${escapeHtml(view.path)}</div>
        </div>
        <span class="badge">${escapeHtml(view.kind)}</span>
      </div>
      <div class="chip-row">
        <span class="chip">${escapeHtml(view.primary || view.type)}</span>
        ${view.warnings.length ? `<span class="badge warn">${view.warnings.length} warnings</span>` : `<span class="badge ok">Indexed</span>`}
      </div>
    </button>
  `;
}

function renderDetail() {
  const view = getSelectedView();
  if (!view) {
    el.detailHeader.innerHTML = `<h2 class="detail-title">No record selected</h2><p class="detail-subtitle">Select a recipe, item, station, or balance record.</p>`;
    el.detailBody.innerHTML = "";
    return;
  }
  el.detailHeader.innerHTML = `
    <h2 class="detail-title">${escapeHtml(view.name)}</h2>
    <p class="detail-subtitle">${escapeHtml(view.category)} - ${escapeHtml(view.primary || view.type)}</p>
    <div class="chip-row" style="margin-top:10px">${detailBadges(view)}</div>
  `;
  el.detailBody.innerHTML = [
    renderOverviewSection(view),
    renderTypedSection(view),
    renderRelationshipsSection(view),
    renderNotesSection(view),
    renderWarningsSection(view),
    renderSourceSection(view)
  ].join("");
  wireDetailActions();
}

function detailBadges(view) {
  const badges = [];
  badges.push(`<span class="badge info">${escapeHtml(view.kind)}</span>`);
  if (view.station && view.station !== "Unassigned") badges.push(`<span class="badge">${escapeHtml(view.station)}</span>`);
  if (view.warnings.length) badges.push(`<span class="badge warn">${view.warnings.length} warnings</span>`);
  if (view.note) badges.push(`<span class="badge edit">Note</span>`);
  return badges.join("");
}

function renderOverviewSection(view) {
  return `
    <section class="section">
      <h3>Overview</h3>
      <div class="kv-grid">
        ${kv("Designer Name", view.name)}
        ${kv("Description", view.description || "No designer description loaded yet.")}
        ${kv("Type", view.primary || view.type)}
        ${kv("Tier", view.tier)}
      </div>
    </section>
  `;
}

function renderTypedSection(view) {
  if (view.kind === "recipe") {
    const output = view.outputItems.length
      ? renderRecipeItemLinks(view.outputItems, "No output exported")
      : (view.outputItem ? linkButton(view.outputItem, view.outputItem.name) : "Needs typed recipe export");
    const ingredients = view.ingredientItems.length
      ? renderRecipeItemLinks(view.ingredientItems, "No ingredients exported")
      : (view.relatedItems.length ? view.relatedItems.map((item) => linkButton(item, item.name)).join(" ") : "Needs typed recipe export");
    return `
      <section class="section">
        <h3>Recipe Readout</h3>
        <div class="kv-grid">
          ${kv("Station", view.station)}
          ${kv("Output", output)}
          ${kv("Ingredients", ingredients)}
          ${kv("Craft Time", displayOrPending(view.recipeData.processingTime))}
          ${kv("Reward XP", displayOrPending(view.recipeData.rewardXp, "None exported"))}
          ${kv("Default Unlock", displayOrPending(view.recipeData.unlockedByDefault))}
          ${kv("Unlock Notice", displayOrPending(view.recipeData.showRewardAsUnlock))}
          ${kv("Recipe Tag", displayOrPending(view.recipeData.identityTag || view.recipeData.filterTag, "No recipe tag exported"))}
        </div>
      </section>
    `;
  }
  if (state.activeCategory === "Villages / Buildings" && view.category === "Villages / Buildings") return renderBuildingReadout(view);
  if (view.kind === "item") {
    const producer = firstProducerRecipe(view);
    const producedOutput = recipeOutputForItem(producer, view);
    const producerIngredients = producer?.ingredientItems || [];
    const item = view.itemData || {};
    return `
      <section class="section">
        <h3>Item Identity</h3>
        <div class="kv-grid">
          ${kv("Family", view.itemFamily)}
          ${kv("Type", item.itemTypeName || view.primary || view.type)}
          ${kv("Tier", view.tier)}
          ${kv("Canonical Asset", view.isGroupedItem ? escapeHtml(assetNameFromPath(view.canonicalVariant.path)) : escapeHtml(assetNameFromPath(view.path)))}
          ${kv("Rarity", displayOrPending(item.rarity))}
          ${kv("Stack Size", displayOrPending(item.maxStackSize))}
          ${kv("Item Value", displayOrPending(item.itemValue))}
          ${kv("Scrap Value", displayOrPending(item.scrapAmount))}
          ${kv("Required Tool", displayOrPending(item.requiredToolTag, "None exported"))}
        </div>
      </section>
      ${renderVariantsSection(view)}
      <section class="section">
        <h3>How to Get</h3>
        <div class="kv-grid">
          ${kv("Primary Source", itemAcquisitionSummary(view))}
          ${kv("Produced By", view.producedBy.length ? view.producedBy.slice(0, 4).map((recipe) => linkButton(recipe, recipe.name)).join(" ") : itemAcquisitionSummary(view))}
          ${kv("Station", itemStationLinks(view).length ? itemStationLinks(view).slice(0, 4).join(", ") : "Station known; building owner not exported yet")}
          ${kv("Source Reliability", itemSourceReliability(view))}
        </div>
      </section>
      <section class="section">
        <h3>Crafting</h3>
        <div class="kv-grid">
          ${kv("Recipe", view.producedBy.length ? view.producedBy.slice(0, 3).map((recipe) => linkButton(recipe, recipe.name)).join(" ") : itemCraftingSummary(view))}
          ${kv("Station", itemStationLinks(view).length ? itemStationLinks(view).slice(0, 4).join(", ") : "Station known; building owner not exported yet")}
          ${kv("Ingredients", producerIngredients.length ? renderRecipeItemLinks(producerIngredients, "No ingredients exported") : itemCraftingSummary(view))}
          ${kv("Output Amount", producedOutput?.count ? escapeHtml(producedOutput.count) : displayOrPending("", "Needs typed recipe output"))}
          ${kv("Craft Time", producer?.recipeData.processingTime ? escapeHtml(producer.recipeData.processingTime) : displayOrPending("", "Needs typed recipe export"))}
          ${kv("Unlock", itemUnlockSummary(view))}
        </div>
      </section>
      <section class="section">
        <h3>Used In</h3>
        <div class="kv-grid">
          ${kv("Recipes", view.usedByRecipes.length ? view.usedByRecipes.slice(0, 6).map((recipe) => linkButton(recipe, recipe.name)).join(" ") : "No consumer recipes matched")}
          ${kv("Usage Count", view.useCount)}
        </div>
      </section>
      <section class="section">
        <h3>Balance</h3>
        <div class="kv-grid">
          ${kv("Status", itemBalanceStatus(view).label)}
          ${kv("Pressure", itemPressureSummary(view))}
          ${kv("Progression", itemProgressionSummary(view))}
          ${kv("Owned Tags", displayOrPending(item.ownedTags, "No item tags exported"))}
          ${kv("Quest Tags", displayOrPending(item.questTags, "No quest tags exported"))}
        </div>
      </section>
      ${renderTypedExportGapSection(view)}
    `;
  }
  if (view.kind === "creature") return renderCreatureReadout(view);
  if (view.kind === "quest") return renderQuestReadout(view);
  if (view.kind === "ecosystem") return renderEcosystemReadout(view);
  if (view.kind === "building") return renderBuildingReadout(view);
  if (view.kind === "station") {
    const recipes = state.views.filter((candidate) => candidate.kind === "recipe" && candidate.station === view.station);
    return `
      <section class="section">
        <h3>Station Coverage</h3>
        <div class="kv-grid">
          ${kv("Station", view.station)}
          ${kv("Recipe Count", recipes.length)}
          ${kv("Primary Type", view.primary || view.type)}
        </div>
      </section>
    `;
  }
  return `
    <section class="section">
      <h3>Balance Readout</h3>
      <div class="kv-grid">
        ${Object.entries(view.fields).slice(0, 8).map(([key, value]) => kv(cleanName(key), value)).join("")}
      </div>
    </section>
  `;
}

function renderCreatureReadout(view) {
  const data = view.creatureData;
  return `
    <section class="section">
      <h3>Creature Profile</h3>
      <div class="kv-grid">
        ${kv("Family", data.family)}
        ${kv("Role", data.role)}
        ${kv("Biome / Ecosystem", data.biome)}
        ${kv("Temperament", data.temperament)}
      </div>
    </section>
    <section class="section">
      <h3>Combat</h3>
      <div class="kv-grid">
        ${kv("Combat Profile", data.combat)}
        ${kv("Health", displayOrPending(view.fields.Health || view.fields.health, "Needs typed combat export"))}
        ${kv("Damage", displayOrPending(view.fields.Damage || view.fields.damage, "Needs typed combat export"))}
        ${kv("Move Speed", displayOrPending(view.fields.MoveSpeed || view.fields.moveSpeed, "Needs typed AI export"))}
      </div>
    </section>
    <section class="section">
      <h3>Spawning</h3>
      <div class="kv-grid">
        ${kv("Spawn Sources", data.spawns)}
        ${kv("Used By Spawners", relatedSpawnerLinks(view))}
      </div>
    </section>
    <section class="section">
      <h3>Rewards / Drops</h3>
      <div class="kv-grid">
        ${kv("Drops / Resources", data.rewards)}
      </div>
    </section>
    <section class="section">
      <h3>Ability / VFX</h3>
      <div class="kv-grid">
        ${kv("Ability / VFX State", data.abilityVfx)}
        ${kv("Related Creature Assets", renderDomainAssetLinks(view, "creature"))}
      </div>
    </section>
  `;
}

function renderQuestReadout(view) {
  const data = view.questData;
  return `
    <section class="section typed-gap">
      <h3>Quest Export State</h3>
      <p>Only quest-adjacent assets are indexed right now. PonyoWiki will not invent quest chains, objectives, or rewards until a typed quest exporter is added.</p>
    </section>
    <section class="section">
      <h3>Requirements</h3>
      <div class="kv-grid">
        ${kv("NPC / Giver", data.npc)}
        ${kv("Prerequisites", data.requirements)}
        ${kv("Required Items", "Required item links not exported yet")}
      </div>
    </section>
    <section class="section">
      <h3>Objectives</h3>
      <div class="kv-grid">
        ${kv("Objective Steps", data.objectives)}
        ${kv("Failure / Blocked States", "Failure states not exported yet")}
      </div>
    </section>
    <section class="section">
      <h3>Rewards</h3>
      <div class="kv-grid">
        ${kv("Rewards", data.rewards)}
        ${kv("Unlocks", data.unlocks)}
      </div>
    </section>
    <section class="section">
      <h3>NPC / Dialogue</h3>
      <div class="kv-grid">
        ${kv("Dialogue Hooks", "Dialogue hooks not exported yet")}
        ${kv("Related Quest Assets", renderDomainAssetLinks(view, "quest"))}
      </div>
    </section>
  `;
}

function renderEcosystemReadout(view) {
  const data = view.ecosystemData;
  return `
    <section class="section">
      <h3>Ecosystem Profile</h3>
      <div class="kv-grid">
        ${kv("Group", data.group)}
        ${kv("Biome", data.biome)}
        ${kv("Source Type", view.primary || view.type)}
      </div>
    </section>
    <section class="section">
      <h3>Growth / Harvest</h3>
      <div class="kv-grid">
        ${kv("Growth / Spawn", data.growth)}
        ${kv("Harvest Outputs", data.outputs)}
        ${kv("Water / Fertilizer", "Needs typed ecosystem export")}
        ${kv("Wither Rules", data.group === "Withered / Corruption" ? data.growth : "Needs typed ecosystem export")}
      </div>
    </section>
    <section class="section">
      <h3>Seed / Recipe Links</h3>
      <div class="kv-grid">
        ${kv("Seed Source", "Seed source links need typed ecosystem export")}
        ${kv("Recipe Links", relatedRecipeLinksByText(view))}
      </div>
    </section>
    <section class="section">
      <h3>Spawn Probability</h3>
      <div class="kv-grid">
        ${kv("Probability", displayOrPending(view.fields.DropChance || view.fields.SpawnWeight || view.fields.Weight, "Needs typed registry row export"))}
        ${kv("Used By", data.usedBy)}
      </div>
    </section>
  `;
}

function renderBuildingReadout(view) {
  const data = view.buildingData;
  const producer = firstProducerRecipe(view);
  const producedOutput = recipeOutputForItem(producer, view);
  const producerIngredients = producer?.ingredientItems || [];
  return `
    <section class="section">
      <h3>Building Profile</h3>
      <div class="kv-grid">
        ${kv("Building Group", data.group)}
        ${kv("Village Set", data.villageSet)}
        ${kv("Function", data.functionLabel)}
        ${kv("Placement", data.placement)}
      </div>
    </section>
    <section class="section">
      <h3>Build Cost</h3>
      <div class="kv-grid">
        ${kv("Recipe", producer ? linkButton(producer, producer.name) : data.recipeCost)}
        ${kv("Ingredients", producerIngredients.length ? renderRecipeItemLinks(producerIngredients, "No ingredients exported") : "No matched build recipe")}
        ${kv("Output Amount", producedOutput?.count ? escapeHtml(producedOutput.count) : "No matched output amount")}
      </div>
    </section>
    <section class="section">
      <h3>Village Context</h3>
      <div class="kv-grid">
        ${kv("Jobs / Villagers", "Villager/job support needs typed building export")}
        ${kv("Crafting / Station", itemStationLinks(view).length ? itemStationLinks(view).join(", ") : data.functionLabel)}
      </div>
    </section>
    <section class="section">
      <h3>Upgrade / Repair</h3>
      <div class="kv-grid">
        ${kv("Upgrade Chain", data.upgradeRepair)}
        ${kv("Related Building Assets", renderDomainAssetLinks(view, "building"))}
      </div>
    </section>
  `;
}

function renderRelationshipsSection(view) {
  const rows = relationshipRows(view);
  return `
    <section class="section">
      <h3>Relationships</h3>
      <div class="relationship-list">
        ${rows.length ? rows.map(renderRelationshipRow).join("") : `<div class="muted">No relationships resolved yet.</div>`}
      </div>
    </section>
  `;
}

function renderVariantsSection(view) {
  if (view.kind !== "item" || !view.isGroupedItem) return "";
  return `
    <section class="section">
      <h3>Variants</h3>
      <div class="relationship-list">
        ${view.variants.map((variant) => `
          <div class="relationship-row variant-row">
            <span class="badge ${variant === view.canonicalVariant ? "ok" : "info"}">${escapeHtml(variant === view.canonicalVariant ? "Canonical" : variantStatus(variant, view))}</span>
            <span>${escapeHtml(assetNameFromPath(variant.path))}<br><small>${escapeHtml(variant.path)}</small></span>
            <span class="muted">${escapeHtml(variant.producedBy.length ? `${variant.producedBy.length} producer` : variant.usedByRecipes.length ? `${variant.usedByRecipes.length} uses` : "No direct recipe link")}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderTypedExportGapSection(view) {
  if (view.kind !== "item") return "";
  const item = view.itemData || {};
  const producer = firstProducerRecipe(view);
  const gaps = [];
  if (!item.rarity) gaps.push("Rarity");
  if (!item.maxStackSize) gaps.push("Stack size");
  if (!item.scrapAmount) gaps.push("Scrap value");
  if (!item.itemValue) gaps.push("Kip / item value");
  if (!item.ownedTags && !item.questTags) gaps.push("Tags");
  if (producer && !producer.ingredientItems.length) gaps.push("Ingredient amounts");
  if (producer && !producer.recipeData.processingTime) gaps.push("Craft time");
  if (!gaps.length) return "";
  const hasTypedLoad = hasTypedItemData(view) || hasTypedRecipeData(producer);
  const message = hasTypedLoad
    ? "Typed export is loaded for this item, but these fields were not present or not filled on the source asset."
    : "PonyoWiki found this real item through Unreal's registry, but the typed value export did not load for this asset yet.";
  return `
    <section class="section typed-gap">
      <h3>Missing Typed Values</h3>
      <p>${escapeHtml(message)}</p>
      <div class="chip-row">
        ${gaps.map((gap) => `<span class="chip">${escapeHtml(gap)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderRelationshipRow(row) {
  return `
    <div class="relationship-row">
      <span class="badge">${escapeHtml(row.type)}</span>
      <span>${escapeHtml(row.view.name)}</span>
      <button class="chip-button" data-jump="${escapeAttr(row.view.id)}" type="button">Open</button>
    </div>
  `;
}

function renderNotesSection(view) {
  return `
    <section class="section note-box">
      <h3>Designer Notes</h3>
      <textarea id="designerNote" placeholder="Add balance notes, questions, or review comments.">${escapeHtml(view.note)}</textarea>
      <div class="action-row">
        <button id="saveNoteButton" class="primary-button" type="button">Save Note</button>
        <button id="clearNoteButton" class="secondary-button" type="button">Clear</button>
      </div>
    </section>
  `;
}

function renderWarningsSection(view) {
  const related = state.validation.filter((issueItem) => issueItem.viewId === view.id).slice(0, 8);
  const warnings = [
    ...view.warnings.map((warning) => formatWarning(warning, view)),
    ...related.map((warning) => ({ title: warning.title, body: warning.body }))
  ];
  return `
    <section class="section">
      <h3>Validation</h3>
      <div class="warn-list">
        ${warnings.length ? warnings.map((warning) => `<div class="warning-item"><strong>${escapeHtml(warning.title)}</strong><br>${escapeHtml(warning.body)}</div>`).join("") : `<div class="badge ok">No issues found for this record</div>`}
      </div>
    </section>
  `;
}

function formatWarning(warning, view) {
  if (warning.type === "asset_registry_only") {
    return {
      title: "Indexed only",
      body: "PonyoWiki found this real asset in Unreal without loading the asset values."
    };
  }
  if (warning.type === "no_safe_fields_exported") {
    if (view?.kind === "item") {
      return {
        title: "Item values not loaded yet",
        body: "This is real item data from the registry. Stack size, value, rarity, exact sources, and exact usage need a typed item exporter before they can be shown or edited."
      };
    }
    if (view?.kind === "creature") {
      return {
        title: "Creature values not loaded yet",
        body: "This real creature asset is indexed, but health, damage, movement, drops, and spawner links need a typed creature exporter."
      };
    }
    if (view?.kind === "quest") {
      return {
        title: "Quest source not exported yet",
        body: "This real quest-adjacent asset is indexed, but objectives, requirements, rewards, dialogue hooks, and progression tags need a typed quest exporter."
      };
    }
    if (view?.kind === "ecosystem") {
      return {
        title: "Ecosystem values not loaded yet",
        body: "This real ecosystem asset is indexed, but growth rules, harvest outputs, probabilities, and biome compatibility need a typed ecosystem exporter."
      };
    }
    if (view?.kind === "building" || view?.category === "Villages / Buildings") {
      return {
        title: "Building values not loaded yet",
        body: "This real building asset is indexed, but footprint, placement, village function, jobs, upgrade, and repair fields need a typed building exporter."
      };
    }
    return {
      title: "Recipe values not loaded yet",
      body: "This is not fake data. Ingredients, amounts, and craft time need a typed recipe exporter before they can be shown or edited."
    };
  }
  return { title: cleanName(warning.type || "Warning"), body: warning.message || "" };
}

function renderSourceSection(view) {
  return `
    <section class="section">
      <h3>Source</h3>
      <div class="kv-grid">
        ${kv("Asset Path", view.path)}
        ${kv("Asset Class", view.type)}
        ${kv("Primary Type", view.primary || "None")}
      </div>
    </section>
  `;
}

function wireDetailActions() {
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedId = button.dataset.jump;
      const view = getSelectedView();
      if (view?.kind === "item") state.activeCategory = "Items / Resources";
      if (view?.kind === "recipe") state.activeCategory = "Recipes / Crafting";
      renderAll();
    });
  });
  const note = document.getElementById("designerNote");
  const save = document.getElementById("saveNoteButton");
  const clear = document.getElementById("clearNoteButton");
  const view = getSelectedView();
  if (note && save && view) {
    save.addEventListener("click", () => {
      state.notes[view.id] = note.value.trim();
      saveNotes();
      state.changeLog.unshift({ time: new Date().toLocaleString(), title: "Designer note saved", body: view.name });
      buildViewModels();
      renderAll();
    });
  }
  if (clear && view) {
    clear.addEventListener("click", () => {
      delete state.notes[view.id];
      saveNotes();
      buildViewModels();
      renderAll();
    });
  }
}

function renderDrawer() {
  if (state.activeTab === "validation") return renderValidationDrawer();
  if (state.activeTab === "changes") return renderChangesDrawer();
  if (state.activeTab === "source") return renderSourceDrawer();
  renderImpactDrawer();
}

function renderImpactDrawer() {
  const view = getSelectedView();
  const cards = impactCards(view);
  el.drawerBody.innerHTML = `<div class="insight-grid">${cards.map((card) => `
    <div class="insight-card">
      <h4>${escapeHtml(card.title)}</h4>
      <p>${escapeHtml(card.body)}</p>
    </div>
  `).join("")}</div>`;
}

function renderValidationDrawer() {
  const issues = state.validation.slice(0, 80);
  el.drawerBody.innerHTML = issues.length ? `
    <div class="warn-list">
      ${issues.map((item) => `
        <div class="warning-item">
          <strong>${escapeHtml(item.title)}</strong> - ${escapeHtml(item.name)}<br>
          ${escapeHtml(item.body)}
        </div>
      `).join("")}
    </div>
  ` : `<div class="empty-state"><h3>No validation issues</h3><p>The current indexed data has no visible warnings.</p></div>`;
}

function renderChangesDrawer() {
  const notes = Object.entries(state.notes);
  const logs = state.changeLog.slice(0, 20);
  el.drawerBody.innerHTML = `
    <div class="insight-grid">
      <div class="insight-card"><h4>Session Notes</h4><p>${notes.length} records have designer notes.</p></div>
      <div class="insight-card"><h4>Editable Fields</h4><p>${state.views.filter((view) => view.record.editableFields.length).length} records expose safe editable fields.</p></div>
      <div class="insight-card"><h4>Apply Status</h4><p>Typed write-back is available only for records with explicit editable fields.</p></div>
    </div>
    <div class="warn-list" style="margin-top:12px">${logs.map((log) => `<div class="warning-item"><strong>${escapeHtml(log.title)}</strong> ${escapeHtml(log.time)}<br>${escapeHtml(log.body)}</div>`).join("")}</div>
  `;
}

function renderSourceDrawer() {
  const view = getSelectedView();
  if (!view) {
    el.drawerBody.innerHTML = `<div class="empty-state"><h3>No source selected</h3></div>`;
    return;
  }
  el.drawerBody.innerHTML = `<pre class="source-code">${escapeHtml(JSON.stringify(view.record, null, 2))}</pre>`;
}

function filteredByActiveCategory(applyFilters = true) {
  let views = [...state.views];
  if (state.activeCategory === "Validation") {
    views = state.validation.map((item) => state.views.find((view) => view.id === item.viewId)).filter(Boolean);
  } else if (state.activeCategory !== "Dashboard" && state.activeCategory !== "All Records") {
    if (state.activeCategory === "Items / Resources") {
      views = views.filter((view) => view.kind === "item");
    } else if (state.activeCategory === "Recipes / Crafting") {
      views = views.filter((view) => view.kind === "recipe");
    } else if (state.activeCategory === "Stations") {
      views = views.filter((view) => view.kind === "station");
    } else {
      views = views.filter((view) => view.category === state.activeCategory);
    }
  }
  if (!applyFilters) return views;
  return views;
}

function filteredViews() {
  let views = filteredByActiveCategory(true);
  if (state.activeCategory === "Recipes / Crafting" && state.filters.category !== "All") {
    views = views.filter((view) => view.group === state.filters.category);
  } else if (state.activeCategory === "Items / Resources" && state.filters.category !== "All") {
    views = views.filter((view) => view.itemFamily === state.filters.category);
  } else if (state.activeCategory === "Creatures" && state.filters.category !== "All") {
    views = views.filter((view) => view.creatureData.family === state.filters.category);
  } else if (state.activeCategory === "Quests" && state.filters.category !== "All") {
    views = views.filter((view) => view.questData.group === state.filters.category);
  } else if (state.activeCategory === "Biomes / Ecosystems" && state.filters.category !== "All") {
    views = views.filter((view) => view.ecosystemData.group === state.filters.category);
  } else if (state.activeCategory === "Villages / Buildings" && state.filters.category !== "All") {
    views = views.filter((view) => view.buildingData.group === state.filters.category);
  } else if (state.filters.category !== "All") {
    views = views.filter((view) => view.category === state.filters.category);
  }
  if (state.filters.type !== "All") views = views.filter((view) => (view.primary || view.type || view.kind) === state.filters.type);
  if (state.filters.station !== "All") {
    if (state.activeCategory === "Items / Resources") {
      views = views.filter((view) => itemStationLinks(view).includes(state.filters.station));
    } else if (state.activeCategory === "Creatures") {
      views = views.filter((view) => view.creatureData.biome === state.filters.station);
    } else if (state.activeCategory === "Quests") {
      views = views.filter((view) => view.questData.npc === state.filters.station);
    } else if (state.activeCategory === "Biomes / Ecosystems") {
      views = views.filter((view) => view.ecosystemData.biome === state.filters.station);
    } else if (state.activeCategory === "Villages / Buildings") {
      views = views.filter((view) => view.buildingData.villageSet === state.filters.station);
    } else {
      views = views.filter((view) => view.station === state.filters.station);
    }
  }
  if (state.filters.warningsOnly) views = views.filter((view) => view.warnings.length || state.validation.some((issueItem) => issueItem.viewId === view.id));
  if (state.activeLens === "attention") views = views.filter((view) => view.warnings.length || state.validation.some((issueItem) => issueItem.viewId === view.id));
  if (state.activeLens === "unused") views = views.filter((view) => view.kind === "item" && view.useCount === 0);
  if (state.activeLens === "relationships") views = views.filter((view) => relationshipRows(view).length);
  if (state.activeLens === "edits") views = views.filter((view) => view.note || view.record.editableFields.length);

  const query = state.query.trim().toLowerCase();
  if (query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    views = views.filter((view) => tokens.every((token) => searchableText(view).includes(token)));
  }
  return sortViews(views);
}

function searchableText(view) {
  return [
    view.name, view.description, view.path, view.category, view.kind, view.primary, view.type,
    view.station, view.tier, view.itemFamily, itemAcquisitionSummary(view), itemPressureSummary(view),
    view.creatureData?.family, view.creatureData?.role, view.creatureData?.biome, view.creatureData?.temperament,
    view.questData?.group, view.questData?.npc, view.questData?.sourceState,
    view.ecosystemData?.group, view.ecosystemData?.biome, view.ecosystemData?.growth, view.ecosystemData?.outputs,
    view.buildingData?.group, view.buildingData?.villageSet, view.buildingData?.functionLabel, view.buildingData?.status?.label,
    ...itemStationLinks(view), ...view.tags, ...(view.relatedItems || []).map((item) => item.name),
    ...(view.producedBy || []).map((recipe) => recipe.name), ...(view.usedByRecipes || []).map((recipe) => recipe.name)
  ].join(" ").toLowerCase();
}

function sortViews(views) {
  if (state.activeCategory === "Recipes / Crafting") {
    return views.sort((a, b) => a.station.localeCompare(b.station) || a.name.localeCompare(b.name));
  }
  if (state.activeCategory === "Items / Resources") {
    return views.sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name));
  }
  if (state.activeCategory === "Creatures") {
    return views.sort((a, b) => a.creatureData.family.localeCompare(b.creatureData.family) || a.creatureData.role.localeCompare(b.creatureData.role) || a.name.localeCompare(b.name));
  }
  if (state.activeCategory === "Quests") {
    return views.sort((a, b) => a.questData.group.localeCompare(b.questData.group) || a.name.localeCompare(b.name));
  }
  if (state.activeCategory === "Biomes / Ecosystems") {
    return views.sort((a, b) => a.ecosystemData.group.localeCompare(b.ecosystemData.group) || a.name.localeCompare(b.name));
  }
  if (state.activeCategory === "Villages / Buildings") {
    return views.sort((a, b) => a.buildingData.group.localeCompare(b.buildingData.group) || a.name.localeCompare(b.name));
  }
  return views.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function relationshipRows(view) {
  if (!view) return [];
  if (view.kind === "recipe") {
    return [
      ...(view.outputItem ? [{ type: "Produces", view: view.outputItem }] : []),
      ...view.relatedItems.map((item) => ({ type: "Item", view: item }))
    ];
  }
  if (view.kind === "item") {
    return [
      ...view.producedBy.map((recipe) => ({ type: "Made By", view: recipe })),
      ...view.usedByRecipes.map((recipe) => ({ type: "Used By", view: recipe }))
    ].slice(0, 40);
  }
  if (view.kind === "station") {
    return state.views
      .filter((candidate) => candidate.kind === "recipe" && candidate.station === view.station)
      .slice(0, 40)
      .map((recipe) => ({ type: "Recipe", view: recipe }));
  }
  if (view.kind === "creature") return relatedDomainViews(view, "creature").map((candidate) => ({ type: "Creature Asset", view: candidate }));
  if (view.kind === "quest") return relatedDomainViews(view, "quest").map((candidate) => ({ type: "Quest Asset", view: candidate }));
  if (view.kind === "ecosystem") return relatedDomainViews(view, "ecosystem").map((candidate) => ({ type: "Ecosystem Asset", view: candidate }));
  if (view.category === "Villages / Buildings" || view.kind === "building") {
    return [
      ...view.producedBy.map((recipe) => ({ type: "Build Recipe", view: recipe })),
      ...relatedDomainViews(view, "building").map((candidate) => ({ type: "Building Asset", view: candidate }))
    ].slice(0, 40);
  }
  return [];
}

function isDesignerDomainCategory(category) {
  return ["Creatures", "Quests", "Biomes / Ecosystems", "Villages / Buildings"].includes(category);
}

function relatedDomainViews(view, domain) {
  if (!view) return [];
  const key = domainKey(view, domain);
  if (!key) return [];
  return state.views
    .filter((candidate) => candidate.id !== view.id && domainKey(candidate, domain) === key)
    .slice(0, 12);
}

function domainKey(view, domain) {
  if (domain === "creature" && view.category === "Creatures") return view.creatureData.family.toLowerCase();
  if (domain === "quest" && view.category === "Quests") return view.questData.group.toLowerCase();
  if (domain === "ecosystem" && view.category === "Biomes / Ecosystems") return `${view.ecosystemData.group}:${view.ecosystemData.biome}`.toLowerCase();
  if (domain === "building" && view.category === "Villages / Buildings") return normalizedDesignerName(view.name);
  return "";
}

function normalizedDesignerName(value) {
  return cleanName(value)
    .replace(/\b(building|placeable|config|asset|da|bp|itemdef|item definition)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function renderDomainAssetLinks(view, domain) {
  const related = relatedDomainViews(view, domain);
  return related.length ? related.map((candidate) => linkButton(candidate, candidate.name)).join(" ") : "No related raw assets resolved yet";
}

function relatedSpawnerLinks(view) {
  const tokens = tokenSet(`${view.name} ${view.creatureData.family}`);
  const spawners = state.views
    .filter((candidate) => candidate.kind === "spawner" && overlapScore(tokens, tokenSet(`${candidate.name} ${candidate.path} ${candidate.tags.join(" ")}`)) > 0)
    .slice(0, 6);
  return spawners.length ? spawners.map((candidate) => linkButton(candidate, candidate.name)).join(" ") : "No spawner links resolved yet";
}

function relatedRecipeLinksByText(view) {
  const tokens = tokenSet(`${view.name} ${view.path}`);
  const recipes = state.views
    .filter((candidate) => candidate.kind === "recipe" && overlapScore(tokens, tokenSet(`${candidate.name} ${candidate.path}`)) >= 2)
    .slice(0, 6);
  return recipes.length ? recipes.map((candidate) => linkButton(candidate, candidate.name)).join(" ") : "No recipe links resolved yet";
}

function itemSectionSummary(items) {
  const produced = items.filter((item) => item.producedBy.length).length;
  const used = items.filter((item) => item.usedByRecipes.length).length;
  const gaps = items.filter((item) => itemBalanceStatus(item).tone === "warn").length;
  return `${produced} crafted, ${used} used by recipes, ${gaps} need attention`;
}

function itemAcquisitionSummary(view) {
  if (view.producedBy.length) return "Recipe-backed";
  const text = `${view.path} ${view.primary} ${view.type} ${view.name}`.toLowerCase();
  if (text.includes("harvest")) return "Gathered / harvested";
  if (text.includes("loot")) return "Loot";
  if (text.includes("merchant")) return "Merchant";
  if (text.includes("quest")) return "Quest";
  if (text.includes("recipeunlock")) return "Recipe unlock";
  if (text.includes("debug")) return "Debug";
  if (hasTypedItemData(view)) return view.isGroupedItem ? "Variant group without recipe" : "No known source";
  return "Source data not exported";
}

function itemUsageSummary(view) {
  const parts = [];
  if (view.usedByRecipes.length) parts.push(`${view.usedByRecipes.length} recipe uses`);
  if (view.producedBy.length) parts.push(`${view.producedBy.length} producers`);
  return parts.length ? parts.join(", ") : "No recipe links";
}

function itemCraftingSummary(view) {
  if (!view.producedBy.length) return view.isGroupedItem ? "Variants only; no recipe-backed asset" : "No known source";
  const stations = unique(view.producedBy.map((recipe) => recipe.station)).slice(0, 3);
  return stations.length ? stations.join(", ") : "Recipe matched";
}

function itemStationLinks(view) {
  return unique([
    ...view.producedBy.map((recipe) => recipe.station),
    ...view.usedByRecipes.map((recipe) => recipe.station)
  ]).filter((station) => station && station !== "Unassigned");
}

function itemSourceReliability(view) {
  const source = itemAcquisitionSummary(view);
  if (source === "Recipe-backed") return hasTypedRecipeData(firstProducerRecipe(view)) ? "Typed recipe-backed source" : "Recipe-backed source";
  if (source.includes("Gathered")) return "World/resource source";
  if (source.includes("No known source") || source.includes("Variant group")) return "Typed item data loaded; no source relationship resolved";
  if (source === "Source data not exported") return "Needs typed source export";
  return "Needs availability validation";
}

function itemUnlockSummary(view) {
  const unlockRecipes = view.usedByRecipes.filter((recipe) => /unlock/i.test(recipe.name));
  const producer = firstProducerRecipe(view);
  if (producer?.recipeData.unlockedByDefault !== "" && producer?.recipeData.unlockedByDefault != null) {
    return `Producer default unlock: ${producer.recipeData.unlockedByDefault}`;
  }
  if (unlockRecipes.length) return `${unlockRecipes.length} matched unlock recipe references`;
  if (/recipeunlock/i.test(view.name)) return "Recipe unlock item";
  return "Needs typed unlock export";
}

function itemProgressionSummary(view) {
  if (view.itemData?.rarity) return view.itemData.rarity;
  if (view.tier !== "Unrated") return view.tier;
  const text = `${view.name} ${view.path}`.toLowerCase();
  if (text.includes("common") || text.includes("stone") || text.includes("basic")) return "Early";
  if (text.includes("rare") || text.includes("iron") || text.includes("steel")) return "Mid";
  if (text.includes("epic") || text.includes("legendary")) return "Late";
  return "Needs typed progression export";
}

function itemPressureSummary(view) {
  if (!view.useCount) return "No visible pressure";
  if (view.usedByRecipes.length >= 8 && !view.producedBy.length) return "High demand, no matched producer";
  if (view.usedByRecipes.length >= 8) return "High recipe demand";
  if (view.producedBy.length && !view.usedByRecipes.length) return "Produced but not consumed";
  return "Moderate visible pressure";
}

function itemBalanceStatus(view) {
  if (hasTypedItemData(view) && (view.producedBy.length || view.usedByRecipes.length)) return { label: "Typed + connected", tone: "ok" };
  if (view.usedByRecipes.length >= 8 && !view.producedBy.length) return { label: "Bottleneck risk", tone: "warn" };
  if (!view.useCount) return { label: hasTypedItemData(view) ? "No known source" : "Source not exported", tone: "warn" };
  if (view.producedBy.length && !view.usedByRecipes.length) return { label: "Output only", tone: "info" };
  if (view.usedByRecipes.length && !view.producedBy.length) return { label: "Needs source", tone: "warn" };
  return { label: "Connected", tone: "ok" };
}

function impactCards(view) {
  if (!view) {
    return [
      { title: "Select Data", body: "Choose a record to see relationships, impact, validation, and source." }
    ];
  }
  if (view.kind === "recipe") {
    return [
      { title: "Station", body: `${view.station}. Filter by this station to review nearby recipes.` },
      { title: "Output Link", body: view.outputItem ? `${view.outputItem.name} opens its item page and all matched recipe references.` : "Output requires typed recipe details." },
      { title: "Edit Risk", body: "Current recipe values are registry-only; use typed recipe exporter before changing ingredients or amounts." }
    ];
  }
  if (view.kind === "item") {
    return [
      { title: "How to Get", body: `${itemAcquisitionSummary(view)}. ${itemSourceReliability(view)}.` },
      { title: "Balance Pressure", body: `${itemPressureSummary(view)}. ${view.producedBy.length} producer matches and ${view.usedByRecipes.length} consumer matches.` },
      { title: "Crafting Context", body: itemCraftingSummary(view) }
    ];
  }
  return [
    { title: "Source", body: view.path || "No asset path." },
    { title: "Type", body: view.primary || view.type || view.kind },
    { title: "Edit Readiness", body: view.record.editableFields.length ? "This record exposes safe editable fields." : "This record is read-only until a typed exporter exposes safe fields." }
  ];
}

function dashboardMetrics(views) {
  const recipes = state.views.filter((view) => view.kind === "recipe");
  const items = state.views.filter((view) => view.kind === "item");
  const stations = state.views.filter((view) => view.kind === "station");
  if (state.activeCategory === "Recipes / Crafting") {
    return [
      { label: "Recipe assets", value: recipes.length },
      { label: "Recipe categories", value: unique(recipes.map((view) => view.group)).length },
      { label: "Station/list groups", value: unique(recipes.map((view) => view.station)).length },
      { label: "Need typed values", value: recipes.filter((view) => !view.record.editableFields.length).length }
    ];
  }
  if (state.activeCategory === "Items / Resources") {
    return [
      { label: "Items", value: items.length },
      { label: "Used or produced", value: items.filter((view) => view.useCount).length },
      { label: "Crafted items", value: items.filter((view) => view.producedBy.length).length },
      { label: "Need attention", value: items.filter((view) => itemBalanceStatus(view).tone === "warn").length }
    ];
  }
  if (state.activeCategory === "Creatures") {
    return [
      { label: "Creature assets", value: views.length },
      { label: "Families", value: unique(views.map((view) => view.creatureData.family)).length },
      { label: "Combat profiles", value: views.filter((view) => view.creatureData.role === "Combat").length },
      { label: "Need typed export", value: views.filter((view) => view.warnings.length).length }
    ];
  }
  if (state.activeCategory === "Quests") {
    return [
      { label: "Quest assets", value: views.length },
      { label: "Quest NPC assets", value: views.filter((view) => view.questData.group === "Quest NPC").length },
      { label: "Ability setups", value: views.filter((view) => view.questData.group === "Quest Ability Setup").length },
      { label: "Under-exported", value: views.length }
    ];
  }
  if (state.activeCategory === "Biomes / Ecosystems") {
    return [
      { label: "Ecosystem assets", value: views.length },
      { label: "Groups", value: unique(views.map((view) => view.ecosystemData.group)).length },
      { label: "Plant records", value: views.filter((view) => view.ecosystemData.group === "Plants").length },
      { label: "Need follow-up", value: views.filter((view) => view.ecosystemData.issue !== "Indexed").length }
    ];
  }
  if (state.activeCategory === "Villages / Buildings") {
    return [
      { label: "Building assets", value: views.length },
      { label: "Groups", value: unique(views.map((view) => view.buildingData.group)).length },
      { label: "Recipe-backed", value: views.filter((view) => view.producedBy?.length).length },
      { label: "Need typed export", value: views.filter((view) => view.warnings.length).length }
    ];
  }
  return [
    { label: "Visible", value: views.length },
    { label: "All Records", value: state.views.length },
    { label: "Validation Items", value: state.validation.length },
    { label: "Notes", value: Object.keys(state.notes).length }
  ];
}

function inferCategoryFromQuery() {
  const q = state.query.toLowerCase();
  if (q.includes("recipe") || q.includes("craft")) state.activeCategory = "Recipes / Crafting";
  if (q.includes("item") || q.includes("resource")) state.activeCategory = "Items / Resources";
  if (q.includes("station")) state.activeCategory = "Stations";
  if (q.includes("creature")) state.activeCategory = "Creatures";
  if (q.includes("quest") || q.includes("npc")) state.activeCategory = "Quests";
  if (q.includes("biome") || q.includes("ecosystem") || q.includes("plant") || q.includes("seed")) state.activeCategory = "Biomes / Ecosystems";
  if (q.includes("village") || q.includes("building")) state.activeCategory = "Villages / Buildings";
  if (q.includes("spawn")) state.activeCategory = "Spawner Values";
  if (q.includes("loot")) state.activeCategory = "Loot Tables";
}

function countByCategory() {
  const counts = new Map();
  state.views.forEach((view) => counts.set(view.category, (counts.get(view.category) || 0) + 1));
  return counts;
}

function countSpecialCategory(category) {
  if (category === "Items / Resources") return state.views.filter((view) => view.kind === "item").length;
  if (category === "Recipes / Crafting") return state.views.filter((view) => view.kind === "recipe").length;
  if (category === "Stations") return state.views.filter((view) => view.kind === "station").length;
  if (category === "Validation") return state.validation.length;
  return 0;
}

function subtitleForActiveView() {
  if (state.activeCategory === "Recipes / Crafting") return "Recipe audit table for stations, outputs, inferred item links, and typed-export gaps.";
  if (state.activeCategory === "Items / Resources") return "Item encyclopedia: source, crafting, usage, balance pressure, and export readiness.";
  if (state.activeCategory === "Stations") return "Station and recipe-list coverage.";
  if (state.activeCategory === "Creatures") return "Creature encyclopedia: families, combat profiles, spawn hooks, rewards, and export readiness.";
  if (state.activeCategory === "Quests") return "Quest audit: indexed quest-adjacent assets with clear under-exported states.";
  if (state.activeCategory === "Biomes / Ecosystems") return "Ecosystem encyclopedia: plants, seeds, growth events, environment, and wither data groups.";
  if (state.activeCategory === "Villages / Buildings") return "Village/building encyclopedia: building configs, placeable items, recipes, functions, and repair/export gaps.";
  if (state.activeCategory === "Validation") return "Actionable data issues and typed-export gaps.";
  return "Query, compare, inspect, and prepare balancing edits from real Towers data.";
}

function exportSession() {
  const payload = {
    exportedAt: new Date().toISOString(),
    sourceMeta: state.meta,
    notes: state.notes,
    selectedId: state.selectedId,
    validationCount: state.validation.length
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ponyo_designer_session.json";
  link.click();
  URL.revokeObjectURL(url);
}

function groupViews(views, keyFn) {
  return views.reduce((groups, view) => {
    const key = keyFn(view) || "Other";
    if (!groups[key]) groups[key] = [];
    groups[key].push(view);
    return groups;
  }, {});
}

function recipeDataStatus(view) {
  if (hasTypedRecipeData(view)) return { label: "Typed", tone: "ok" };
  if (view.record.editableFields.length) return { label: "Editable", tone: "ok" };
  if (view.outputItem || view.relatedItems.length) return { label: "Indexed", tone: "info" };
  return { label: "Needs typed export", tone: "warn" };
}

function getSelectedView() {
  return state.views.find((view) => view.id === state.selectedId) || state.views[0] || null;
}

function getBridgeUrl() {
  return (el.bridgeUrl.value || DEFAULT_BRIDGE).trim().replace(/\/$/, "");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Timed out waiting for ${url}`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function setStatus(message, tone) {
  el.statusStrip.textContent = message;
  el.statusStrip.className = `status-strip status-${tone}`;
}

function stat(label, value) {
  return `<span class="stat-pill">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

function kv(key, value) {
  return `<div class="kv-key">${escapeHtml(key)}</div><div class="kv-value">${value == null ? "" : value}</div>`;
}

function linkButton(view, label) {
  return `<button class="chip-button" data-jump="${escapeAttr(view.id)}" type="button">${escapeHtml(label)}</button>`;
}

function refillSelect(select, values, current) {
  const next = values.includes(current) ? current : "All";
  select.innerHTML = values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("");
  select.value = next;
  if (select === el.typeFilter) state.filters.type = next;
  if (select === el.stationFilter) state.filters.station = next;
}

function cleanName(value) {
  return String(value || "")
    .replace(/^ASSET:/, "")
    .split("/")
    .pop()
    .replace(/^(DA_|BP_|WBP_|DT_|CRFT_|Recipe_)/, "")
    .replace(/_C$/, "")
    .replace(/_/g, " ")
    .trim() || "Unnamed";
}

function humanizeDescription(record, kind) {
  if (kind === "recipe") return "Crafting recipe indexed from real Towers assets.";
  if (kind === "item") return "Item/resource indexed from real Towers assets.";
  if (kind === "station") return "Crafting station, manager, or recipe list indexed from real Towers assets.";
  return "";
}

function tokenSet(value) {
  const stop = new Set([
    "da", "bp", "item", "def", "recipe", "right", "left", "common", "config", "asset", "data",
    "game", "dataassets", "assets", "ability", "abilities", "towers", "blueprint", "class", "initial"
  ]);
  return new Set(String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !stop.has(token)));
}

function overlapScore(a, b) {
  let score = 0;
  a.forEach((token) => {
    if (b.has(token)) score += 1;
  });
  return score;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveNotes() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.notes));
}

function cryptoRandomId() {
  return `local:${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
