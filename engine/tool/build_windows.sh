#!/bin/sh
# Cross-build the engine for Windows x64 on a Mac, into dist/windows-x86_64/,
# as the desktop app's Windows installer ships it:
#
#   studio_engine.dll           the engine
#   studio_engine.node          its Node addon
#   opendaq-64-3.dll ...        the SDK's core DLLs, from the openDAQ wheel
#   modules/                    the SDK's modules, from the same wheel, and
#                               UniversalFunctionBlocksModule, built here when
#                               opendaq-universal-function-blocks is there
#   studio_cli.exe              a command line client, for checks under Wine
#
# Nothing of openDAQ's is compiled: its DLLs come from the win_amd64 wheel of
# OPENDAQ_VERSION, and import libraries are made from their export tables
# (tool/dll_def.py). Only this engine, its addon and the optional function
# blocks module are compiled, with clang-cl and lld-link against the Windows
# SDK and C runtime that xwin downloads. The headers are those of the SDK core
# that tool/build_sdk_core.sh builds on the Mac.
#
#   engine/tool/build_windows.sh
#
# Needs: brew install llvm lld xwin, and once
#   xwin --accept-license --arch x86_64 --cache-dir $XWIN_DIR-cache splat --output $XWIN_DIR
# which accepts Microsoft's license for the Windows SDK and the C runtime.

set -e

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
RENDERER="${UNIVERSAL_FUNCTION_BLOCKS:-$(cd "$DESKTOP/.." && pwd)/opendaq-universal-function-blocks}"
# One release for everything: the SDK core is built at it and the wheel is
# downloaded at it. It is in the repository's OPENDAQ_VERSION file; the
# environment variable of that name overrides it.
OPENDAQ_VERSION="${OPENDAQ_VERSION:-$(tr -d ' \r\n' < "$DESKTOP/OPENDAQ_VERSION")}"
export OPENDAQ_VERSION
# The SDK names its libraries after its major version, such as opendaq-64-3.dll.
SDK_MAJOR="${OPENDAQ_VERSION%%.*}"
SDK_INSTALL="$HERE/build/sdk-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)-install"
XWIN_DIR="${XWIN_DIR:-$HERE/build/xwin}"
export XWIN_DIR
BUILD="$HERE/build/windows-x86_64"
DIST="$HERE/dist/windows-x86_64"
CMAKE="${CMAKE:-cmake}"
NINJA="${NINJA:-ninja}"
for tool in "$CMAKE" "$NINJA" python3 npm; do
  command -v "$tool" > /dev/null 2>&1 || { echo "$tool is missing; see Requirements in README.md" >&2; exit 1; }
done
DLLTOOL=/opt/homebrew/opt/llvm/bin/llvm-dlltool

for tool in "$DLLTOOL" /opt/homebrew/opt/llvm/bin/clang-cl /opt/homebrew/opt/lld/bin/lld-link; do
  [ -x "$tool" ] || { echo "$tool is missing; brew install llvm lld" >&2; exit 1; }
done
[ -d "$XWIN_DIR/sdk" ] || { echo "No Windows SDK at $XWIN_DIR; run xwin splat (see above)" >&2; exit 1; }
"$HERE/tool/build_sdk_core.sh"
[ -d "$HERE/node/node_modules/node-addon-api" ] || npm --prefix "$HERE/node" install --no-audit --no-fund

mkdir -p "$BUILD"

echo "== openDAQ $OPENDAQ_VERSION for Windows, from its wheel"
if ! ls "$BUILD"/wheel/opendaq-"$OPENDAQ_VERSION"-*win_amd64.whl > /dev/null 2>&1; then
  rm -rf "$BUILD/wheel"
  python3 -m pip download "opendaq==$OPENDAQ_VERSION" --platform win_amd64 --python-version 3.12 \
    --only-binary=:all: --no-deps -d "$BUILD/wheel" -q
fi
rm -rf "$BUILD/sdk" "$BUILD/lib"
mkdir -p "$BUILD/sdk" "$BUILD/lib"
unzip -q -o "$BUILD"/wheel/opendaq-*.whl 'opendaq/*.dll' 'opendaq/modules/*' 'opendaq-*.dist-info/*' -d "$BUILD/sdk"
"$HERE/tool/check_sdk_version.sh" "$SDK_INSTALL" "$BUILD/sdk/opendaq" "$OPENDAQ_VERSION"

echo "== import libraries"
for library in "opendaq-64-$SDK_MAJOR" "daqcoreobjects-64-$SDK_MAJOR" "daqcoretypes-64-$SDK_MAJOR"; do
  python3 -I "$HERE/tool/dll_def.py" "$BUILD/sdk/opendaq/$library.dll" > "$BUILD/lib/$library.def"
  "$DLLTOOL" -m i386:x86-64 -d "$BUILD/lib/$library.def" -l "$BUILD/lib/$library.lib"
done
"$DLLTOOL" -m i386:x86-64 -d "$HERE/node/node_modules/node-api-headers/def/node_api.def" -l "$BUILD/lib/node_api.lib"

mkdir -p "$BUILD/cmake"
sed -e "s|@SDK_INCLUDE@|$SDK_INSTALL/include|" -e "s|@SDK_LIB@|$BUILD/lib|" -e "s|@SDK_MAJOR@|$SDK_MAJOR|g" \
  "$HERE/tool/openDAQConfig.windows.cmake.in" > "$BUILD/cmake/openDAQConfig.cmake"

COMMON="-G Ninja -DCMAKE_MAKE_PROGRAM=$NINJA -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_TOOLCHAIN_FILE=$HERE/tool/windows-toolchain.cmake -DXWIN_DIR=$XWIN_DIR
  -DopenDAQ_DIR=$BUILD/cmake -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL"

echo "== engine"
# shellcheck disable=SC2086
"$CMAKE" -S "$HERE" -B "$BUILD/engine" $COMMON \
  -DRAPIDJSON_INCLUDE="$HERE/build/openDAQ/external/rapidjson/include" \
  -DSTUDIO_ENGINE_TOOLS=ON -DSTUDIO_ENGINE_NODE=ON -DNODE_API_LIB="$BUILD/lib/node_api.lib" > "$BUILD/engine.configure.log"
"$CMAKE" --build "$BUILD/engine"

BLOCKS=""
if [ -f "$RENDERER/CMakeLists.txt" ]; then
  echo "== function blocks module, from $RENDERER"
  # shellcheck disable=SC2086
  "$CMAKE" -S "$RENDERER" -B "$BUILD/renderer" $COMMON > "$BUILD/renderer.configure.log"
  "$CMAKE" --build "$BUILD/renderer"
  BLOCKS="$BUILD/renderer/universal_function_blocks_module.module.dll"
else
  echo "== function blocks module: none at $RENDERER, so the app is built without it"
fi

echo "== $DIST"
rm -rf "$DIST"
mkdir -p "$DIST/modules"
cp "$BUILD/engine/studio_engine.dll" "$BUILD/engine/studio_engine.node" "$BUILD/engine/studio_cli.exe" "$DIST/"
cp "$BUILD"/sdk/opendaq/opendaq-64-"$SDK_MAJOR".dll "$BUILD"/sdk/opendaq/daqcore*.dll "$DIST/"
cp "$BUILD"/sdk/opendaq/modules/* "$DIST/modules/"
if [ -n "$BLOCKS" ]; then
  cp "$BLOCKS" "$DIST/modules/"
fi
python3 -I "$HERE/tool/pe_check.py" "$DIST"
ls -l "$DIST" "$DIST/modules"
