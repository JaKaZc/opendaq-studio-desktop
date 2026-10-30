"""Check that every binary in a folder is a Windows x64 (PE32+, AMD64) file.

A cross build that picked up one of the host's libraries would look complete
and fail on the first Windows PC; this catches it before packaging.

    python3 pe_check.py dist/windows-x86_64
"""

import struct
import sys
from pathlib import Path


def machine(path: Path) -> str:
    data = path.read_bytes()[:4096]
    if data[:2] != b"MZ":
        return "not a PE file"
    header = struct.unpack_from("<I", data, 0x3C)[0]
    if data[header : header + 4] != b"PE\0\0":
        return "not a PE file"
    kind = struct.unpack_from("<H", data, header + 4)[0]
    return "x86-64" if kind == 0x8664 else f"machine {kind:#x}"


def main() -> int:
    root = Path(sys.argv[1])
    binaries = [p for p in sorted(root.rglob("*")) if p.suffix.lower() in {".dll", ".exe", ".node"}]
    wrong = [(p, machine(p)) for p in binaries if machine(p) != "x86-64"]
    for path, kind in wrong:
        print(f"{path.relative_to(root)}: {kind}")
    print(f"checked {len(binaries)} binaries, {len(wrong)} wrong")
    return 1 if wrong or not binaries else 0


if __name__ == "__main__":
    raise SystemExit(main())
