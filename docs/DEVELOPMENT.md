# Development

## Requirements

The README's Requirements section lists the tools. In short:

- A Mac with Apple silicon. Both installers are built there.
- Node.js 20 or newer, and Python 3 for the build script and the engine's API
  tests.
- The Xcode command line tools, CMake 3.24 or newer and Ninja for the engine.
- Nothing else: the engine's build clones the openDAQ SDK at `v3.40.3`,
  builds the SDK core that the engine is compiled against, and downloads the
  openDAQ wheel whose libraries and modules the app ships. The repository
  opendaq-universal-function-blocks beside this one is optional; when it is
  there, its module is built and shipped too.
- No hardware. The SDK ships reference devices that generate real signals.

## Getting started

```bash
make setup      # npm packages of the UI, the shell and the engine; a venv for the API tests
make engine     # the engine, the SDK and its modules -> engine/dist/darwin-arm64/
make desktop    # builds the UI and the shell and starts the app from source
```

`make engine` runs `engine/tool/build_desktop.sh`. The first run also clones
and builds the SDK core in `engine/build/`, which takes a few minutes. Run it
again after every change to the engine.

`make help` lists every target. Each one is a thin wrapper around the
underlying tool, so the commands in the `Makefile` work without make.

## Working on the UI in a browser

The UI can run in a browser with hot reload, against the engine's
development server:

```bash
make serve      # terminal 1: the engine's API on port 8420, with daqref://device0
make frontend   # terminal 2: the UI on http://localhost:5173
```

`make serve` runs `engine/tool/serve.mjs`. It serves the
engine's API over HTTP and its live data and events over a WebSocket at
`/api/ws`, through the same Node addon the app loads. It takes `--device`
(repeatable), `--port`, `--stream-interval` and `--ui` to serve a built UI
itself. The Vite dev server proxies `/api`, including the WebSocket, to
`http://127.0.0.1:8420`; `OPENDAQ_STUDIO_BACKEND` points it elsewhere.

In a browser the UI uses that WebSocket. In the app it uses the window's
message port, which carries the same messages. The app never starts the
development server.

The engine keeps its logs and log levels in the data folder the installed
app uses. Point a development run at a scratch folder so it does not change
the installed app's:

```bash
OPENDAQ_STUDIO_DATA_DIR=.dev-data make serve
```

## Layout

```
frontend/src/
  lib/            API client, realtime, ring buffer, FFT, trigger, tree projections
  store/          zustand stores and the non-React trace store
  components/
    ui/           buttons, fields, modals, menus, layout primitives
    layout/       header, logo, status bar, log and help panels
    tree/         the navigator
    detail/       property inspector (cards) and grid (table), live outputs, input ports, block header
    topology/     the dataflow diagram
    time/         device time and clocks
    dialogs/      add device/block/server, configuration, command palette
    signals/      the Signals mode: tracks, render loop, recorder bar, inspector
    scope/        the Scope: canvas rendering, toolbar, legend, trigger, spectrum
    pages/        the Devices, Fleet and Modules pages

desktop/src/      the Electron shell: main.ts, engine.ts, engine-host.ts, preload.ts
assets/brand/     the logo and badge outlines, taken from the Design Manual
scripts/          build_desktop.py (the installers),
                  brandkit.py and build_icons.py (icons and installer artwork)

engine/
  src/routes/     one file per area of the API
  src/streaming.cpp   readers, rings, clients, decimation, ODQV frames
  tests/api/      the API tests
  tool/           build_desktop.sh, build_windows.sh, serve.mjs
```

The engine's README describes its layout in full.

## Tests

```bash
make test
```

This runs two suites:

- `npm --prefix frontend run test`: the UI's unit tests over its pure logic.
  They need no engine.
- `pytest engine/tests/api -q`: the engine's API tests. They
  start `tool/serve.mjs` on a free port with `daqref://device0` and a
  temporary `OPENDAQ_STUDIO_DATA_DIR` and need `make engine` run first. The
  suite is the engine's contract. It exercises the real SDK, so a failure there is usually
  a real difference in behaviour.

## Quality gates

```bash
make lint
```

This type checks and lints the UI and type checks the desktop shell.

The UI enables two rules the React plugin leaves off: `react-hooks/refs` and
`react-hooks/set-state-in-effect`. Both catch patterns that produce visible
flashes and stale renders in a data-heavy UI.

## Adding an endpoint

1. Add the route to its area's file in `engine/src/routes/`
   (`routes.h` lists the areas). A route returns its JSON answer or refuses
   with `fail(status, code, message)`. An openDAQ exception becomes a
   structured refusal, mostly `sdk_error`. Request bodies are strict: an
   unknown member is refused with 422.
2. Rebuild the engine with `make engine` and add a test to `tests/api/`.
3. Add the client method to `frontend/src/lib/api.ts` and the payload type to
   `types.ts`.
4. Document it in `docs/API.md`.

The desktop shell needs no change, because it passes every `/api/` request
to the engine.

## Adding a property editor

`components/detail/PropertyGrid.tsx` dispatches on `valueType` and on the
presence of `selectionValues` or `suggestedValues`. Add a branch there. A new
conversion of a core type belongs in the engine: `src/common.cpp` converts
openDAQ values to JSON and back. `src/routes/properties.cpp` writes them. The
card view (`PropertyInspector.tsx`) falls back to the same `PropertyEditor`, so a new
editor appears in both. Only a control that is specific to the cards (buttons
for a short choice, a slider for a bounded number) belongs in its
`CardEditor`, with the rule for when to use it in `lib/properties.ts`.

## Keeping to what the SDK offers

openDAQ Studio presents the openDAQ SDK and adds no processing or options of
its own. Before adding a feature, find the SDK concept it belongs to: a
function block type, a property, a recorder, a server or a status. If the SDK
has none, the feature does not belong here. The Scope is the one deliberate
exception and analysis of the application's own belongs there.

## Debugging the data path

`GET /api/system/diagnostics` reports the calls the engine host makes into
the engine (requests and polls) with their durations and failures, the
per-signal sample rates, dropped reads, buffer occupancy and each window's
subscriptions. When a trace stutters, it says whether the problem is the
device, the engine or the UI.

In the Log tab of the event drawer the Studio level `debug` logs every
request with its duration. The SDK's level takes effect when the app starts next. **Help ▸
Show engine log** shows what the engine wrote to its output.
`engine/dist/darwin-arm64/studio_cli` answers requests from
the command line without Electron; the engine's README shows how.
