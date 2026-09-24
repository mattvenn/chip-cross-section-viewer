#!/usr/bin/env python3
"""Download chip layout files listed in chips.yaml into build/cache/."""
import base64
import gzip
import shutil
import sys
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).parent
CACHE = HERE / "cache"


def fetch(chip_id, chip):
    CACHE.mkdir(exist_ok=True)
    dest = CACHE / chip["file"]
    if dest.exists():
        print(f"{chip_id}: {dest} already present")
        return dest
    url = chip["url"]
    print(f"{chip_id}: downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    if chip.get("encoding") == "base64":
        raw = tmp.with_suffix(".b64")
        tmp.rename(raw)
        with open(raw, "rb") as src, open(tmp, "wb") as f:
            f.write(base64.b64decode(src.read()))
        raw.unlink()
    if url.split("?")[0].endswith(".gz"):
        with gzip.open(tmp) as src, open(dest, "wb") as f:
            shutil.copyfileobj(src, f)
        tmp.unlink()
    else:
        tmp.rename(dest)
    return dest


def main():
    chips = yaml.safe_load(open(HERE / "chips.yaml"))["chips"]
    wanted = sys.argv[1:] or list(chips)
    for chip_id in wanted:
        fetch(chip_id, chips[chip_id])


if __name__ == "__main__":
    main()
