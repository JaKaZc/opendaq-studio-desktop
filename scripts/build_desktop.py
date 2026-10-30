#!/usr/bin/env python3
"""Build the desktop installer for the current platform, end to end.

On macOS the app runs the native openDAQ engine (engine/):

    UI  ->  frontend/dist                       (npm run build)
    engine  ->  engine/dist/<platform>          (engine/tool/build_desktop.sh)
    installer  ->  desktop/release/             (electron-builder)

``--windows`` builds the Windows installer on the Mac. The engine is
cross-built with clang-cl against the Windows SDK that xwin downloads, and
runs on the openDAQ SDK's DLLs from its ``win_amd64`` wheel; see
``engine/tool/build_windows.sh``.

    python scripts/build_desktop.py             # installer for this machine
    python scripts/build_desktop.py --release   # the installer and the ZIP, for a release
    python scripts/build_desktop.py --windows   # the Windows installer, from a Mac
    python scripts/build_desktop.py --dir       # unpacked app, faster to test

A local build writes only the installer, the DMG or the NSIS setup. The ZIP
beside it takes about two minutes more and is written with ``--release``.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
ENGINE = ROOT / "engine"
ENGINE_WIN_DIST = ENGINE / "dist" / "windows-x86_64"
WIN_UNPACKED = DESKTOP / "release" / "win-unpacked"


def npm() -> str:
    """Resolve npm, which is ``npm.cmd`` on Windows."""
    for candidate in ("npm", "npm.cmd"):
        found = shutil.which(candidate)
        if found:
            return found
    raise SystemExit("npm was not found on PATH; install Node.js 20 or newer")


def run(command: list[str], cwd: Path = ROOT) -> None:
    run_env(command, cwd, None)


def run_env(command: list[str], cwd: Path, env: dict[str, str] | None) -> None:
    print(f"\n$ {' '.join(command)}", flush=True)
    result = subprocess.run(command, cwd=cwd, check=False, env=env)
    if result.returncode != 0:
        raise SystemExit(f"command failed with exit code {result.returncode}")


def x86_64_runs() -> bool:
    """Whether this Mac can execute x86-64 binaries, i.e. whether Rosetta is there."""
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return True
    probe = subprocess.run(["arch", "-x86_64", "/usr/bin/true"], capture_output=True, check=False)
    return probe.returncode == 0


def system_nsis_root(makensis: Path) -> Path | None:
    """The ``share/nsis`` tree belonging to a system ``makensis``.

    It has to be *that* installation's tree: NSIS compiles a script by appending
    it to a prebuilt "stub" executable from ``Stubs/``, and a stub from a
    different NSIS release is not guaranteed to understand the header a newer
    compiler writes. Mixing them produces an installer that looks structurally
    valid and does nothing when it runs.
    """
    prefix = makensis.resolve().parent.parent
    for candidate in (prefix / "share" / "nsis", prefix / "nsis"):
        if (candidate / "Stubs").is_dir():
            return candidate
    return None


def native_nsis_dir() -> Path | None:
    """A toolchain electron-builder can actually run, or ``None`` if not needed.

    electron-builder ships an x86-64 ``makensis``. On Apple silicon without
    Rosetta that cannot execute at all, and the Windows build stops there. This
    builds a directory in the shape electron-builder expects - it runs
    ``<dir>/mac/makensis`` and sets ``NSISDIR`` to ``<dir>`` - around the system's
    own NSIS installation, so compiler and stubs come from the same release.

    electron-builder's own plugins and templates are unaffected: it passes those
    by absolute path, not through ``NSISDIR``.
    """
    if x86_64_runs():
        return None

    found = shutil.which("makensis")
    if found is None:
        raise SystemExit(
            "This Mac cannot run electron-builder's bundled makensis (it is x86-64\n"
            "and Rosetta is not installed). Install a native one:\n"
            "    brew install makensis\n"
            "or install Rosetta:\n"
            "    softwareupdate --install-rosetta --agree-to-license"
        )

    makensis = Path(found)
    root = system_nsis_root(makensis)
    if root is None:
        raise SystemExit(
            f"Found {makensis} but not its NSIS data directory (Stubs, Include, Plugins).\n"
            "Reinstall it:  brew reinstall makensis"
        )

    override = ROOT / "build" / "nsis-native"
    if override.exists():
        shutil.rmtree(override)
    shutil.copytree(root, override, symlinks=True)
    (override / "mac").mkdir(exist_ok=True)
    wrapper = override / "mac" / "makensis"
    wrapper.write_text(
        "#!/bin/sh\n"
        "# electron-builder's makensis is x86-64 and this host has no Rosetta.\n"
        "# NSISDIR points at this directory, which is this makensis's own data\n"
        "# tree - so the stubs it appends to match the compiler that writes them.\n"
        f'exec "{makensis}" "$@"\n'
    )
    wrapper.chmod(0o755)

    # Overlay the parts electron-builder patches or adds. Which side each piece
    # comes from is the whole point of this function:
    #
    #   Stubs/   from the system NSIS - it must match the compiler that appends
    #            the script to it, and that is the pair that has to be a pair;
    #   Include/, Contrib/, Plugins/, elevate.exe
    #            from electron-builder - text macros, language files and Windows
    #            DLLs, none of them version-bound, and its generated script needs
    #            the extra strings its language files carry.
    bundled = electron_builder_nsis_dir()
    if bundled is None:
        raise SystemExit(
            "electron-builder's NSIS toolchain has not been downloaded yet, and its\n"
            "language files and plugins are needed.\n"
            "Run this command once more: the first run fetches the toolchain, the\n"
            "second compiles with the native makensis."
        )
    for name in ("Include", "Contrib", "Plugins"):
        source = bundled / name
        if source.is_dir():
            shutil.copytree(source, override / name, dirs_exist_ok=True)
    if (bundled / "elevate.exe").is_file():
        shutil.copy2(bundled / "elevate.exe", override / "elevate.exe")

    version = subprocess.run([str(makensis), "-VERSION"], capture_output=True, text=True, check=False)
    print(f"NSIS: {makensis} ({version.stdout.strip()}) with its own stubs from {root}")
    return override


def electron_builder_nsis_dir() -> Path | None:
    """electron-builder's downloaded NSIS toolchain, if it is there.

    Only the pieces it adds on top of a stock NSIS are taken from it - never the
    compiler or the stubs, which have to stay a matched pair.
    """
    if sys.platform.startswith("linux"):
        cache = Path(os.environ.get("ELECTRON_BUILDER_CACHE") or Path.home() / ".cache/electron-builder")
    else:
        cache = Path(
            os.environ.get("ELECTRON_BUILDER_CACHE") or Path.home() / "Library/Caches/electron-builder"
        )
    if not (cache / "nsis").is_dir():
        return None
    for entry in sorted((cache / "nsis").glob("nsis-*")):
        if (entry / "Stubs").is_dir():
            return entry
    return None


def build_windows(skip_frontend: bool, skip_engine: bool, release: bool) -> int:
    """The Windows installer, from a Mac."""
    executable = npm()
    if not skip_frontend:
        run([executable, "run", "build"], ROOT / "frontend")
    # The engine is cross-built: clang-cl against the Windows SDK from xwin, and
    # the openDAQ SDK's DLLs from its win_amd64 wheel. See its build_windows.sh.
    if not skip_engine:
        run([str(ENGINE / "tool" / "build_windows.sh")], ENGINE)
    if not (ENGINE_WIN_DIST / "studio_engine.node").is_file():
        raise SystemExit(f"No Windows engine at {ENGINE_WIN_DIST}.")

    if not (DESKTOP / "node_modules").is_dir():
        run([executable, "install"], DESKTOP)

    environment = dict(os.environ)
    if sys.platform != "win32":
        override = native_nsis_dir()
        if override is not None:
            environment["ELECTRON_BUILDER_NSIS_DIR"] = str(override)

    # rcedit is a Windows binary electron-builder runs under Wine, so off Windows
    # the icon and version strings are applied afterwards by desktop/scripts/
    # brand-exe.mjs, which edits the PE resources directly.
    cross = sys.platform != "win32"
    # `--win <target>` has to stay adjacent; everything else is a plain flag.
    skip_rcedit = ["-c.win.signAndEditExecutable=false"] if cross else []

    run_env(
        [executable, "exec", "--", "electron-builder", "--win", "--x64", "--dir", *skip_rcedit],
        DESKTOP,
        environment,
    )
    if cross:
        run(
            [executable, "exec", "--", "node", "scripts/brand-exe.mjs", str(WIN_UNPACKED / "openDAQ Studio.exe")],
            DESKTOP,
        )
    run_env(
        [
            executable,
            "exec",
            "--",
            "electron-builder",
            "--win",
            "nsis",
            *(["zip"] if release else []),
            "--x64",
            "--prepackaged",
            str(WIN_UNPACKED),
            *skip_rcedit,
        ],
        DESKTOP,
        environment,
    )
    report()
    return 0


def report() -> None:
    output = DESKTOP / "release"
    print(f"\nOutput -> {output.relative_to(ROOT)}")
    if output.is_dir():
        for entry in sorted(output.iterdir()):
            if entry.is_file() and entry.suffix in {".dmg", ".exe", ".AppImage", ".deb", ".zip"}:
                print(f"  {entry.name}  ({entry.stat().st_size / 1024 / 1024:.0f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        action="store_true",
        help="Build an unpacked application instead of installers",
    )
    parser.add_argument("--skip-frontend", action="store_true", help="Reuse the existing UI bundle")
    parser.add_argument("--skip-engine", action="store_true", help="Reuse the engine already built")
    parser.add_argument(
        "--skip-npm-install", action="store_true", help="Assume desktop/node_modules is current"
    )
    parser.add_argument(
        "--release", action="store_true", help="Write the ZIP beside the installer, as a release ships"
    )
    parser.add_argument(
        "--windows",
        action="store_true",
        help="Build the Windows installer, from a Mac (see the engine's build_windows.sh)",
    )
    args = parser.parse_args()

    if args.windows:
        return build_windows(args.skip_frontend, args.skip_engine, args.release)

    print(f"Building for {platform.system()} {platform.machine()}")

    # 1. The UI, which the app serves from studio://app/.
    executable = npm()
    if not args.skip_frontend:
        run([executable, "run", "build"], ROOT / "frontend")

    # 2. The engine with the SDK and its modules. It is built against the
    #    SDK's core and ships the libraries of the openDAQ wheel of the same
    #    release; see engine/tool/build_desktop.sh.
    if not args.skip_engine:
        run([str(ENGINE / "tool" / "build_desktop.sh")], ENGINE)

    # 3. The installer. electron-builder picks the engine and the UI up through
    #    the extraResources rules in desktop/electron-builder.yml.
    if not args.skip_npm_install and not (DESKTOP / "node_modules").is_dir():
        run([executable, "install"], DESKTOP)
    if args.dir:
        run([executable, "run", "pack"], DESKTOP)
    elif args.release or sys.platform != "darwin":
        run([executable, "run", "dist"], DESKTOP)
    else:
        # The DMG only: the ZIP of the same app takes about two minutes more.
        run([executable, "run", "build"], DESKTOP)
        run([executable, "exec", "--", "electron-builder", "--mac", "dmg"], DESKTOP)

    report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
