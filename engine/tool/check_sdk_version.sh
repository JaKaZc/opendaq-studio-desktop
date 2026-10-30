#!/bin/sh
# Stop the build when the SDK core the engine is compiled against and the
# openDAQ libraries the app ships are not the same release:
#
#   tool/check_sdk_version.sh <sdk core install> <opendaq package> <release>
#
# The engine is compiled against the core's headers and runs on the libraries
# of the openDAQ wheel, so the two must be one release. A mismatch would build
# and then fail, or misbehave, only when the app runs. The package is the
# wheel's unpacked `opendaq` folder; its release is read from the wheel's
# dist-info beside it.

set -e

INSTALL="$1"
PACKAGE="$2"
WANT="$3"

HEADER="$INSTALL/include/opendaq/opendaq_config.h"
if [ ! -f "$HEADER" ]; then
  echo "No SDK core headers at $INSTALL" >&2
  exit 1
fi
part() {
  sed -n "s/^#define OPENDAQ_OPENDAQ_$1_VERSION *\([0-9][0-9]*\).*/\1/p" "$HEADER"
}
CORE="$(part MAJOR).$(part MINOR).$(part PATCH)"

METADATA="$(ls "$PACKAGE"/../opendaq-*.dist-info/METADATA 2> /dev/null | head -1)"
if [ -z "$METADATA" ]; then
  echo "Cannot tell which release the openDAQ package at $PACKAGE is: there is no opendaq-*.dist-info beside it" >&2
  exit 1
fi
WHEEL="$(sed -n 's/^Version: *//p' "$METADATA" | head -1 | tr -d '\r')"

if [ "$CORE" != "$WHEEL" ] || [ "$CORE" != "$WANT" ]; then
  echo "The openDAQ releases differ: OPENDAQ_VERSION is $WANT, the engine is compiled against the SDK core $CORE," >&2
  echo "and the app would ship the libraries of openDAQ $WHEEL. They must be one release." >&2
  exit 1
fi
echo "== openDAQ $CORE: the SDK core and the libraries the app ships are one release"
