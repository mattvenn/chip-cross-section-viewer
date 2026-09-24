#!/usr/bin/env python3
"""Build viewer data for one chip.

    python build/build_chip.py ttihp25b [--skip-tiles] [--skip-vec] [--meta-only]

Writes into public/data/<chip>/:
  tiles/<layer>/{z}/{x}/{y}.png   transparent tiles in the layer colour
  tiles/<layer>/index.json        list of non-empty tiles ("z/x/y")
  vec/<layer>/<cx>_<cy>.json      polygons per cell, nm relative to the cell corner
  vec/<layer>/index.json          list of non-empty cells [cx, cy]
  thumb.png                       whole-die overview
and updates public/data/chips.json.

Coordinates everywhere are relative to the lower-left corner of the die.
Tile rows count from the top of the die (Leaflet convention).
"""
import argparse
import io
import json
import math
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import klayout.db as db
import klayout.lay as lay
import yaml
from PIL import Image

HERE = Path(__file__).parent
ROOT = HERE.parent
CACHE = HERE / "cache"
OUT = ROOT / "public" / "data"


def load_config():
    chips_cfg = yaml.safe_load(open(HERE / "chips.yaml"))
    pdks = yaml.safe_load(open(HERE / "pdks.yaml"))
    return chips_cfg, pdks


def parse_ld(s):
    l, d = s.split("/")
    return int(l), int(d)


def die_box(layout, top, pdk, chip):
    """Die outline in µm (DBox)."""
    if chip.get("die"):
        return db.DBox(*chip["die"])
    if pdk.get("die_layer"):
        li = layout.find_layer(*parse_ld(pdk["die_layer"]))
        if li is not None:
            bb = top.dbbox_per_layer(li)
            if not bb.empty():
                return bb
    return top.dbbox()


# ---------------------------------------------------------------- tiles

_view = None
_view_layer = None


def _init_worker(path):
    global _view
    _view = lay.LayoutView()
    _view.load_layout(str(path), True)
    _view.max_hier()
    _view.set_config("background-color", "#000000")
    _view.set_config("grid-visible", "false")
    _view.set_config("text-visible", "false")
    _view.set_config("drop-small-cells", "false")


def _set_view_layer(key, sources):
    global _view_layer
    if _view_layer == key:
        return
    _view.clear_layers()
    for src in sources:
        lp = lay.LayerPropertiesNode()
        lp.source = f"{src}@1"
        lp.fill_color = 0xFFFFFF
        lp.frame_color = 0xFFFFFF
        lp.dither_pattern = 0  # solid
        lp.width = 0
        _view.insert_layer(_view.end_layers(), lp)
    _view_layer = key


def _render_tile(task):
    key, sources, color, box, tile_size, out_path = task
    _set_view_layer(key, sources)
    pb = _view.get_pixels_with_options(tile_size, tile_size, 0, 2, 0.0, db.DBox(*box))
    img = Image.open(io.BytesIO(pb.to_png_data()))
    alpha = img.convert("RGB").getchannel("R")
    if alpha.getbbox() is None:
        return None
    rgba = Image.new("RGBA", img.size, color)
    rgba.putalpha(alpha)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(out_path, optimize=False, compress_level=9)
    return out_path


