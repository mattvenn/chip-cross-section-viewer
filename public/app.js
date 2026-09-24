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
  cut: null,         // { axis: "h" | "v", pos } absolute µm
  line: null,        // the cut as a segment { x0, y0, x1, y1 }, edge to edge
  zero: { x: 0, y: 0 },
  mode: null,        // "place-h" | "place-v" | "zero" | null
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
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<button class="card-main"><img src="${c.thumb}" alt=""><span class="card-name">${escapeHtml(c.name)}</span>
      <span class="muted small">${escapeHtml(c.pdk_name)}<br>${fmtDie(c)}</span></button>
      ${c.page ? `<a class="small" href="${c.page}" target="_blank" rel="noopener">Tiny Tapeout page ↗</a>` : ""}`;
    card.querySelector("button").onclick = () => openConfirm(c);
    cards.appendChild(card);
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
    ${c.page ? `<dt>Chip page</dt><dd><a href="${c.page}" target="_blank" rel="noopener">${c.page.replace("https://", "")}</a></dd>` : ""}
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
  $("#chip-page").hidden = !chip.page;
  if (chip.page) $("#chip-page").href = chip.page;
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
  setCut(fromHash.cut || null, { show: !!fromHash.cut });
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

  // cross-section line + zero marker
  state.lineLayer = L.polyline([], { color: "#39c5ff", weight: 3, opacity: 0.95, interactive: false }).addTo(map);
  // Invisible, wider copy of the line that can be grabbed to move the whole line.
  state.lineGrab = L.polyline([], { weight: 16, opacity: 0, className: "line-grab" }).addTo(map);
  state.lineGrab.on("mousedown", onLineGrab);
  state.previewLayer = L.polyline([], { color: "#39c5ff", weight: 2, dashArray: "6 4", interactive: false }).addTo(map);
  state.zeroMarker = L.marker(toLatLng(state.zero.x, state.zero.y), {
    icon: L.divIcon({ className: "zero-icon", iconSize: [22, 22] }),
    interactive: false,
  }).addTo(map);
  state.hoverMarker = L.circleMarker([0, 0], { radius: 6, color: "#fff", weight: 2, fillColor: "#ff5ab4", fillOpacity: 1, interactive: false });

  map.on("click", onMapClick);
  // Full-width/height crosshair following the mouse, for lining features up.
  // Leaflet's map.remove() leaves extra children in the container, so drop the old one.
  const old = map.getContainer().querySelector(".guide-lines");
  if (old) old.remove();
  state.crosshair = L.DomUtil.create("div", "guide-lines", map.getContainer());
  state.crosshair.innerHTML = `<div class="ch-h"></div><div class="ch-v"></div>`;
  state.crosshair.hidden = true;

  map.on("mousemove", onMapMove);
  map.on("mouseout", () => { state.cursor.update(null); state.crosshair.hidden = true; });
}

function moveCrosshair(pt) {
  const ch = state.crosshair;
  ch.hidden = false;
  ch.firstChild.style.transform = `translateY(${pt.y}px)`;
  ch.lastChild.style.transform = `translateX(${pt.x}px)`;
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
  for (const [id, m, label] of [["#place-h", "place-h", "Horizontal line"], ["#place-v", "place-v", "Vertical line"]]) {
    $(id).classList.toggle("active", mode === m);
    $(id).textContent = mode === m ? "Click the chip…" : label;
  }
  $("#zero-btn").classList.toggle("active", mode === "zero");
  $("#zero-btn").textContent = mode === "zero" ? "Click on map…" : "Set zero on map";
  if (mode !== "place-h" && mode !== "place-v") state.previewLayer.setLatLngs([]);
}

// A cross-section line runs edge to edge across the die, so it is just an
// axis ("h" or "v") and one absolute position in µm (Y for "h", X for "v").
function cutSegment(cut) {
  const { width_um: W, height_um: H } = state.chip;
  return cut.axis === "h" ? { x0: 0, y0: cut.pos, x1: W, y1: cut.pos } : { x0: cut.pos, y0: 0, x1: cut.pos, y1: H };
}

function clampPos(axis, pos) {
  return Math.min(Math.max(pos, 0), axis === "h" ? state.chip.height_um : state.chip.width_um);
}

// Saved lines and old links may use the earlier {x0, y0, x1, y1} form.
function toCut(l) {
  if (!l) return null;
  if (l.axis === "h" || l.axis === "v") return { axis: l.axis, pos: Number(l.pos) };
  if ([l.x0, l.y0, l.x1, l.y1].every(Number.isFinite)) {
    return Math.abs(l.x1 - l.x0) >= Math.abs(l.y1 - l.y0) ? { axis: "h", pos: l.y0 } : { axis: "v", pos: l.x0 };
  }
  return null;
}

function onMapClick(e) {
  const p = fromLatLng(e.latlng);
  if (state.mode === "place-h" || state.mode === "place-v") {
    const axis = state.mode === "place-h" ? "h" : "v";
    setMode(null);
    setCut({ axis, pos: axis === "h" ? p.y : p.x }, { newLine: true });
    $("#saved-lines").value = "";
  } else if (state.mode === "zero") {
    setMode(null);
    setZero(p);
  }
}

function onMapMove(e) {
  const p = fromLatLng(e.latlng);
  state.cursor.update(p);
  moveCrosshair(e.containerPoint);
  if (state.mode === "place-h" || state.mode === "place-v") {
    const axis = state.mode === "place-h" ? "h" : "v";
    const l = cutSegment({ axis, pos: clampPos(axis, axis === "h" ? p.y : p.x) });
    state.previewLayer.setLatLngs([toLatLng(l.x0, l.y0), toLatLng(l.x1, l.y1)]);
  }
}

// Dragging the line moves it across the chip (up/down for horizontal lines).
function onLineGrab(e) {
  if (state.mode || !state.cut) return;
  L.DomEvent.stop(e);
  const map = state.map;
  map.dragging.disable();
  const start = fromLatLng(e.latlng), orig = { ...state.cut };
  $("#map").classList.add(orig.axis === "h" ? "moving-line-h" : "moving-line-v");
  const move = ev => {
    const p = fromLatLng(ev.latlng);
    const d = orig.axis === "h" ? p.y - start.y : p.x - start.x;
    setCut({ axis: orig.axis, pos: orig.pos + d }, { quiet: true });
  };
  const up = () => {
    map.off("mousemove", move);
    document.removeEventListener("mouseup", up);
    map.dragging.enable();
    $("#map").classList.remove("moving-line-h", "moving-line-v");
    if (state.cut.pos !== orig.pos) {
      $("#saved-lines").value = "";
      setCut(state.cut);
    }
  };
  map.on("mousemove", move);
  document.addEventListener("mouseup", up);
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// quiet: update the drawing and inputs only (used while dragging)
// newLine: open the cross-section on the part of the chip visible on the map
// show: pan the map so the line is in view
function setCut(cut, { quiet = false, newLine = false, show = false } = {}) {
  cut = toCut(cut);
  state.cut = cut && { axis: cut.axis, pos: round3(clampPos(cut.axis, cut.pos)) };
  state.line = state.cut && cutSegment(state.cut);
  $("#map").dataset.cut = state.cut ? state.cut.axis : "";
  const l = state.line;
  if (!l) {
    state.lineLayer.setLatLngs([]);
    state.lineGrab.setLatLngs([]);
  } else {
    const a = toLatLng(l.x0, l.y0), b = toLatLng(l.x1, l.y1);
    state.lineLayer.setLatLngs([a, b]);
    state.lineGrab.setLatLngs([a, b]);
    if (show) {
      const c = fromLatLng(state.map.getCenter());
      state.map.panTo(state.cut.axis === "h" ? toLatLng(c.x, state.cut.pos) : toLatLng(state.cut.pos, c.y));
    }
  }
  updateLineInputs();
  if (!quiet) { updateXs({ fitMap: newLine || show }); updateHash(); }
}

// force: also overwrite the box while it has focus (e.g. after the zero changed)
function updateLineInputs({ force = false } = {}) {
  const c = state.cut, z = state.zero;
  const axisName = c && c.axis === "v" ? "X" : "Y";
  $("#pos-label").textContent = `${axisName} (µm)`;
  const el = $("#pos");
  el.disabled = !c;
  const rel = c ? (c.pos - (c.axis === "h" ? z.y : z.x)).toFixed(3) : "";
  if (force || document.activeElement !== el) el.value = rel;
  if (!c) { $("#line-info").textContent = "No line yet."; return; }
  const span = c.axis === "h" ? `full width, ${state.chip.width_um} µm` : `full height, ${state.chip.height_um} µm`;
  $("#line-info").innerHTML = `${c.axis === "h" ? "Horizontal" : "Vertical"} line at ${axisName} = ${rel} µm` +
    `<br>Absolute ${axisName} = ${c.pos.toFixed(3)} µm · ${span}`;
}

function onLineInput() {
  const v = parseFloat($("#pos").value);
  if (!state.cut || Number.isNaN(v)) return;
  const z = state.zero;
  setCut({ axis: state.cut.axis, pos: v + (state.cut.axis === "h" ? z.y : z.x) }, { show: true });
  $("#saved-lines").value = "";
}

function setZero(p) {
  state.zero = { x: round3(p.x), y: round3(p.y) };
  storage.set(`zero:${state.chip.id}`, state.zero);
  state.zeroMarker.setLatLng(toLatLng(state.zero.x, state.zero.y));
  updateZeroInfo();
  updateLineInputs({ force: true });
  redrawXs();
  updateHash();
}

function updateZeroInfo() {
  const z = state.zero;
  $("#zero-info").textContent = z.x === 0 && z.y === 0 ? "die corner (0, 0)" : `(${z.x.toFixed(3)}, ${z.y.toFixed(3)}) µm`;
}

// ---------------------------------------------------------------- cross-section

let xsToken = 0;

async function updateXs({ fitMap = false } = {}) {
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
  if (fitMap) fitXsToMap();
}

// Show the stretch of the line that is visible on the map (double-click shows all of it).
function fitXsToMap() {
  const c = state.cut, xs = state.xs;
  if (!c || !xs.data) return;
  const b = state.map.getBounds();
  const p0 = fromLatLng(b.getSouthWest()), p1 = fromLatLng(b.getNorthEast());
  const [lo, hi] = c.axis === "h" ? [p0.x, p1.x] : [p0.y, p1.y];
  const len = xs.data.length;
  const a = Math.max(0, Math.min(lo, hi)), z = Math.min(len, Math.max(lo, hi));
  if (z - a <= 0 || z - a >= len) return;
  xs.view = [a - xs.data.offset, z - xs.data.offset];
  xs.draw();
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
  if (l) setCut(l, { show: true });
}

function saveLine() {
  if (!state.cut) { alert("Place a line first."); return; }
  const name = prompt("Name for this cross-section:", `Section ${allLines().length + 1}`);
  if (!name) return;
  const note = prompt("Optional note (e.g. what the section should show):", "") || undefined;
  const entry = { id: `l${Date.now().toString(36)}`, name, ...state.cut, note, created: new Date().toISOString().slice(0, 10) };
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
  const c = (p.get("cut") || "").split(",");
  if ((c[0] === "h" || c[0] === "v") && Number.isFinite(parseFloat(c[1]))) out.cut = { axis: c[0], pos: parseFloat(c[1]) };
  const line = nums(p.get("line"));
  if (!out.cut && line && line.length === 4 && line.every(Number.isFinite)) out.cut = toCut({ x0: line[0], y0: line[1], x1: line[2], y1: line[3] });
  const zero = nums(p.get("zero"));
  if (zero && zero.length === 2 && zero.every(Number.isFinite)) out.zero = { x: zero[0], y: zero[1] };
  return out;
}

function updateHash() {
  if (!state.chip) return;
  const p = new URLSearchParams({ chip: state.chip.id });
  if (state.cut) p.set("cut", `${state.cut.axis},${state.cut.pos}`);
  if (state.zero.x || state.zero.y) p.set("zero", `${state.zero.x},${state.zero.y}`);
  history.replaceState(null, "", `#${p.toString().replace(/%2C/g, ",")}`);
}

