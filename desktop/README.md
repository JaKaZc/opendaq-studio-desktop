# Desktop shell

The Electron host of openDAQ Studio. It runs the native openDAQ engine
(`../engine`) and shows the UI in a window.

## How it works

- The engine runs in an Electron utility process (`src/engine-host.ts`) that
  loads the engine's Node addon `studio_engine.node`. A crash in the SDK or in
  a module ends that process and leaves the windows open.
- The UI is served from the `studio://app/` scheme. The main process answers
  the UI's `/api/...` requests: it passes each one to the engine host and
  returns the engine's JSON answer with its status. `/api/signals/picture`
  is answered with the picture's own bytes.
- Each window gets a message port to the engine host whenever its page loads.
  The port carries what the WebSocket at `/api/ws` carries against the
  engine's development server: JSON control and event messages and binary
  ODQV sample frames. Each window is a client of live data of its own.

## What it does

- Starts the engine before it shows a window. When the engine does not
  start, it shows the reason and the engine's recent output instead.
- Adds a native menu with saving and loading the configuration, zoom and the
  developer tools.
- Holds a single-instance lock. A second launch focuses the existing window
  and does not start a second openDAQ instance.
- Stops the engine on quit, so the SDK releases its devices cleanly. The quit
  waits up to five seconds for the engine.
- Keeps the engine's output in memory and shows it under **Help ▸ Show engine
  log**.

## Security model

- No network port is opened for the UI or the API. The engine opens only the
  ports of openDAQ itself: discovery, the servers the user adds and the NTP
  time server on UDP 12300.
- The renderer runs with `contextIsolation` and `sandbox` and without Node
  integration.
- `preload.ts` exposes the native menu's commands, restricted to a fixed
  channel list. On `studio:` pages it also exposes the window's port for live
  data. No filesystem, shell or general IPC surface reaches the page.
- Navigation and `window.open` to anything outside `studio://app/` are handed
  to the system browser and are not loaded in the privileged window.

## Running from source

The engine has to be built once and the UI has to be built. From the
repository root:

```bash
make engine     # ../engine/dist/darwin-arm64/
make desktop    # builds the UI, then the shell and starts it
```

`npm run dev` in this folder does the last step on its own. A run from source
loads the engine from `../engine/dist/<platform>/` and the UI
from `../frontend/dist/`. A package carries both under `resources/`. A run
from source shows the openDAQ icon in the Dock and the window; a package
carries it in its bundle.

## Building installers

See [../docs/PACKAGING.md](../docs/PACKAGING.md). In short:

```bash
python3 ../scripts/build_desktop.py
```

## Layout

| File | Purpose |
|---|---|
| `src/main.ts` | Window, menu, application lifecycle, the `studio://` scheme and the API requests |
| `src/engine.ts` | Starting the engine host, matching answers to requests, ports for windows |
| `src/engine-host.ts` | The utility process that holds the engine's Node addon and pumps frames and events |
| `src/preload.ts` | The bridge exposed to the page |
| `electron-builder.yml` | Installer configuration for all three platforms |
| `build/entitlements.mac.plist` | Entitlements the hardened runtime needs |
| `scripts/after-pack.cjs` | Removes Electron's unused language packs on macOS |
| `scripts/brand-exe.mjs` | Puts the icon and version strings into the Windows `.exe` when it is built on the Mac |