def build_tiles(path, die, layers, render, out_dir, max_zoom):
    nm = render["nm_per_px"]
    ts = render["tile_size"]
    W, H = die.width(), die.height()
    tasks = []
    for key, info in layers.items():
        color = tuple(int(info["color"][i:i + 2], 16) for i in (1, 3, 5))
        for z in range(max_zoom + 1):
            T = ts * nm / 1000 * 2 ** (max_zoom - z)  # tile size in µm
            for ty in range(math.ceil(H / T)):
                for tx in range(math.ceil(W / T)):
                    x0 = die.left + tx * T
                    y1 = die.top - ty * T
                    box = (x0, y1 - T, x0 + T, y1)
                    p = out_dir / "tiles" / key / str(z) / str(tx) / f"{ty}.png"
                    tasks.append((key, info["gds"], color, box, ts, p))
    print(f"  rendering {len(tasks)} tiles")
    t = time.time()
    written = {k: [] for k in layers}
    with Pool(os.cpu_count(), initializer=_init_worker, initargs=(path,)) as pool:
        for i, res in enumerate(pool.imap(_render_tile, tasks, chunksize=16)):
            if res is not None:
                rel = res.relative_to(out_dir / "tiles")
                key = rel.parts[0]
                written[key].append(f"{rel.parts[1]}/{rel.parts[2]}/{Path(rel.parts[3]).stem}")
            if i % 2000 == 0:
                print(f"    {i}/{len(tasks)}  {time.time() - t:.0f}s")
    for key, lst in written.items():
        (out_dir / "tiles" / key / "index.json").write_text(json.dumps(sorted(lst)))
        print(f"  {key}: {len(lst)} non-empty tiles")


# ---------------------------------------------------------------- vectors

def encode_polygon(poly, bx, by, to_nm):
    """Encode a polygon relative to the cell corner (bx, by), in integer nm.

    Box:     [x, y, w, h]                      (4 numbers)
    Polygon: [x0, y0, dx1, dy1, dx2, dy2, ...]  (>= 6 numbers, deltas from previous point)
    Holes are resolved into the hull with cut lines.
    """
    if poly.is_box():
        b = poly.bbox()
        return [round((b.left - bx) * to_nm), round((b.bottom - by) * to_nm),
                round(b.width() * to_nm), round(b.height() * to_nm)]
    out = []
    px = py = 0
    first = True
    for p in poly.resolved_holes().each_point_hull():
        x, y = round((p.x - bx) * to_nm), round((p.y - by) * to_nm)
        if first:
            out += (x, y)
            first = False
        else:
            out += (x - px, y - py)
        px, py = x, y
    return out


def build_vectors(layout, top, die, layers, render, out_dir):
    cell_um = render["vec_cell_um"]
    dbu = layout.dbu
    to_nm = dbu * 1000
    cell = round(cell_um / dbu)             # cell size in dbu
    ox, oy = round(die.left / dbu), round(die.bottom / dbu)
    ncx = math.ceil(die.width() / cell_um)
    ncy = math.ceil(die.height() / cell_um)
    for key, info in layers.items():
        t = time.time()
        region = db.Region()
        for src in info["gds"]:
            li = layout.find_layer(*parse_ld(src))
            if li is not None:
                region += db.Region(top.begin_shapes_rec(li))
        region.merge()
        cells = {}

        def add(cx, cy, poly):
            cells.setdefault((cx, cy), []).append(
                encode_polygon(poly, ox + cx * cell, oy + cy * cell, to_nm))

        # Polygons inside one cell are stored as-is; the rest are clipped to
        # the cell grid (columns first, then rows, to keep the booleans small).
        spanning = db.Region()
        for poly in region.each():
            bb = poly.bbox()
            cx0, cx1 = (bb.left - ox) // cell, (bb.right - ox - 1) // cell
            cy0, cy1 = (bb.bottom - oy) // cell, (bb.top - oy - 1) // cell
            if cx0 == cx1 and cy0 == cy1:
                add(cx0, cy0, poly)
            else:
                spanning.insert(poly)
        for cx in range(ncx):
            col = spanning & db.Region(db.Box(ox + cx * cell, oy, ox + (cx + 1) * cell, oy + ncy * cell))
            if col.is_empty():
                continue
            for cy in range(ncy):
                piece = col & db.Region(db.Box(ox + cx * cell, oy + cy * cell,
                                               ox + (cx + 1) * cell, oy + (cy + 1) * cell))
                for poly in piece.each():
                    add(cx, cy, poly)
        vdir = out_dir / "vec" / key
        vdir.mkdir(parents=True, exist_ok=True)
        size = 0
        for (cx, cy), polys in cells.items():
            s = json.dumps(polys, separators=(",", ":"))
            size += len(s)
            (vdir / f"{cx}_{cy}.json").write_text(s)
        (vdir / "index.json").write_text(json.dumps(sorted(cells), separators=(",", ":")))
        print(f"  vec {key}: {region.count()} polygons, {len(cells)} cells, "
              f"{size / 1e6:.1f} MB, {time.time() - t:.0f}s")


