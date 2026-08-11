#!/usr/bin/env python3
"""Build a multi-resolution Windows .ico from a square PNG.

The macOS icon pipeline (make-icns.swift + iconutil) has no Windows twin, and
the appling's cmake template only wires an icon into the MSIX package, not into
the .exe itself. This produces the .ico that installer/appling/CMakeLists.txt
compiles into the executable as a resource, so the bare .exe carries the Listam
artwork in Explorer, the taskbar and the alt-tab switcher.

Entries are stored as PNG rather than DIB: Windows has read PNG-compressed icon
entries since Vista, and the appling manifest already declares Windows 10 as
its floor. Regenerate with:

    installer/make-ico.py installer/appling/assets/win32/icon.png \
                          installer/appling/assets/win32/icon.ico

Only stdlib plus `sips` (preinstalled on macOS) is used — no Pillow.
"""

import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# 256 is what Explorer's large-icon views sample; the small sizes stop Windows
# from downscaling 256px artwork into the 16px taskbar slot, which smears it.
SIZES = (16, 24, 32, 48, 64, 128, 256)


def resize(src: Path, size: int, out: Path) -> bytes:
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(src), "--out", str(out)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return out.read_bytes()


def build(src: Path, dst: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        images = [resize(src, size, Path(tmp) / f"{size}.png") for size in SIZES]

    # ICONDIR: reserved, type (1 = icon), image count.
    header = struct.pack("<HHH", 0, 1, len(images))
    # Directory entries are fixed width, so the first payload starts right after
    # all of them.
    offset = len(header) + 16 * len(images)

    directory = b""
    for size, data in zip(SIZES, images):
        # A 256px icon is encoded as 0 — the width/height fields are one byte.
        dim = 0 if size == 256 else size
        directory += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset
        )
        offset += len(data)

    dst.write_bytes(header + directory + b"".join(images))


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <icon.png> <icon.ico>", file=sys.stderr)
        return 2

    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    if not src.is_file():
        print(f"error: {src} not found", file=sys.stderr)
        return 1

    build(src, dst)
    print(f"wrote {dst} ({dst.stat().st_size} bytes, {len(SIZES)} sizes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
