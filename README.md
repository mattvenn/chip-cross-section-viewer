# Aim

make a simple webpage I can easily make public. There are 3 chips to choose from (see below). They are on 3 different PDKs.

the idea is to make it easy for lab technicians to make a cross section of the chip.  they'll load the page, pick the chip, confirm it matches what they see, then setup the cross section using a saved line I've previously drawn

the page shows layers of the selected chip. We only need:

* top metal (what you'd see looking at the chip on a SEM or optical microscope),
* and the transistors.  The transistor layer might need to be made of polysilicon + diffusion. 

For the viewer:

* leverage existing tools like; https://tinytapeout.github.io/tt08-chip-imaging/#url=data/tt08.json
* each layer can be turned on and off
* use the same colour code for each chip.
* the viewer should be zoomable and pannable.
* below the top view there should be a cross section view showing the selected layers
* scale bar

cross section:

* I want to be able to draw a line, and then see the cross section. i
* cross section line should have absolute dimensions for the start and end
* I should be able to save a cross section,
* a new zero point can be set by the viewer, which would update the cross section dimensions.

# Resources

Chip 1 - TT02 is manufactured with Sky130 - https://github.com/TinyTapeout/tinytapeout-02
Download the GDS here: https://raw.githubusercontent.com/TinyTapeout/tinytapeout-02/tt02/gds/user_project_wrapper.gds.gz

Note - earlier shuttles don't have the padframe included in the gds. the padframe was called caravel.
I think the full GDS / OASIS for that can be found here: https://foss-eda-tools.googlesource.com/third_party/shuttle/sky130/mpw-007/slot-001/

Chip 2 - TTP2 is manufactured with GF180mcu - https://github.com/TinyTapeout/tinytapeout-gf-0p2
Download the gds here: https://github.com/TinyTapeout/tinytapeout-gf-0p2/releases/download/tapeout-ws2512/tt_gf_wrapper.oas.tt_gf_wrapper.precheck.20251217_132152.output.gds

Chip 3 - TTIHP25b is manufactured with IHP SG13G2 - https://github.com/TinyTapeout/tinytapeout-ihp-25b
Download the oasis here: https://github.com/TinyTapeout/tinytapeout-ihp-25b/releases/download/tapeout-2509/FMD_QNC_TTIHP25b.oas

In case it's useful - chip renders: https://github.com/TinyTapeout/tinytapeout-chip-renders/tree/main/shuttles


# Building and running

Chips are configured in `build/chips.yaml` (logical layers + colours, shared by all chips) and `build/pdks.yaml` (GDS layer mapping and nominal stack heights per PDK).

```
python3 -m venv .venv && .venv/bin/pip install -r build/requirements.txt
.venv/bin/python build/fetch.py                  # download layouts to build/cache/
for c in tt02 ttgf0p2 ttihp25b; do .venv/bin/python build/build_chip.py $c; done   # tiles, vector chunks, thumbnail -> public/data/ (~4 min per chip)
.venv/bin/python build/serve.py 8000             # open http://localhost:8000 (no-cache test server)
```

Saved cross-sections: draw a line, "Save current line…", then "Download lines.json" and commit it as `public/data/<chip>/lines.json`. Coordinates in that file are absolute µm from the die's lower-left corner.

`.github/workflows/deploy.yml` rebuilds the data and publishes `public/` to GitHub Pages on push to `main`.
