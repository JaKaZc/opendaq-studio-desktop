# openDAQ Studio engine

The native openDAQ engine of openDAQ Studio: one openDAQ instance behind the
Studio API, written in C++. The desktop app in this repository (Electron)
runs it, and so does the openDAQ Studio phone app, a separate project, so
both Studios share one implementation of every route.

It answers the routes and JSON shapes in `../docs/API.md`,
produces the binary ODQV sample frames and emits the events the UI reads. The
API tests in `tests/api` are its contract; see Testing below.

## How the apps reach it

| App | Host | Requests | Live data and events |
|---|---|---|---|
| Desktop | `studio_engine.node` in an Electron utility process (`desktop/src/engine-host.ts`) | The main process answers `studio://app/api/...` with them | A message port per window |
| Phone | `libstudio_engine.so` through Dart FFI (`lib/api/engine.dart`) | `studio_request` | `studio_poll`, `studio_events` |

The C interface is `include/studio_engine.h`. Requests are a method, a route,
the query as JSON and the body as JSON; the answer is JSON and an HTTP-style
status. Live data is per client: each desktop window opens one, and the phone
app uses client 0 through `studio_subscribe` and `studio_poll`.

The desktop app opens no network port for its UI or API. The engine does open
the ports of openDAQ itself: discovery, the servers the user adds, and the NTP
time server on UDP 12300.

## Layout

| Path | What it holds |
|---|---|
| `include/studio_engine.h` | The C interface |
| `src/c_api.cpp` | The C interface's functions; start options |
| `src/engine.h`, `engine.cpp` | The instance, the router, core events and their history |
| `src/common.h`, `common.cpp` | Errors, JSON, openDAQ values to JSON and back, component lookup |
| `src/streaming.cpp` | Readers, rings, clients, decimation, the ODQV frames |
| `src/pictures.cpp` | The newest picture of an image signal |
| `src/logs.cpp` | The log the Logs page reads: the engine's lines and the SDK's file sink |
| `src/timeserver.cpp`, `timesync.cpp` | The NTP time server and the device clock measurements (desktop) |
| `src/value_text.cpp` | JSON values as the texts the UI shows: literals, numbers, ASCII-only JSON |
| `src/platform.cpp` | Logging, the data folder and loading a module by hand, per platform |
| `src/routes/` | One file per area of the API; `routes.h` lists them |
| `node/addon.cpp` | The Node addon for the desktop app |
| `tests/studio_cli.cpp` | A command line client, for tests and for checks under Wine |
| `tool/build_desktop.sh` | Builds the engine for this computer into `dist/<platform>/` |
| `tool/build_sdk_core.sh` | Clones and builds the openDAQ SDK core the engine is compiled against, in `build/` |
| `tool/build_windows.sh` | Cross-builds the engine for Windows x64 into `dist/windows-x86_64/` |
| `tool/serve.mjs` | A development server: the API over HTTP, live data and events over a WebSocket |
| `tests/api/` | The API tests, against `tool/serve.mjs` |

## Building

### Desktop (macOS)

```sh
tool/build_desktop.sh
```

This builds the engine, its addon and `studio_cli` into
`dist/darwin-arm64/`, next to the SDK's core libraries and modules. The
engine is compiled against the SDK core that `tool/build_sdk_core.sh` clones
and builds at `v3.40.3` in `build/`, and runs on the libraries of the openDAQ
wheel of the same release, which the desktop app ships. Every SDK library
exports plain C functions and the C++ API is header only above them, so the
two match.

When the repository opendaq-universal-function-blocks is beside this one, or
`UNIVERSAL_FUNCTION_BLOCKS` names its folder, the script builds its module
against the same SDK core and puts it into `dist/darwin-arm64/modules/`.
Without it, the engine is built without the module.

The openDAQ release is in the repository's `OPENDAQ_VERSION` file, `3.40.3`.
The SDK core is built at it and the wheel is downloaded at it, and
`tool/check_sdk_version.sh` stops the build when the core's headers and the
wheel's metadata name different releases. The environment variable
`OPENDAQ_VERSION` overrides the file for one build.

The desktop app's build (`../scripts/build_desktop.py`) runs
this script and packages `dist/darwin-arm64/` as `resources/engine/`.

### Phone (Android arm64)

`CMakeLists.txt` also builds the engine for Android, where the openDAQ Studio
phone app loads it through Dart FFI. That app and its build are not part of
this repository. The openDAQ Device Server does not use the engine.

### Windows (cross-built on the Mac)

```sh
tool/build_windows.sh
```

This builds `dist/windows-x86_64/`. Nothing of openDAQ's is compiled: the
SDK's DLLs and modules come from the openDAQ `win_amd64` wheel, and
`tool/dll_def.py` and `llvm-dlltool` make import libraries from their export
tables. The engine, the addon, `studio_cli.exe` and the Universal renderer
module are compiled with `clang-cl` and `lld-link` (Homebrew `llvm` and `lld`)
against the Windows SDK and C runtime from `xwin`
(`tool/windows-toolchain.cmake`), with the SDK's headers and an
`openDAQConfig.cmake` written from `tool/openDAQConfig.windows.cmake.in`.
`tool/pe_check.py` checks that every binary is x64.

The addon imports Node-API from `node.exe` and delay-loads it;
`node/win_delay_load_hook.cpp` points that at Electron's executable, as
node-gyp does for every addon.

The Windows SDK is downloaded once, accepting Microsoft's license:

```sh
xwin --accept-license --arch x86_64 --cache-dir build/xwin-cache splat --output build/xwin
```

The binaries need the Visual C++ runtime (`MSVCP140.dll` and the two
`VCRUNTIME140` DLLs), which is not shipped yet.

## Testing

The API tests start the engine behind `tool/serve.mjs` with the SDK's
reference device and check routes, JSON shapes, statuses, the WebSocket's
messages and the binary frames. They need `tool/build_desktop.sh` run first,
and Python with the packages in `tests/api/requirements.txt`:

```sh
python3 -m venv .venv-tests
.venv-tests/bin/pip install -r tests/api/requirements.txt
.venv-tests/bin/pytest tests/api -q
```

`STUDIO_ENGINE_ROOT` points the tests at another working copy of the engine.

`studio_cli` reads one request per line and answers each with the status and
the JSON:

```sh
dist/darwin-arm64/studio_cli '{"moduleDirectory":"dist/darwin-arm64/modules","devices":["daqref://device0"]}'
```

## What the API does not offer

- SDK switching: the SDK is the one the app was built with, and
  `/api/system/info` says `"embedded": true`.
- A read-only mode, remote access to the UI and shutdown over the API.
