// Vector chunk loading, polygon decoding and line/polygon intersection.
// Coordinates are µm relative to the die's lower-left corner.

class VectorStore {
  constructor(chip) {
    this.chip = chip;
    this.cellUm = chip.vec_cell_um;
    this.base = `data/${chip.id}/vec`;
    this.index = {};   // layer -> Set("cx_cy")
    this.cache = {};   // "layer/cx_cy" -> Promise<Array<Float64Array>>
  }

  async loadIndex(layer) {
    if (!this.index[layer]) {
      this.index[layer] = fetch(`${this.base}/${layer}/index.json`)
        .then(r => r.ok ? r.json() : [])
        .then(list => new Set(list.map(([x, y]) => `${x}_${y}`)));
    }
    return this.index[layer];
  }

  // Decode a cell file into polygons: flat [x0, y0, x1, y1, ...] in absolute µm.
  static decode(raw, cx, cy, cellUm) {
    const bx = cx * cellUm, by = cy * cellUm;
    return raw.map(a => {
      if (a.length === 4) {
        const x = bx + a[0] / 1000, y = by + a[1] / 1000, w = a[2] / 1000, h = a[3] / 1000;
        return Float64Array.of(x, y, x + w, y, x + w, y + h, x, y + h);
      }
      const out = new Float64Array(a.length);
      let x = 0, y = 0;
      for (let i = 0; i < a.length; i += 2) {
        if (i === 0) { x = a[0]; y = a[1]; } else { x += a[i]; y += a[i + 1]; }
        out[i] = bx + x / 1000;
        out[i + 1] = by + y / 1000;
      }
      return out;
    });
  }

  async cell(layer, cx, cy) {
    const idx = await this.loadIndex(layer);
    const k = `${cx}_${cy}`;
    if (!idx.has(k)) return [];
    const key = `${layer}/${k}`;
    if (!this.cache[key]) {
      this.cache[key] = fetch(`${this.base}/${layer}/${k}.json`)
        .then(r => r.json())
        .then(raw => VectorStore.decode(raw, cx, cy, this.cellUm));
    }
    return this.cache[key];
  }

  // Cells [cx, cy] crossed by the segment (x0,y0)-(x1,y1).
  cellsOnSegment(x0, y0, x1, y1) {
    const c = this.cellUm, out = [];
    const ncx = Math.ceil(this.chip.width_um / c), ncy = Math.ceil(this.chip.height_um / c);
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) / c)), maxx = Math.min(ncx - 1, Math.floor(Math.max(x0, x1) / c));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) / c)), maxy = Math.min(ncy - 1, Math.floor(Math.max(y0, y1) / c));
    for (let cx = minx; cx <= maxx; cx++) {
      for (let cy = miny; cy <= maxy; cy++) {
        if (segmentHitsBox(x0, y0, x1, y1, cx * c, cy * c, (cx + 1) * c, (cy + 1) * c)) out.push([cx, cy]);
      }
    }
    return out;
  }

  // Merged intervals [t0, t1] (0..1 along the segment) where `layer` is present.
  async intervals(layer, x0, y0, x1, y1) {
    const cells = this.cellsOnSegment(x0, y0, x1, y1);
    const polys = (await Promise.all(cells.map(([cx, cy]) => this.cell(layer, cx, cy)))).flat();
    const iv = [];
    for (const p of polys) segmentPolygonIntervals(x0, y0, x1, y1, p, iv);
    return mergeIntervals(iv);
  }
}

// Liang-Barsky style test: does the segment touch the box?
function segmentHitsBox(x0, y0, x1, y1, bx0, by0, bx1, by1) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy], q = [x0 - bx0, bx1 - x0, y0 - by0, by1 - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

// Append the parts of the segment inside polygon `pts` to `out` as [t0, t1].
// Uses crossings of the infinite line with the polygon edges (half-open rule
// so vertices on the line are counted once), then pairs them by parity.
function segmentPolygonIntervals(ax, ay, bx, by, pts, out) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  if (L2 === 0) return;
  const n = pts.length / 2, ts = [];
  let px = pts[2 * n - 2], py = pts[2 * n - 1];
  let sp = (px - ax) * dy - (py - ay) * dx;
  for (let i = 0; i < n; i++) {
    const qx = pts[2 * i], qy = pts[2 * i + 1];
    const sq = (qx - ax) * dy - (qy - ay) * dx;
    if ((sp > 0) !== (sq > 0)) {
      const u = sp / (sp - sq);
      const ix = px + u * (qx - px), iy = py + u * (qy - py);
      ts.push(((ix - ax) * dx + (iy - ay) * dy) / L2);
    }
    px = qx; py = qy; sp = sq;
  }
  if (ts.length < 2) return;
  ts.sort((a, b) => a - b);
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const t0 = Math.max(0, ts[i]), t1 = Math.min(1, ts[i + 1]);
    if (t1 > t0) out.push([t0, t1]);
  }
}

function mergeIntervals(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Leaflet grid layer that draws the vector polygons, used when zoomed in past
// the deepest raster tile level so edges stay sharp.
const VectorGridLayer = L.GridLayer.extend({
  initialize(store, layer, color, toUm, options) {
    this.store = store;
    this.layerKey = layer;
    this.color = color;
    this.toUm = toUm;  // (zoom) -> µm per pixel
    L.GridLayer.prototype.initialize.call(this, options);
  },

  createTile(coords, done) {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    tile.width = size.x * dpr;
    tile.height = size.y * dpr;
    const s = this.toUm(coords.z);
    const H = this.store.chip.height_um;
    const x0 = coords.x * size.x * s, x1 = x0 + size.x * s;
    const yTop = H - coords.y * size.y * s, yBot = yTop - size.y * s;
    const c = this.store.cellUm;
    const cells = [];
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++)
      for (let cy = Math.floor(yBot / c); cy <= Math.floor(yTop / c); cy++)
        if (cx >= 0 && cy >= 0) cells.push([cx, cy]);
    Promise.all(cells.map(([cx, cy]) => this.store.cell(this.layerKey, cx, cy))).then(lists => {
      const ctx = tile.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.fillStyle = this.color;
      ctx.beginPath();
      for (const polys of lists) {
        for (const p of polys) {
          ctx.moveTo((p[0] - x0) / s, (yTop - p[1]) / s);
          for (let i = 2; i < p.length; i += 2) ctx.lineTo((p[i] - x0) / s, (yTop - p[i + 1]) / s);
          ctx.closePath();
        }
      }
      ctx.fill("nonzero");
      done(null, tile);
    }).catch(err => done(err, tile));
    return tile;
  },
});
