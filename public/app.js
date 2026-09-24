// Chip cross-section viewer.
// All stored coordinates are absolute µm from the die's lower-left corner.
// The user-set zero only changes what is displayed.

const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const $ = sel => document.querySelector(sel);

const state = {
  chips: [],
  chip: null,        // chips.json entry
  map: null,
  store: null,
  layerOn: {},       // key -> bool
  opacity: 0.8,
  line: null,        // { x0, y0, x1, y1 }
  zero: { x: 0, y: 0 },
  mode: null,        // "draw-a" | "draw-b" | "zero" | null
  fileLines: [],     // from data/<chip>/lines.json
  localLines: [],    // saved in this browser, not yet in the file
};

const storage = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- screens

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

function renderPicker() {
  const cards = $("#chip-cards");
  cards.innerHTML = "";
  for (const c of state.chips) {
    const b = document.createElement("button");
    b.className = "card";
    b.innerHTML = `<img src="${c.thumb}" alt=""><span class="card-name">${c.name}</span>
      <span class="muted small">${c.pdk_name}<br>${fmtDie(c)}</span>`;
    b.onclick = () => openConfirm(c);
    cards.appendChild(b);
  }
  show("picker");
}

function openConfirm(c) {
  state.pending = c;
  $("#confirm-thumb").src = c.thumb;
  $("#confirm-name").textContent = c.name;
  $("#confirm-facts").innerHTML = `
    <dt>Process</dt><dd>${c.pdk_name}</dd>
    <dt>Die size</dt><dd>${fmtDie(c)}</dd>
    <dt>Top cell</dt><dd><code>${c.top_cell}</code></dd>
    ${c.repo ? `<dt>Source</dt><dd><a href="${c.repo}" target="_blank" rel="noopener">${c.repo.replace("https://", "")}</a></dd>` : ""}`;
  show("confirm");
}

function fmtDie(c) {
  return `${(c.width_um / 1000).toFixed(3)} × ${(c.height_um / 1000).toFixed(3)} mm`;
}

// ---------------------------------------------------------------- viewer

async function openViewer(chip, fromHash = {}) {
  state.chip = chip;
  show("viewer");
  $("#chip-title").textContent = chip.name;
  $("#chip-sub").textContent = `${chip.pdk_name} · ${fmtDie(chip)}`;
  state.store = new VectorStore(chip);
  state.zero = fromHash.zero || storage.get(`zero:${chip.id}`, { x: 0, y: 0 });
  state.localLines = storage.get(`lines:${chip.id}`, []);
  state.layerOn = storage.get(`layers:${chip.id}`, Object.fromEntries(chip.layers.map(l => [l.key, true])));
  state.opacity = storage.get("opacity", 0.8);
  $("#opacity").value = state.opacity;

  const tileIndex = Object.fromEntries(await Promise.all(chip.layers.map(async l => [l.key,
    new Set(await fetch(`data/${chip.id}/tiles/${l.key}/index.json`).then(r => r.json()))])));
  buildMap(chip, tileIndex);
  buildLayerList(chip);
  if (!state.xs) state.xs = new CrossSection($("#xs-canvas"), $("#xs-tip"), chip, { onHover: showHoverOnMap });
  else state.xs.setChip(chip);
  state.xsLayers = null;
  updateZeroInfo();
  await loadSavedLines();
  if (fromHash.line) setLine(fromHash.line, { fit: true });
  else { setLine(null); }
  updateHash();
}

