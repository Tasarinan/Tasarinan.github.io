#!/usr/bin/env python3
"""
Migrate ai_wiki markdown + images into docs/ai_guide for VitePress.
Run from repo root: python scripts/migrate_ai_wiki_to_ai_guide.py
"""
from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AI_WIKI = ROOT.parent / "ai_wiki"
DEST = ROOT / "docs" / "ai_guide"

SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".turbo",
}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
DOC_EXT = {".md"}


def should_skip_dir(name: str) -> bool:
    if name in SKIP_DIRS:
        return True
    # Allow .README_images (wiki assets); skip other dot-directories
    if name.startswith(".") and name != ".README_images":
        return True
    return False


def should_copy_file(path: Path) -> bool:
    ext = path.suffix.lower()
    return ext in DOC_EXT or ext in IMG_EXT


def copy_tree(src: Path, dst: Path) -> tuple[int, int]:
    n_files = 0
    n_dirs = 0
    for dirpath, dirnames, filenames in os.walk(src, topdown=True):
        dirnames[:] = [d for d in dirnames if not should_skip_dir(d)]
        rel = Path(dirpath).relative_to(src)
        out_dir = dst / rel
        out_dir.mkdir(parents=True, exist_ok=True)
        n_dirs += 1
        for fn in filenames:
            p = Path(dirpath) / fn
            if not should_copy_file(p):
                continue
            shutil.copy2(p, out_dir / fn)
            n_files += 1
    return n_files, n_dirs


README_IMG_RE = re.compile(
    r"(?P<prefix>!?\[[^\]]*\]\()(?P<path>\.README_images/[^)\s]+)(?P<suffix>\))"
)
# Also handle HTML img src=".README_images/..."
HTML_IMG_RE = re.compile(
    r'(?P<prefix>src=["\'])(?P<path>\.README_images/[^"\'>\s]+)(?P<suffix>["\'])'
)


def rewrite_readme_images(content: str) -> str:
    def repl(m: re.Match[str]) -> str:
        return f"{m.group('prefix')}/ai_guide/{m.group('path')}{m.group('suffix')}"

    s = README_IMG_RE.sub(repl, content)
    s = HTML_IMG_RE.sub(repl, s)
    return s


def rewrite_markdown_files() -> int:
    count = 0
    for p in DEST.rglob("*.md"):
        text = p.read_text(encoding="utf-8", errors="replace")
        new = rewrite_readme_images(text)
        if new != text:
            p.write_text(new, encoding="utf-8", newline="\n")
            count += 1
    return count


def fix_img_paths() -> int:
    """Vite resolves bare relative paths as modules; prefix with ./"""
    n = 0
    for p in DEST.rglob("*.md"):
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
    return n


def main() -> int:
    if not AI_WIKI.is_dir():
        print(f"ERROR: ai_wiki not found at {AI_WIKI}", file=sys.stderr)
        return 1
    DEST.mkdir(parents=True, exist_ok=True)
    print(f"Source: {AI_WIKI}")
    print(f"Dest:   {DEST}")
    n_files, _ = copy_tree(AI_WIKI, DEST)
    print(f"Copied {n_files} files (md + images).")
    n = rewrite_markdown_files()
    print(f"Rewrote .README_images links in {n} markdown files.")
    n2 = fix_img_paths()
    print(f"Fixed img/ → ./img/ in {n2} markdown files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