// ---------------------------------------------------------------- wiring

const actions = {
  "back-to-picker": () => { state.chip = null; history.replaceState(null, "", location.pathname); renderPicker(); },
  "confirm-chip": () => openViewer(state.pending),
  "place-h": () => setMode(state.mode === "place-h" ? null : "place-h"),
  "place-v": () => setMode(state.mode === "place-v" ? null : "place-v"),
  "clear-line": () => { setMode(null); setCut(null); $("#saved-lines").value = ""; },
  "set-zero": () => setMode(state.mode === "zero" ? null : "zero"),
  "reset-zero": () => setZero({ x: 0, y: 0 }),
  "save-line": saveLine,
  "download-lines": downloadLines,
  "copy-lines": copyLines,
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action]();
});
$("#pos").addEventListener("change", onLineInput);
document.addEventListener("keydown", e => { if (e.key === "Escape" && state.map) setMode(null); });
$("#saved-lines").addEventListener("change", e => selectSavedLine(e.target.value));
$("#opacity").addEventListener("input", e => {
  state.opacity = parseFloat(e.target.value);
  storage.set("opacity", state.opacity);
  applyLayerVisibility();
});

// version.json is written by the deploy workflow; a local copy doesn't have one.
async function showVersion() {
  const el = $("#version");
  try {
    const r = await fetch("version.json", { cache: "no-cache" });
    if (!r.ok) throw new Error();
    const v = await r.json();
    el.innerHTML = `Version <a href="${v.url}" target="_blank" rel="noopener"><code>${escapeHtml(v.sha.slice(0, 7))}</code></a>` +
      ` · ${escapeHtml(v.date.slice(0, 16).replace("T", " "))} UTC · ${escapeHtml(v.subject)}`;
  } catch {
    el.textContent = "Version: local development copy (not deployed)";
  }
}

(async function init() {
  showVersion();
  state.chips = await fetch("data/chips.json", { cache: "no-cache" }).then(r => r.json());
  const h = parseHash();
  const chip = state.chips.find(c => c.id === h.chip);
  if (chip) openViewer(chip, h);
  else renderPicker();
})();