function buildMap(chip, tileIndex) {
  if (state.map) { state.map.remove(); state.map = null; }
  const Z = chip.max_zoom;
  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: Z + 5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    attributionControl: false,
    doubleClickZoom: false,
  });
  state.map = map;
  const bounds = L.latLngBounds(toLatLng(0, 0), toLatLng(chip.width_um, chip.height_um));
  map.fitBounds(bounds);
  map.setMaxBounds(bounds.pad(0.3));

  state.tileLayers = {};
  state.vecLayers = {};
  chip.layers.forEach((l, i) => {
    const pane = map.createPane(`layer-${l.key}`);
    pane.style.zIndex = 300 + i;
    state.tileLayers[l.key] = new IndexedTileLayer(`data/${chip.id}/tiles/${l.key}/{z}/{x}/{y}.png`, {
      pane: `layer-${l.key}`,
      tileSize: chip.tile_size,
      minZoom: 0,
      maxZoom: Z + 0.5,  // Leaflet hides a layer outside [minZoom, maxZoom] (fractional)
      maxNativeZoom: Z,
      bounds,
      noWrap: true,
      opacity: state.opacity,
      index: tileIndex[l.key],
    });
    // Beyond the deepest raster level, draw the exact polygons instead.
    state.vecLayers[l.key] = new VectorGridLayer(state.store, l.key, l.color, umPerPx, {
      pane: `layer-${l.key}`,
      tileSize: 512,
      minZoom: Z + 0.5,
      maxZoom: Z + 5,
      bounds,
      noWrap: true,
      opacity: state.opacity,
    });
  });
  applyLayerVisibility();

  L.rectangle(bounds, { color: "#8a93a0", weight: 1, fill: false, dashArray: "4 4", interactive: false }).addTo(map);
  new ScaleBar({ position: "bottomleft" }).addTo(map);
  state.cursor = new CursorReadout({ position: "bottomright" }).addTo(map);

  // line + endpoints + zero marker
  state.lineLayer = L.polyline([], { color: "#39c5ff", weight: 3, opacity: 0.95 }).addTo(map);
  state.previewLayer = L.polyline([], { color: "#39c5ff", weight: 2, dashArray: "6 4" }).addTo(map);
  state.ends = ["A", "B"].map((lbl, i) => {
    const m = L.marker([0, 0], {
      draggable: true,
      icon: L.divIcon({ className: "end-icon", html: `<span>${lbl}</span>`, iconSize: [20, 20] }),
      zIndexOffset: 1000,
    });
    m.on("drag", e => onEndDrag(i, e));
    m.on("dragend", () => { updateXs(); updateHash(); });
    return m;
  });
  state.zeroMarker = L.marker(toLatLng(state.zero.x, state.zero.y), {
    icon: L.divIcon({ className: "zero-icon", iconSize: [22, 22] }),
    interactive: false,
  }).addTo(map);
  state.hoverMarker = L.circleMarker([0, 0], { radius: 6, color: "#fff", weight: 2, fillColor: "#ff5ab4", fillOpacity: 1, interactive: false });

  map.on("click", onMapClick);
  map.on("mousemove", onMapMove);
  map.on("mouseout", () => state.cursor.update(null));
}

// chip µm <-> Leaflet latlng
function toLatLng(x, y) {
  const c = state.chip, r = c.nm_per_px / 1000;
  return state.map.unproject([x / r, (c.height_um - y) / r], c.max_zoom);
}
function fromLatLng(ll) {
  const c = state.chip, r = c.nm_per_px / 1000;
  const p = state.map.project(ll, c.max_zoom);
  return { x: p.x * r, y: c.height_um - p.y * r };
}
function umPerPx(zoom) {
  const c = state.chip;
  return c.nm_per_px / 1000 * Math.pow(2, c.max_zoom - zoom);
}

// Tile layer that only requests tiles listed in index.json (empty tiles are not stored).
const IndexedTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    if (!this.options.index.has(`${coords.z}/${coords.x}/${coords.y}`)) return BLANK;
    return L.TileLayer.prototype.getTileUrl.call(this, coords);
  },
});

function buildLayerList(chip) {
  const list = $("#layer-list");
  list.innerHTML = "";
  for (const l of [...chip.layers].reverse()) {  // top of stack first
    const row = document.createElement("label");
    row.className = "layer-row";
    row.innerHTML = `<input type="checkbox" ${state.layerOn[l.key] !== false ? "checked" : ""}>
      <span class="sw" style="background:${l.color}"></span>
      <span>${l.name}<br><span class="muted small">${l.label} · ${l.gds.join(", ")}</span></span>`;
    row.querySelector("input").onchange = e => {
      state.layerOn[l.key] = e.target.checked;
      storage.set(`layers:${chip.id}`, state.layerOn);
      applyLayerVisibility();
      redrawXs();
    };
    list.appendChild(row);
  }
}

