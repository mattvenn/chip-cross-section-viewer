// Schematic cross-section drawn on a canvas.
//
// Horizontal: position along the line in µm, measured from the projection of
// the zero point onto the line (so for a horizontal line it equals X - zeroX).
// Vertical: nominal PDK heights on a split axis. The front end (below
// `split`) gets a fixed share of the height so thin layers stay visible.

class CrossSection {
  constructor(canvas, tip, chip, { onHover, onDblClick } = {}) {
    this.canvas = canvas;
    this.tip = tip;
    this.chip = chip;
    this.onHover = onHover || (() => {});
    this.onDblClick = onDblClick || (() => {});
    this.data = null;     // { length, offset, layers: [{..., intervals}] }
    this.view = null;     // [s0, s1] visible axis range
    this.pad = { l: 78, r: 96, t: 14, b: 34 };  // right margin holds the depth dimension
    this._setupZ();
    this._bindEvents();
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  setChip(chip) {
    this.chip = chip;
    this._setupZ();
    this.setData(null);
  }

  _setupZ() {
    const zs = [...this.chip.bands.flatMap(b => b.z), ...this.chip.layers.flatMap(l => l.z)];
    this.zMin = Math.min(...zs);
    this.zMax = Math.max(...zs);
    const feolTop = Math.max(...this.chip.layers.filter(l => l.z[1] < 1).map(l => l.z[1]), 0);
    this.split = feolTop + 0.3;
    this.feolShare = 0.38;
  }

  // z (µm) -> canvas y
  zToY(z) {
    const top = this.pad.t, bot = this.h - this.pad.b, h = bot - top;
    const hFeol = h * this.feolShare;
    if (z <= this.split) return bot - (z - this.zMin) / (this.split - this.zMin) * hFeol;
    return bot - hFeol - (z - this.split) / (this.zMax - this.split) * (h - hFeol);
  }

  sToX(s) { return this.pad.l + (s - this.view[0]) / (this.view[1] - this.view[0]) * (this.w - this.pad.l - this.pad.r); }
  xToS(x) { return this.view[0] + (x - this.pad.l) / (this.w - this.pad.l - this.pad.r) * (this.view[1] - this.view[0]); }

  setData(data, keepView = false) {
    this.data = data;
    if (!data) { this.view = null; }
    else if (!keepView || !this.view) this.resetView();
    this.draw();
  }

  resetView() {
    if (!this.data) return;
    this.view = [-this.data.offset, this.data.length - this.data.offset];
    this.draw();
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("wheel", e => {
      if (!this.data) return;
      e.preventDefault();
      const s = this.xToS(e.offsetX);
      const f = Math.exp(e.deltaY * 0.0015);
      const span = Math.max(0.01, (this.view[1] - this.view[0]) * f);
      const r = (s - this.view[0]) / (this.view[1] - this.view[0]);
      this.view = [s - r * span, s - r * span + span];
      this.draw();
      this._hover(e.offsetX, e.offsetY);
    }, { passive: false });
    let drag = null;
    c.addEventListener("pointerdown", e => {
      if (!this.data) return;
      drag = { x: e.offsetX, view: this.view.slice() };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", e => {
      if (drag) {
        const ds = (e.offsetX - drag.x) / (this.w - this.pad.l - this.pad.r) * (drag.view[1] - drag.view[0]);
        this.view = [drag.view[0] - ds, drag.view[1] - ds];
        this.draw();
      }
      this._hover(e.offsetX, e.offsetY);
    });
    c.addEventListener("pointerup", () => { drag = null; });
    c.addEventListener("pointerleave", () => { this.tip.hidden = true; this.onHover(null); this.draw(); });
    // Double-click: hand the clicked position along the line (0..1) to the app.
    c.addEventListener("dblclick", e => {
      if (!this.data || e.offsetX < this.pad.l || e.offsetX > this.w - this.pad.r) return;
      const t = (this.xToS(e.offsetX) + this.data.offset) / this.data.length;
      if (t >= 0 && t <= 1) this.onDblClick(t, this.view[1] - this.view[0]);
    });
  }

  _hover(x, y) {
    if (!this.data || x < this.pad.l || x > this.w - this.pad.r) {
      this.tip.hidden = true; this.hoverS = null; this.onHover(null); this.draw(); return;
    }
    const s = this.xToS(x);
    const t = (s + this.data.offset) / this.data.length;
    if (t < 0 || t > 1) { this.tip.hidden = true; this.hoverS = null; this.onHover(null); this.draw(); return; }
    const present = this.data.layers.filter(l => l.enabled && l.intervals.some(([a, b]) => t >= a && t <= b));
    this.tip.innerHTML = `<b>${fmtUm(s)}</b> along line<br>` +
      (present.length ? present.map(l => `<span class="sw" style="background:${l.color}"></span>${l.name} <span class="muted">(${l.label})</span>`).join("<br>") : `<span class="muted">no selected layers</span>`);
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + tw > this.w ? x - tw - 14 : x + 14}px`;
    this.tip.style.top = `${Math.max(4, y - 20)}px`;
    this.hoverS = s;
    this.onHover(t);
    this.draw();
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const rect = c.parentElement.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    c.width = this.w * dpr; c.height = this.h * dpr;
    c.style.width = `${this.w}px`; c.style.height = `${this.h}px`;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--fg").trim(), muted = css.getPropertyValue("--muted").trim();
    ctx.font = "11px system-ui, sans-serif";
    ctx.clearRect(0, 0, this.w, this.h);

    if (!this.data) {
      ctx.fillStyle = muted;
      ctx.textAlign = "center";
      ctx.fillText("Draw a line on the chip, or choose a saved cross-section.", this.w / 2, this.h / 2);
      return;
    }

    const { pad } = this;
    const x0 = pad.l, x1 = this.w - pad.r;
    const sA = -this.data.offset, sB = this.data.length - this.data.offset;
    const xa = Math.max(x0, this.sToX(sA)), xb = Math.min(x1, this.sToX(sB));
    const L = this.data.length;
    const tToX = t => this.sToX(t * L - this.data.offset);

    ctx.save();
    ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, this.h); ctx.clip();
    // background bands
    if (xb > xa) {
      for (const b of this.chip.bands) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = b.color;
        ctx.fillRect(xa, this.zToY(b.z[1]), xb - xa, this.zToY(b.z[0]) - this.zToY(b.z[1]));
      }
      ctx.globalAlpha = 1;
      // layers
      for (const l of this.data.layers) {
        if (!l.enabled) continue;
        ctx.fillStyle = l.color;
        const yT = this.zToY(l.z[1]), yB = this.zToY(l.z[0]);
        for (const [a, b] of l.intervals) {
          let xl = tToX(a), xr = tToX(b);
          if (xr < x0 || xl > x1) continue;
          if (xr - xl < 1) { const m = (xl + xr) / 2; xl = m - 0.5; xr = m + 0.5; }
          ctx.fillRect(xl, yT, xr - xl, yB - yT);
        }
      }
    }
    // zero marker
    const xz = this.sToX(0);
    if (xz >= x0 && xz <= x1) {
      ctx.strokeStyle = "#ff5ab4"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xz, pad.t); ctx.lineTo(xz, this.h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
    }
    // hover marker
    if (this.hoverS != null) {
      const xh = this.sToX(this.hoverS);
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(xh, pad.t); ctx.lineTo(xh, this.h - pad.b); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // split-axis marker
    const ys = this.zToY(this.split);
    ctx.strokeStyle = muted; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 - 8, ys + 3); ctx.lineTo(x0 - 2, ys - 3);
    ctx.moveTo(x0 - 8, ys + 7); ctx.lineTo(x0 - 2, ys + 1);
    ctx.stroke();

    // z labels
    ctx.fillStyle = fg; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const labels = [
      ...this.data.layers.map(l => ({ text: l.label, z: (l.z[0] + l.z[1]) / 2, color: l.color })),
      ...this.chip.ticks.map(t => ({ text: t.label, z: t.z, tick: true })),
      ...this.chip.bands.filter(b => /substrate|passiv/i.test(b.label)).map(b => ({ text: b.label, z: (b.z[0] + b.z[1]) / 2, dim: true })),
    ].sort((a, b) => a.z - b.z);
    let lastY = Infinity;
    for (const lb of labels) {
      const y = this.zToY(lb.z);
      if (lastY - y < 12) continue;  // avoid overlaps
      lastY = y;
      ctx.fillStyle = lb.dim || lb.tick ? muted : fg;
      ctx.fillText(lb.text, x0 - 12, y);
      if (lb.tick) {
        ctx.strokeStyle = muted; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }

    // x axis
    const yAxis = this.h - pad.b;
    ctx.strokeStyle = muted;
    ctx.beginPath(); ctx.moveTo(x0, yAxis + 0.5); ctx.lineTo(x1, yAxis + 0.5); ctx.stroke();
    const span = this.view[1] - this.view[0];
    const step = niceStep(span / Math.max(2, (x1 - x0) / 90));
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let s = Math.ceil(this.view[0] / step) * step; s <= this.view[1]; s += step) {
      const x = this.sToX(s);
      ctx.beginPath(); ctx.moveTo(x, yAxis); ctx.lineTo(x, yAxis + 5); ctx.stroke();
      ctx.fillText(fmtNum(s, step), x, yAxis + 7);
    }
    ctx.textAlign = "right";
    ctx.fillStyle = muted;
    ctx.fillText("µm", x1, yAxis + 20);

    this._drawDepth(ctx, x1, fg, muted);
  }

  // Dimension from the top surface down to the transistors (silicon surface, z = 0).
  _drawDepth(ctx, x1, fg, muted) {
    const d = this.chip.depth;
    if (!d) return;
    const x = x1 + 16, yTop = this.zToY(d.top), yBot = this.zToY(0);
    ctx.save();
    ctx.strokeStyle = fg; ctx.fillStyle = fg; ctx.lineWidth = 1;
    // extension lines from the plot edge
    ctx.globalAlpha = 0.5; ctx.setLineDash([2, 2]);
    for (const y of [yTop, yBot]) { ctx.beginPath(); ctx.moveTo(x1, y + 0.5); ctx.lineTo(x + 6, y + 0.5); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // dimension line with arrowheads
    ctx.beginPath(); ctx.moveTo(x + 0.5, yTop); ctx.lineTo(x + 0.5, yBot); ctx.stroke();
    for (const [y, dir] of [[yTop, 1], [yBot, -1]]) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, y); ctx.lineTo(x - 3.5, y + 7 * dir); ctx.lineTo(x + 4.5, y + 7 * dir); ctx.closePath(); ctx.fill();
    }
    // label, centred on the dimension line
    const yMid = (yTop + yBot) / 2;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(`${d.estimate ? "≈ " : ""}${d.top.toFixed(2)} µm`, x + 8, yMid - 14);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.fillText("surface to", x + 8, yMid + 2);
    ctx.fillText("transistors", x + 8, yMid + 15);
    if (d.estimate) ctx.fillText("(estimate)", x + 8, yMid + 28);
    ctx.restore();
  }
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmtNum(v, step) {
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(Math.min(d, 3));
}

function fmtUm(v) {
  return `${(Math.abs(v) < 0.0005 ? 0 : v).toFixed(3)} µm`;
}
