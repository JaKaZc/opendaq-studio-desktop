"""Write a module-definition (.def) file from a Windows DLL's export table.

The openDAQ SDK's Windows DLLs come from its Python wheel, which carries no
import libraries. Every function the SDK exports is a plain C function, so
llvm-dlltool can make an import library from the names alone:

    python3 dll_def.py opendaq-64-3.dll > opendaq-64-3.def
    llvm-dlltool -m i386:x86-64 -d opendaq-64-3.def -l opendaq-64-3.lib
"""

import struct
import sys
from pathlib import Path


def exports(data: bytes) -> list[str]:
    header = struct.unpack_from("<I", data, 0x3C)[0]
    sections = struct.unpack_from("<H", data, header + 6)[0]
    optional_size = struct.unpack_from("<H", data, header + 20)[0]
    optional = header + 24
    pe32_plus = struct.unpack_from("<H", data, optional)[0] == 0x20B
    directory = optional + (112 if pe32_plus else 96)
    export_rva = struct.unpack_from("<I", data, directory)[0]
    table = optional + optional_size
    spans = []
    for index in range(sections):
        entry = table + index * 40
        size, address, _, raw = struct.unpack_from("<IIII", data, entry + 8)
        spans.append((address, size, raw))

    def offset(rva: int) -> int:
        for address, size, raw in spans:
            if address <= rva < address + max(size, 1):
                return rva - address + raw
        raise ValueError(f"no section holds RVA {rva:#x}")

    if not export_rva:
        return []
    export = offset(export_rva)
    count = struct.unpack_from("<I", data, export + 24)[0]
    names = offset(struct.unpack_from("<I", data, export + 32)[0])
    out = []
    for index in range(count):
        name = offset(struct.unpack_from("<I", data, names + 4 * index)[0])
        out.append(data[name : data.index(b"\0", name)].decode())
    return out


def main() -> int:
    path = Path(sys.argv[1])
    names = exports(path.read_bytes())
    mangled = [name for name in names if name.startswith("?")]
    if mangled:
        print(f"{path.name} exports C++ names, which need the real import library: {mangled[:3]}", file=sys.stderr)
        return 1
    print(f"LIBRARY {path.name}")
    print("EXPORTS")
    for name in names:
        print(f"    {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
