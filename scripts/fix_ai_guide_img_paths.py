#!/usr/bin/env python3
"""
Rewrite bare relative asset/link paths in ai_guide markdown for Vite/VitePress:
- img/ → ./img/ (markdown + img src)
- doc/ → ./doc/ (same; avoids Rollup resolving as bare module)
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "docs" / "ai_guide"


def main() -> None:
    n = 0
    for p in ROOT.rglob("*.md"):
        t = p.read_text(encoding="utf-8", errors="replace")
        o = t
        t = t.replace("](img/", "](./img/")
        t = t.replace("](doc/", "](./doc/")
        t = t.replace('src="img/', 'src="./img/')
        t = t.replace('src="doc/', 'src="./doc/')
        t = t.replace("src='img/", "src='./img/")
        t = t.replace("src='doc/", "src='./doc/")
        if t != o:
            p.write_text(t, encoding="utf-8", newline="\n")
            n += 1
    print(f"updated {n} files")


if __name__ == "__main__":
    main()
