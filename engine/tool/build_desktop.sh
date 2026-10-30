#!/bin/sh
# Build the engine for this computer (macOS or Linux) into
# dist/<platform>-<machine>/, as the desktop app ships it:
#
#   libstudio_engine.*          the engine
#   studio_engine.node          its Node addon, for the desktop app
#   libopendaq-64-3.* ...       the SDK's core libraries, from the openDAQ wheel
#   modules/                    the SDK's modules, from the same wheel, and
#                               UniversalFunctionBlocksModule when it is there
#   studio_cli                  a command line client, for tests
#
# The engine is compiled against the SDK core that tool/build_sdk_core.sh
# builds at SDK_REF, and runs on the libraries of the openDAQ wheel of the
# same release, the ones the desktop app ships.
#
#   engine/tool/build_desktop.sh
#
# The app needs no other repository. When opendaq-universal-function-blocks
# is beside this repository, or UNIVERSAL_FUNCTION_BLOCKS names its folder,
# the module is built here against the same SDK core and shipped with the
# SDK's modules; without it, the app is built without it. CMAKE and NINJA name
# the tools when they are not on the PATH.
#
# SDK_VERSION picks the openDAQ release (3.40.3); its macOS wheel is downloaded
# once into build/. WHEEL_DIR points at an unpacked `opendaq` package instead.

set -e

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
RENDERER="${UNIVERSAL_FUNCTION_BLOCKS:-$(cd "$DESKTOP/.." && pwd)/opendaq-universal-function-blocks}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
SDK_INSTALL="$HERE/build/sdk-$PLATFORM-install"
BUILD="$HERE/build/$PLATFORM"
DIST="$HERE/dist/$PLATFORM"
mkdir -p "$HERE/build"
CMAKE="${CMAKE:-cmake}"
NINJA="${NINJA:-ninja}"
for tool in "$CMAKE" "$NINJA" python3 npm; do
  command -v "$tool" > /dev/null 2>&1 || { echo "$tool is missing; see Requirements in README.md" >&2; exit 1; }
done
SDK_VERSION="${SDK_VERSION:-3.40.3}"

"$HERE/tool/build_sdk_core.sh"
if [ -z "$WHEEL_DIR" ]; then
  # The SDK's libraries and modules as openDAQ publishes them, in its wheel.
  WHEEL="$HERE/build/wheel-$PLATFORM"
  if ! ls "$WHEEL"/opendaq-"$SDK_VERSION"-*.whl > /dev/null 2>&1; then
    rm -rf "$WHEEL"
    # The libraries in the wheel are the same for every Python version.
    case "$PLATFORM" in
      darwin-arm64) WHEEL_TAGS="--python-version 3.12 --platform macosx_11_0_arm64" ;;
      *) WHEEL_TAGS="" ;;
    esac
    # shellcheck disable=SC2086
    python3 -m pip download "opendaq==$SDK_VERSION" $WHEEL_TAGS --only-binary=:all: --no-deps -d "$WHEEL" -q
  fi
  rm -rf "$WHEEL/unpacked"
  unzip -q -o "$WHEEL"/opendaq-*.whl 'opendaq/*' -d "$WHEEL/unpacked"
  WHEEL_DIR="$WHEEL/unpacked/opendaq"
fi
if [ ! -d "$WHEEL_DIR/modules" ]; then
  echo "No openDAQ package at $WHEEL_DIR" >&2
  exit 1
fi

COMMON="-G Ninja -DCMAKE_MAKE_PROGRAM=$NINJA -DCMAKE_BUILD_TYPE=Release"
if [ "$(uname -s)" = Darwin ]; then
  COMMON="$COMMON -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0"
fi
# A compiler cache: a file compiled before, in any build folder, with the
# same flags, comes from the cache instead of the compiler.
if command -v ccache > /dev/null 2>&1; then
  COMMON="$COMMON -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
  export CCACHE_BASEDIR="$DESKTOP"
fi

if [ ! -d "$HERE/node/node_modules/node-addon-api" ]; then
  npm --prefix "$HERE/node" install --no-audit --no-fund
fi

echo "== engine"
# shellcheck disable=SC2086
"$CMAKE" -S "$HERE" -B "$BUILD" $COMMON -DCMAKE_PREFIX_PATH="$SDK_INSTALL" \
  -DRAPIDJSON_INCLUDE="$HERE/build/openDAQ/external/rapidjson/include" \
  -DSTUDIO_ENGINE_TOOLS=ON -DSTUDIO_ENGINE_NODE=ON > "$BUILD.configure.log"
"$CMAKE" --build "$BUILD"

BLOCKS=""
if [ -f "$RENDERER/CMakeLists.txt" ]; then
  echo "== function blocks module, from $RENDERER"
  # shellcheck disable=SC2086
  "$CMAKE" -S "$RENDERER" -B "$HERE/build/function-blocks-$PLATFORM" $COMMON \
    -DCMAKE_PREFIX_PATH="$SDK_INSTALL" > "$HERE/build/function-blocks.configure.log"
  "$CMAKE" --build "$HERE/build/function-blocks-$PLATFORM"
  BLOCKS="$HERE/build/function-blocks-$PLATFORM"
else
  echo "== function blocks module: none at $RENDERER, so the app is built without it"
fi

echo "== $DIST"
# A fresh folder each time: macOS kills a process that loads a library
# overwritten in place, and a module left from an older build would load too.
rm -rf "$DIST"
mkdir -p "$DIST/modules"
cp "$BUILD"/libstudio_engine.* "$BUILD/studio_engine.node" "$BUILD/studio_cli" "$DIST/"
for library in "$WHEEL_DIR"/libopendaq-*.* "$WHEEL_DIR"/libdaqcore*.*; do
  case "$library" in
    *.so|*.dylib) cp "$library" "$DIST/" ;;
  esac
done
cp "$WHEEL_DIR"/modules/* "$DIST/modules/"
if [ -n "$BLOCKS" ]; then
  cp "$BLOCKS"/libuniversal_function_blocks_module.module.* "$DIST/modules/"
fi

if [ "$(uname -s)" = Darwin ]; then
  # Local symbols are a third of the SDK's size. Exported symbols stay, so
  # modules still load by name; stripping breaks a file's signature, so each
  # is signed again ad hoc (the app's build signs them properly).
  for library in "$DIST"/*.dylib "$DIST"/*.node "$DIST"/modules/*.dylib; do
    strip -x "$library" 2> /dev/null || true
    codesign --force --sign - "$library" > /dev/null 2>&1
  done
fi
ls -l "$DIST" "$DIST/modules"