function applyLayerVisibility() {
  for (const l of state.chip.layers) {
    const on = state.layerOn[l.key] !== false;
    for (const lyr of [state.tileLayers[l.key], state.vecLayers[l.key]]) {
      lyr.setOpacity(state.opacity);
      if (on && !state.map.hasLayer(lyr)) lyr.addTo(state.map);
      if (!on && state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
    }
  }
}

// ---------------------------------------------------------------- map controls

const ScaleBar = L.Control.extend({
  onAdd(map) {
    this._div = L.DomUtil.create("div", "scalebar");
    this._div.innerHTML = `<div class="bar"></div><div class="lbl"></div>`;
    map.on("zoomend zoom", () => this.update());
    setTimeout(() => this.update());
    return this._div;
  },
  update() {
    const um = umPerPx(this._map.getZoom());
    const len = niceStep(um * 120);
    this._div.querySelector(".bar").style.width = `${len / um}px`;
    this._div.querySelector(".lbl").textContent =
      len >= 1000 ? `${len / 1000} mm` : len >= 1 ? `${len} µm` : `${Math.round(len * 1000)} nm`;
  },
});

const CursorReadout = L.Control.extend({
  onAdd() {
    this._div = L.DomUtil.create("div", "readout");
    this.update(null);
    return this._div;
  },
  update(p) {
    this._div.textContent = p
      ? `X ${(p.x - state.zero.x).toFixed(3)}  Y ${(p.y - state.zero.y).toFixed(3)} µm`
      : "X —  Y — µm";
  },
});

// ---------------------------------------------------------------- line + zero tools

function setMode(mode) {
  state.mode = mode;
  $("#map").classList.toggle("crosshair", !!mode);
  $("#draw-btn").classList.toggle("active", mode === "draw-a" || mode === "draw-b");
  $("#draw-btn").textContent = mode === "draw-a" ? "Click start…" : mode === "draw-b" ? "Click end…" : "Draw line";
  $("#zero-btn").classList.toggle("active", mode === "zero");
  $("#zero-btn").textContent = mode === "zero" ? "Click on map…" : "Set zero on map";
  if (mode !== "draw-b") state.previewLayer.setLatLngs([]);
}

function snap(a, b, shift) {
  if (!shift) return b;
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

function onMapClick(e) {
  const p = fromLatLng(e.latlng);
  if (state.mode === "draw-a") {
    state.drawStart = p;
    setMode("draw-b");
  } else if (state.mode === "draw-b") {
    const b = snap(state.drawStart, p, e.originalEvent.shiftKey);
    setMode(null);
    setLine({ x0: state.drawStart.x, y0: state.drawStart.y, x1: b.x, y1: b.y });
    $("#saved-lines").value = "";
  } else if (state.mode === "zero") {
    setMode(null);
    setZero(p);
  }
}

function onMapMove(e) {
  const p = fromLatLng(e.latlng);
  state.cursor.update(p);
  if (state.mode === "draw-b") {
    const b = snap(state.drawStart, p, e.originalEvent.shiftKey);
    state.previewLayer.setLatLngs([toLatLng(state.drawStart.x, state.drawStart.y), toLatLng(b.x, b.y)]);
  }
}

function onEndDrag(i, e) {
  const p = fromLatLng(e.target.getLatLng());
  const l = { ...state.line };
  const other = i === 0 ? { x: l.x1, y: l.y1 } : { x: l.x0, y: l.y0 };
  const q = snap(other, p, e.originalEvent && e.originalEvent.shiftKey);
  if (i === 0) { l.x0 = q.x; l.y0 = q.y; } else { l.x1 = q.x; l.y1 = q.y; }
  if (q !== p) e.target.setLatLng(toLatLng(q.x, q.y));
  setLine(l, { quiet: true });
  $("#saved-lines").value = "";
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// quiet: update the drawing and inputs only (used while dragging)
function setLine(line, { fit = false, quiet = false } = {}) {
  state.line = line && { x0: round3(line.x0), y0: round3(line.y0), x1: round3(line.x1), y1: round3(line.y1) };
  const l = state.line;
  if (!l) {
    state.lineLayer.setLatLngs([]);
    state.ends.forEach(m => m.remove());
  } else {
    const a = toLatLng(l.x0, l.y0), b = toLatLng(l.x1, l.y1);
    state.lineLayer.setLatLngs([a, b]);
    state.ends[0].setLatLng(a).addTo(state.map);
    state.ends[1].setLatLng(b).addTo(state.map);
    if (fit) state.map.fitBounds(L.latLngBounds(a, b).pad(0.3), { maxZoom: state.chip.max_zoom + 1 });
  }
  updateLineInputs();
  if (!quiet) { updateXs(); updateHash(); }
}

function updateLineInputs() {
  const l = state.line, z = state.zero;
  for (const [id, v] of [["x0", l && l.x0 - z.x], ["y0", l && l.y0 - z.y], ["x1", l && l.x1 - z.x], ["y1", l && l.y1 - z.y]]) {
    const el = $(`#${id}`);
    if (document.activeElement !== el) el.value = l ? v.toFixed(3) : "";
  }
  if (!l) { $("#line-info").textContent = "No line yet."; return; }
  const dx = l.x1 - l.x0, dy = l.y1 - l.y0;
  const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
  $("#line-info").innerHTML = `Length ${len.toFixed(3)} µm · angle ${ang.toFixed(2)}°<br>` +
    `Absolute: (${l.x0.toFixed(3)}, ${l.y0.toFixed(3)}) → (${l.x1.toFixed(3)}, ${l.y1.toFixed(3)}) µm`;
}

function onLineInput() {
  const v = id => parseFloat($(`#${id}`).value);
  const vals = ["x0", "y0", "x1", "y1"].map(v);
  if (vals.some(Number.isNaN)) return;
  const z = state.zero;
  setLine({ x0: vals[0] + z.x, y0: vals[1] + z.y, x1: vals[2] + z.x, y1: vals[3] + z.y });
  $("#saved-lines").value = "";
}

function setZero(p) {
  state.zero = { x: round3(p.x), y: round3(p.y) };
  storage.set(`zero:${state.chip.id}`, state.zero);
  state.zeroMarker.setLatLng(toLatLng(state.zero.x, state.zero.y));
  updateZeroInfo();
  updateLineInputs();
  redrawXs();
  updateHash();
}

function updateZeroInfo() {
  const z = state.zero;
  $("#zero-info").textContent = z.x === 0 && z.y === 0 ? "die corner (0, 0)" : `(${z.x.toFixed(3)}, ${z.y.toFixed(3)}) µm`;
}

// ---------------------------------------------------------------- cross-section

let xsToken = 0;

async function updateXs() {
  const l = state.line;
  if (!l) { state.xs.setData(null); $("#xs-status").textContent = ""; return; }
  const token = ++xsToken;
  $("#xs-status").textContent = "loading…";
  const layers = await Promise.all(state.chip.layers.map(async ly => ({
    ...ly, intervals: await state.store.intervals(ly.key, l.x0, l.y0, l.x1, l.y1),
  })));
  if (token !== xsToken) return;
  state.xsLayers = layers;
  $("#xs-status").textContent = "";
  redrawXs(false);
}

// Recompute the axis offset (depends on zero) and enabled layers without refetching.
function redrawXs(keepView = true) {
  const l = state.line;
  if (!l || !state.xsLayers) return;
  const dx = l.x1 - l.x0, dy = l.y1 - l.y0, len = Math.hypot(dx, dy);
  const offset = len ? ((state.zero.x - l.x0) * dx + (state.zero.y - l.y0) * dy) / len : 0;
  const layers = state.xsLayers.map(ly => ({ ...ly, enabled: state.layerOn[ly.key] !== false }));
  const prev = state.xs.data;
  const shift = prev && keepView ? offset - prev.offset : 0;
  state.xs.setData({ length: len, offset, layers }, keepView);
  if (keepView && state.xs.view && shift) {
    state.xs.view = [state.xs.view[0] - shift, state.xs.view[1] - shift];
    state.xs.draw();
  }
}

function showHoverOnMap(t) {
  const l = state.line;
  if (t == null || !l) { state.hoverMarker.remove(); return; }
  state.hoverMarker.setLatLng(toLatLng(l.x0 + t * (l.x1 - l.x0), l.y0 + t * (l.y1 - l.y0))).addTo(state.map);
}

// ---------------------------------------------------------------- saved lines

async function loadSavedLines() {
  try {
    const r = await fetch(`data/${state.chip.id}/lines.json`, { cache: "no-cache" });
    state.fileLines = r.ok ? await r.json() : [];
  } catch { state.fileLines = []; }
  // drop local copies that have since been committed to the file
  const fileIds = new Set(state.fileLines.map(l => l.id));
  state.localLines = state.localLines.filter(l => !fileIds.has(l.id));
  storage.set(`lines:${state.chip.id}`, state.localLines);
  renderSavedLines();
}

function allLines() { return [...state.fileLines, ...state.localLines.map(l => ({ ...l, local: true }))]; }

function renderSavedLines() {
  const sel = $("#saved-lines");
  sel.innerHTML = `<option value="">Choose a saved line…</option>` +
    allLines().map(l => `<option value="${l.id}">${escapeHtml(l.name)}${l.local ? " (this browser only)" : ""}</option>`).join("");
  const n = state.localLines.length;
  $("#unsaved-note").hidden = !n;
  $("#unsaved-note").textContent = `${n} line${n > 1 ? "s are" : " is"} only saved in this browser. Download lines.json and commit it to data/${state.chip.id}/lines.json to publish.`;
}

function selectSavedLine(id) {
  const l = allLines().find(x => x.id === id);
  if (l) setLine(l, { fit: true });
}

function saveLine() {
  if (!state.line) { alert("Draw a line first."); return; }
  const name = prompt("Name for this cross-section:", `Section ${allLines().length + 1}`);
  if (!name) return;
  const note = prompt("Optional note (e.g. what the section should show):", "") || undefined;
  const entry = { id: `l${Date.now().toString(36)}`, name, ...state.line, note, created: new Date().toISOString().slice(0, 10) };
  state.localLines.push(entry);
  storage.set(`lines:${state.chip.id}`, state.localLines);
  renderSavedLines();
  $("#saved-lines").value = entry.id;
}

function linesJson() {
  return JSON.stringify(allLines().map(({ local, ...l }) => l), null, 2) + "\n";
}

function downloadLines() {
  const blob = new Blob([linesJson()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lines.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyLines() {
  try { await navigator.clipboard.writeText(linesJson()); flash("Copied lines.json to clipboard"); }
  catch { prompt("Copy this JSON:", linesJson()); }
}

function flash(msg) {
  const n = $("#unsaved-note");
  const prevHidden = n.hidden, prev = n.textContent;
  n.hidden = false; n.textContent = msg;
  setTimeout(() => { n.hidden = prevHidden; n.textContent = prev; }, 2000);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------------------------------------------------------------- URL hash

function parseHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const out = { chip: p.get("chip") };
  const nums = s => s && s.split(",").map(Number);
  const line = nums(p.get("line"));
  if (line && line.length === 4 && line.every(Number.isFinite)) out.line = { x0: line[0], y0: line[1], x1: line[2], y1: line[3] };
  const zero = nums(p.get("zero"));
  if (zero && zero.length === 2 && zero.every(Number.isFinite)) out.zero = { x: zero[0], y: zero[1] };
  return out;
}

function updateHash() {
  if (!state.chip) return;
  const p = new URLSearchParams({ chip: state.chip.id });
  const l = state.line;
  if (l) p.set("line", [l.x0, l.y0, l.x1, l.y1].join(","));
  if (state.zero.x || state.zero.y) p.set("zero", `${state.zero.x},${state.zero.y}`);
  history.replaceState(null, "", `#${p.toString().replace(/%2C/g, ",")}`);
}

// ---------------------------------------------------------------- wiring

const actions = {
  "back-to-picker": () => { state.chip = null; history.replaceState(null, "", location.pathname); renderPicker(); },
  "confirm-chip": () => openViewer(state.pending),
  "draw-line": () => setMode(state.mode === "draw-a" || state.mode === "draw-b" ? null : "draw-a"),
  "clear-line": () => { setMode(null); setLine(null); $("#saved-lines").value = ""; },
  "set-zero": () => setMode(state.mode === "zero" ? null : "zero"),
  "zero-line-start": () => { if (state.line) setZero({ x: state.line.x0, y: state.line.y0 }); },
  "reset-zero": () => setZero({ x: 0, y: 0 }),
  "save-line": saveLine,
  "download-lines": downloadLines,
  "copy-lines": copyLines,
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action]();
});
for (const id of ["x0", "y0", "x1", "y1"]) $(`#${id}`).addEventListener("change", onLineInput);
document.addEventListener("keydown", e => { if (e.key === "Escape" && state.map) setMode(null); });
$("#saved-lines").addEventListener("change", e => selectSavedLine(e.target.value));
$("#opacity").addEventListener("input", e => {
  state.opacity = parseFloat(e.target.value);
  storage.set("opacity", state.opacity);
  applyLayerVisibility();
});

(async function init() {
  state.chips = await fetch("data/chips.json", { cache: "no-cache" }).then(r => r.json());
  const h = parseHash();
  const chip = state.chips.find(c => c.id === h.chip);
  if (chip) openViewer(chip, h);
  else renderPicker();
})();
