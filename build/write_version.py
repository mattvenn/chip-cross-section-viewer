#!/usr/bin/env python3
"""Write public/version.json describing the current commit.

Run by the deploy workflow; the chip picker shows it at the bottom of the page.
"""
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).parent.parent / "public" / "version.json"


def main():
    sha, stamp, subject = subprocess.check_output(
        ["git", "log", "-1", "--format=%H%n%ct%n%s"], text=True).split("\n", 2)
    # %ct is a Unix timestamp; git's %cI would keep the committer's own timezone
    date = datetime.fromtimestamp(int(stamp), timezone.utc).isoformat()
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    OUT.write_text(json.dumps({
        "sha": sha,
        "date": date,
        "subject": subject.strip(),
        "url": f"{server}/{repo}/commit/{sha}",
    }))
    print(f"wrote {OUT}: {sha[:7]} {subject.strip()}")


if __name__ == "__main__":
    main()