# ---------------------------------------------------------------- thumbnail

def build_thumb(path, die, layers, out_dir, width=900):
    v = lay.LayoutView()
    v.load_layout(str(path), True)
    v.max_hier()
    v.set_config("background-color", "#15171a")
    v.set_config("grid-visible", "false")
    v.set_config("text-visible", "false")
    v.clear_layers()
    for key, info in layers.items():  # bottom to top
        for src in info["gds"]:
            lp = lay.LayerPropertiesNode()
            lp.source = f"{src}@1"
            c = int(info["color"][1:], 16)
            lp.fill_color = c
            lp.frame_color = c
            lp.dither_pattern = 0
            lp.width = 0
            v.insert_layer(v.end_layers(), lp)
    height = round(width * die.height() / die.width())
    pb = v.get_pixels_with_options(width, height, 0, 3, 0.0, die)
    pb.write_png(str(out_dir / "thumb.png"))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chip")
    ap.add_argument("--skip-tiles", action="store_true")
    ap.add_argument("--skip-vec", action="store_true")
    ap.add_argument("--meta-only", action="store_true",
                    help="only refresh this chip's entry in chips.json (e.g. after editing its name or links)")
    args = ap.parse_args()

    chips_cfg, pdks = load_config()
    chip = chips_cfg["chips"][args.chip]
    pdk = pdks[chip["pdk"]]
    render = chips_cfg["render"]
    path = CACHE / chip["file"]
    if not path.exists():
        sys.exit(f"{path} missing, run build/fetch.py {args.chip} first")

    out_dir = OUT / args.chip
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"reading {path}")
    layout = db.Layout()
    layout.read(str(path))
    top = layout.top_cells()[0]
    die = die_box(layout, top, pdk, chip)
    print(f"  top cell {top.name}, die {die}")

    # logical layers present in this PDK, bottom to top
    layers = {}
    for key, ll in chips_cfg["logical_layers"].items():
        if key in pdk["layers"]:
            layers[key] = {**ll, **pdk["layers"][key]}

    nm = render["nm_per_px"]
    ts = render["tile_size"]
    max_zoom = math.ceil(math.log2(max(die.width(), die.height()) * 1000 / nm / ts))

    if not args.meta_only:
        if not args.skip_tiles:
            build_tiles(path, die, layers, render, out_dir, max_zoom)
        if not args.skip_vec:
            build_vectors(layout, top, die, layers, render, out_dir)
        build_thumb(path, die, layers, out_dir)

    entry = {
        "id": args.chip,
        "name": chip["name"],
        "repo": chip.get("repo"),
        "page": chip.get("page"),
        "pdk": chip["pdk"],
        "pdk_name": pdk["name"],
        "top_cell": top.name,
        "width_um": die.width(),
        "height_um": die.height(),
        "nm_per_px": nm,
        "tile_size": ts,
        "max_zoom": max_zoom,
        "vec_cell_um": render["vec_cell_um"],
        "thumb": f"data/{args.chip}/thumb.png",
        "layers": [
            {"key": k, "name": v["name"], "label": v["label"], "color": v["color"],
             "gds": v["gds"], "z": v["z"]}
            for k, v in layers.items()
        ],
        "bands": pdk.get("bands", []),
        "ticks": pdk.get("ticks", []),
    }
    index_path = OUT / "chips.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [c for c in index if c["id"] != args.chip] + [entry]
    order = list(chips_cfg["chips"])
    index.sort(key=lambda c: order.index(c["id"]) if c["id"] in order else 99)
    index_path.write_text(json.dumps(index, indent=2))

    lines = out_dir / "lines.json"
    if not lines.exists():
        lines.write_text("[]\n")
    print("done")


if __name__ == "__main__":
    main()
