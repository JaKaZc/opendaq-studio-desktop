#!/bin/sh
# Build the core of the openDAQ SDK for this computer, which the engine and
# the optional function blocks module are compiled against:
#
#   build/openDAQ                        the SDK's source, at the release in
#                                        the repository's OPENDAQ_VERSION file
#   build/sdk-<platform>-<machine>-install   its headers, CMake package and
#                                        core libraries
#
#   engine/tool/build_sdk_core.sh
#
# The app does not ship these libraries: it runs on the libraries of the
# openDAQ wheel of the same release (see build_desktop.sh). Every SDK library
# exports plain C functions and the C++ API is header only above them, so code
# compiled against this core runs on the wheel's libraries.
#
# The SDK is cloned from OPENDAQ_SOURCE, the openDAQ repository on GitHub
# unless set (a local clone is faster). The first run takes a few minutes and
# needs network access for the SDK's dependencies; later runs only rebuild
# what changed. CMAKE and NINJA name the tools when they are not on the PATH.

set -e

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK_SOURCE="${OPENDAQ_SOURCE:-https://github.com/openDAQ/openDAQ.git}"
OPENDAQ_VERSION="${OPENDAQ_VERSION:-$(tr -d ' \r\n' < "$HERE/../OPENDAQ_VERSION")}"
SDK_REF="${SDK_REF:-v$OPENDAQ_VERSION}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
BUILD="$HERE/build"
CMAKE="${CMAKE:-cmake}"
NINJA="${NINJA:-ninja}"
for tool in git "$CMAKE" "$NINJA"; do
  command -v "$tool" > /dev/null 2>&1 || { echo "$tool is missing; see Requirements in README.md" >&2; exit 1; }
done

mkdir -p "$BUILD"
if [ ! -d "$BUILD/openDAQ/.git" ]; then
  git clone -q "$SDK_SOURCE" "$BUILD/openDAQ"
fi
if [ "$(git -C "$BUILD/openDAQ" describe --tags --exact-match 2> /dev/null)" != "$SDK_REF" ]; then
  git -C "$BUILD/openDAQ" fetch -q --tags origin
  git -C "$BUILD/openDAQ" checkout -q --force "$SDK_REF"
fi

COMMON="-G Ninja -DCMAKE_MAKE_PROGRAM=$NINJA -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5"
if [ "$(uname -s)" = Darwin ]; then
  # The deployment target of the openDAQ wheel's libraries.
  COMMON="$COMMON -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0"
fi
if command -v ccache > /dev/null 2>&1; then
  COMMON="$COMMON -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
  export CCACHE_BASEDIR="$HERE"
fi

# Configured only when the folder has no build yet or its options changed.
FOLDER="$BUILD/sdk-$PLATFORM"
OPTIONS="$BUILD/openDAQ $COMMON"
if [ ! -f "$FOLDER/build.ninja" ] || [ "$(cat "$FOLDER/.configure-options" 2> /dev/null)" != "$OPTIONS" ]; then
  echo "== configuring the openDAQ SDK core, $SDK_REF"
  # Without tests, the SDK builds its core and no modules: the app takes the
  # modules from the wheel.
  # shellcheck disable=SC2086
  "$CMAKE" -S "$BUILD/openDAQ" -B "$FOLDER" $COMMON \
    -DOPENDAQ_ENABLE_TESTS=OFF -DOPENDAQ_ENABLE_TEST_UTILS=OFF > "$BUILD/sdk-configure.log"
  printf '%s' "$OPTIONS" > "$FOLDER/.configure-options"
fi
echo "== openDAQ SDK core, $SDK_REF"
"$CMAKE" --build "$FOLDER" > "$BUILD/sdk-build.log"
"$CMAKE" --install "$FOLDER" --prefix "$BUILD/sdk-$PLATFORM-install" > "$BUILD/sdk-install.log"
