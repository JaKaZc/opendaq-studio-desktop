<h1 align="center">openDAQ Studio</h1>

<p align="center">
  Every device, signal, function block and setting of an <a href="https://opendaq.com">openDAQ</a> instance, in a desktop application.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="openDAQ SDK" src="https://img.shields.io/badge/openDAQ-3.40.3-f15d31">
</p>

---

openDAQ Studio shows what the openDAQ SDK offers, plus a Scope for close
analysis. It is an Electron application that runs openDAQ itself in a native
C++ engine, in [engine/](engine). Every control maps to an SDK call, so the
application doubles as a tour of openDAQ itself.

Install it and open it. Click **Add** to pick a device it discovered or
enter a connection string such as `daqref://device0` for the SDK's simulated
reference device, or `daq.nd://<address>` for a phone that runs the openDAQ
Device Server.

## The openDAQ phone projects

This repository is one of four that work together, but each one stands on
its own: take only the parts you need, and build your own around them.
"Needs" says what a repository cannot do without.

| Repository | What it is | Needs |
|---|---|---|
| [opendaq-android-device-module](https://github.com/JaKaZc/opendaq-android-device-module) | openDAQ module, **Android only**: the phone's sensors and state as one device, `android://` | The openDAQ SDK and the Android NDK |
| [opendaq-universal-function-blocks](https://github.com/JaKaZc/opendaq-universal-function-blocks) | openDAQ module, UniversalFunctionBlocksModule: Universal renderer, Level, Spectrum, Vibration, Sound level meter and Dashboard, for any platform | The openDAQ SDK |
| [opendaq-device-server](https://github.com/JaKaZc/opendaq-device-server) | Android app that serves the phone as an openDAQ device on the network | The Android device module. The function blocks module is optional |
| **opendaq-studio-desktop** (this one) | openDAQ Studio, the desktop client for macOS and Windows, for any openDAQ device | Nothing else. The function blocks module is optional |

```
 Android phone: opendaq-device-server                 Computer: this app
 ┌──────────────────────────────────────────┐         ┌──────────────────────────────────────────┐
 │ openDAQ instance                         │         │ window (React UI)                        │
 │  android:// device  <- Android device    │         │  │ requests, live data                   │
 │                        module            │   TCP   │ engine (C++), utility process            │
 │  function blocks    <- universal         │   7420  │  openDAQ instance, native client         │
 │                        function blocks   │ ──────▶ │  SDK modules from the openDAQ wheel      │
 │  native streaming server, mDNS           │         │  UniversalFunctionBlocksModule           │
 │  NTP client                              │ ◀────── │  NTP time server, UDP 12300              │
 └──────────────────────────────────────────┘         └──────────────────────────────────────────┘
```

Studio ships UniversalFunctionBlocksModule when it is built beside it, so it
can add the same blocks to the devices it runs itself. It configures the
phone's blocks with or without the module, because the phone serves their
signals, ports and properties.

All four repositories are built against the same openDAQ SDK release,
**v3.40.3**. openDAQ's native protocol does not connect a client of one
release to a server of another.

## Use only what you need

openDAQ Studio needs none of the other repositories, neither to build nor to
run. It is a client for any openDAQ device: the SDK's simulated reference
devices, measurement hardware with openDAQ support, or a phone that runs the
Device Server. Clone this repository alone and follow Building below.

- **Without the function blocks module.** When
  [opendaq-universal-function-blocks](https://github.com/JaKaZc/opendaq-universal-function-blocks)
  is not beside this repository, the app is built without it and everything
  else works the same. The blocks of that module on a remote device, such as
  a phone, still work and are configured as any other, because the device
  serves their signals, ports and properties, and Studio draws the Universal
  renderer's plot data itself. Only adding new blocks of these types needs
  the module on the computer; **File, Load module…** loads it later.
- **With your own modules.** Studio needs no code for a device or function
  block type: it shows whatever the loaded modules provide. Your own
  device module or function blocks therefore appear in Add, in the function
  blocks the Signals page offers and on the Modules page, with all their
  properties. Load a module while the app runs with **File, Load module…**,
  or put it into `engine/dist/<platform>/modules/` before packaging, and the
  app ships it. Build it against openDAQ SDK 3.40.3, the release Studio
  ships.
- **With your own user interface or program.** The engine in `engine/` is a
  C library with a JSON interface, `engine/include/studio_engine.h`, whose
  routes [docs/API.md](docs/API.md) documents. Another user interface, a
  script or a test can drive the same openDAQ instance through it.
  `engine/tool/serve.mjs` serves it over HTTP and a WebSocket for that.
- **Without Studio.** A phone that runs the Device Server, and any other
  openDAQ device, also works with openDAQ's own clients, such as a Python or
  C++ program with the openDAQ SDK.

## What it shows

The header holds six modes, on keys `1` to `6`.

| Mode | What openDAQ offers there |
|---|---|
| **Signals** | Every signal as a live track on one time axis; a signal with an array per sample, such as an FFT spectrum, shows its latest array. A track's inspector shows its value and data descriptor (sample type, unit, value range, rule, domain, tick resolution, origin and rate) and the function block that produces it. It offers the function block types that work on that signal, as the SDK reports it: each type is tried with the signal connected and only those that report an OK status are listed, with the reasons for the rest. The output signals of an added block become tracks under it. Tracks are grouped by device and then by the channel or function block that owns them and each group folds, with Collapse all and Expand all above the tracks; the Tracks list is grouped the same way, with a box per channel that adds or removes all of its signals. Recorder function blocks, such as the CSV and Parquet recorders, are started and stopped from the bar above the tracks through openDAQ's recorder interface. |
| **Scope** | An oscilloscope over the same live signals, listed by device and channel in groups that fold: overlay or stacked traces, pan and zoom, dual cursors with Δt and 1/Δt, minimum, maximum, mean, RMS and standard deviation over the visible window, an edge trigger (auto, normal and single) with pre-trigger capture and a spectrum with a waterfall of its recent history. |
| **Devices** | The component tree: devices, channels, function blocks, signals, input ports, servers and sync components, each with its last value where it has one. The Track button of a channel or function block shows all of its signals as tracks. Every property kind gets its editor (selections, enumerations, suggested values, numeric limits, structs, lists, dictionaries, nested objects and `eval:` expressions) and function and procedure properties can be called. Attributes, status containers, operation modes, device locking and input port connections are all here. |
| **Flow** | The instance drawn as its dataflow: each device a box of its own, side by side, with its channels beside their signals, function blocks reading them through input ports, recorders and servers. Above it, how time flows: each device's time source, the device's role as master or slave of it, whether it is locked to it and its clock against this computer's. |
| **Fleet** | Every connected device at a glance, as a card: its connection, operation mode, status, active channels and time. For a phone with the Android device module it also shows its battery, temperature, processor, Wi-Fi and a link to its Dashboard with the PIN. Run all and Idle all set every device's operation mode at once. |
| **Modules** | Every loaded module with the device, function block, server and streaming types it provides and each type's default configuration. Further modules can be loaded at runtime. |

Across every mode:

- **Connecting.** Device discovery, manual connection strings and the full
  "add with configuration" flow (protocol, address family, streaming
  protocols).
- **Building.** Add and remove devices, function blocks and servers, wire
  signals into input ports and enable or disable server discovery.
- **Configuration files.** Save and load the instance configuration, with
  per-device remapping on load.
- **Log and events.** openDAQ's own log and the instance's events in one
  filterable list.
- **Time.** Every device's synchronization (its source, its role and its
  lock) and its clock against this computer's, in the navigator, a Time card
  on each device and the Flow page, with whether the devices are in sync.
  Studio is also the time master of its network. It answers NTP on UDP port
  12300 from this computer's clock and points the devices that follow NTP,
  such as phones with the Android device module, at itself when they connect.
  A phone whose ServeTime is on is the master instead. Studio then points the
  other phones at that phone's own time server, so they all follow it, for
  example a phone that follows GNSS. **Align devices**, on the Signals page,
  the Scope and the Flow page, moves each device's samples by its clock's
  measured offset to this computer's. Devices whose clocks differ then line
  up in the tracks and the Scope. The devices themselves are left as they
  are.
- **A command palette** (`⌘K` / `Ctrl+K`) over every component and action.
- **Light and dark themes** in the openDAQ palette.
- **A documented API.** Everything the UI does is a request to the engine's
  API, documented in [docs/API.md](docs/API.md). In the application the API
  is reached only from the window. The engine's development server serves the
  same API over HTTP for scripts and tests.

## Installing

Download the package for your platform from the
[Releases](https://github.com/JaKaZc/opendaq-studio-desktop/releases), run it and open the app. It
bundles the openDAQ engine, the openDAQ SDK with its device modules,
UniversalFunctionBlocksModule and the UI. On macOS there is nothing to
install first and nothing to configure. Windows needs the Visual C++ runtime;
see below.

| Platform | Package | Notes |
|---|---|---|
| macOS, Apple silicon | `openDAQ Studio-1.0.0-arm64.dmg` | Drag to Applications |
| macOS, Apple silicon | `openDAQ Studio-1.0.0-arm64.zip` | The app without an installer |
| Windows x64 | `openDAQ Studio-1.0.0-Setup.exe` | Per user, so no administrator rights |
| Windows x64, portable | `openDAQ Studio-1.0.0-Setup.zip` | Unzip and run; nothing is installed |

Linux packaging is configured but has not been built or tried.

### Windows needs the Visual C++ Redistributable

openDAQ Studio's engine and the openDAQ SDK are built with Microsoft's C++
compiler and use its runtime libraries (`MSVCP140.dll`, `VCRUNTIME140.dll`
and `VCRUNTIME140_1.dll`). The installer and the portable ZIP do not carry
them. Install the **Microsoft Visual C++ Redistributable for Visual Studio
2015 to 2022, x64** once, before the first start:

- Download it from Microsoft:
  [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe), or see
  [the latest supported Visual C++ Redistributable downloads](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist).
- Or install it from a terminal: `winget install Microsoft.VCRedist.2015+.x64`.

Many PCs have it already, because other programs install it too. Without it,
the engine cannot load: Studio shows "openDAQ Studio could not start" with
"The openDAQ engine did not start" and quits. Install the Redistributable and
start Studio again.

### What to expect on the first start

The releases are not signed with certificates that macOS and Windows trust
by default, because those cost a yearly fee. Your system therefore asks you
once to confirm that you want to open the app. The checksums under How
releases are made let you check that a download is the one published here.

**macOS.** The app is signed with the project's own self-signed certificate
and is not notarized by Apple, because notarizing needs a paid Apple
Developer ID. The first time you open it, macOS says it cannot verify that
the app is free of malware and does not open it:

1. Drag openDAQ Studio from the DMG to Applications and open it once.
2. Open **System Settings, Privacy & Security**, scroll to Security and click
   **Open Anyway** next to the message about openDAQ Studio, then confirm.

Or remove the download's quarantine flag in a terminal, which has the same
effect:

```bash
xattr -dr com.apple.quarantine "/Applications/openDAQ Studio.app"
```

macOS remembers the choice, so later starts open directly. When Studio first
looks for devices, macOS also asks whether it may find devices on the local
network. Allow it, or Studio finds and reaches no device on the network. The
setting is in System Settings, Privacy & Security, Local Network.

**Windows.** The installer and the app have no code signature, because that
needs a paid code signing certificate. Microsoft Defender SmartScreen
therefore shows "Windows protected your PC" when you run the installer:

1. Click **More info**.
2. Click **Run anyway**.

The installer installs for your user only and needs no administrator rights.
When Studio starts, Windows Defender Firewall may ask whether it may use the
network. Allow it on private networks, or Studio cannot discover devices or
answer their time requests.

### How releases are made

Every release is built on a Mac from this repository's sources, with the
commands in Building below:

| Package | Built with | Signed |
|---|---|---|
| macOS DMG and ZIP | `python3 scripts/build_desktop.py --release` | With the self-signed certificate "openDAQ Studio Local", not notarized |
| Windows installer and ZIP | `python3 scripts/build_desktop.py --windows --release`, cross-built with clang-cl | Not signed |

Both bundle openDAQ SDK 3.40.3, from the official openDAQ wheels, and the
function blocks module built from
[opendaq-universal-function-blocks](https://github.com/JaKaZc/opendaq-universal-function-blocks)
at the same time. Each release lists the SHA-256 checksum of every file in
`SHA256SUMS.txt`. Check a download against it before you open it:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

```powershell
Get-FileHash ".\openDAQ Studio-1.0.0-Setup.exe" -Algorithm SHA256
```

The Windows packages are cross-built on a Mac and have not been tried on a
Windows PC yet, so treat them as a preview and report what you find in the
repository's issues.

## Requirements

To build and run from source:

| What | Version | Notes |
|---|---|---|
| A Mac with Apple silicon | macOS 11 or newer | Both installers are built there |
| Xcode command line tools | | `xcode-select --install`; the C++ compiler for the engine |
| Node.js | 20 or newer | For the UI and the Electron shell |
| Python 3 | 3.9 or newer | For the build script, the wheel download and the engine's API tests |
| CMake | 3.24 or newer | `brew install cmake` |
| Ninja | | `brew install ninja` |
| git | | To clone the openDAQ SDK |
| Network access | | On the first build, for the SDK, its dependencies, the openDAQ wheel and npm |
| opendaq-universal-function-blocks | optional | Cloned beside this repository, or named by `UNIVERSAL_FUNCTION_BLOCKS`, to ship its function blocks with the app |
| ccache | optional | Used when installed; repeated builds are much faster |

For the Windows installer, also `brew install llvm lld xwin makensis`, and the
Windows SDK from xwin, which asks you to accept Microsoft's license; see
[docs/PACKAGING.md](docs/PACKAGING.md).

No hardware is needed. The SDK ships reference devices that generate real
signals.

## Building

```bash
git clone https://github.com/JaKaZc/opendaq-studio-desktop.git
cd opendaq-studio-desktop
```

To ship the function blocks with the app, clone their repository beside this
one first. This is optional:

```bash
git clone https://github.com/JaKaZc/opendaq-universal-function-blocks.git ../opendaq-universal-function-blocks
```

```bash
make setup      # npm packages of the UI, the shell and the engine; a venv for the API tests
make engine     # the openDAQ engine, the SDK and its modules -> engine/dist/darwin-arm64/
make desktop    # builds the UI and starts the app from source
```

`make engine` runs `engine/tool/build_desktop.sh`, which:

1. clones the openDAQ SDK at `v3.40.3` into `engine/build/openDAQ` and builds
   its core, which the engine is compiled against (`engine/tool/build_sdk_core.sh`,
   a few minutes the first time),
2. downloads the openDAQ wheel of the same release and takes the SDK's
   libraries and modules from it,
3. compiles the engine, its Node addon and `studio_cli` against the SDK core,
4. builds UniversalFunctionBlocksModule when its repository is there, and
   skips it when it is not,
5. puts everything into `engine/dist/darwin-arm64/`, with the modules in its
   `modules/` folder.

The installers:

```bash
python3 scripts/build_desktop.py             # the macOS DMG -> desktop/release/
python3 scripts/build_desktop.py --windows   # the Windows installer, cross-built on the Mac
```

Add `--release` for the ZIP packages as well; a local build writes only the
installer. `CSC_NAME` names the certificate the macOS app is signed with.
[docs/PACKAGING.md](docs/PACKAGING.md) describes the build and signing, and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) running the UI in a browser and the
tests (`make test`).

## Data folder

openDAQ Studio keeps its logs in a data folder of its own:

```
~/Library/Application Support/openDAQ Studio/     (macOS)
%LOCALAPPDATA%\openDAQ Studio\                    (Windows)
```

`logs/` there holds openDAQ's log file and `logging.json`, the log levels
chosen in the Log tab. The environment variable `OPENDAQ_STUDIO_DATA_DIR`
names another folder; the older name `OPENDAQ_VIEWER_DATA_DIR` works too. It
is the only setting the app reads from the environment.

## How it fits together

```
  window (studio://app/)  ──/api/... requests──▶  main process
         ▲                                            │
         │                                            ▼
         └──message port: events + sample frames──  engine host (utility process)
                                                      studio_engine.node
                                                      openDAQ SDK  ──▶  devices
```

The main process serves the UI from the `studio://app/` scheme and passes
its API requests to the engine. The engine runs in an Electron utility
process, so a crash in the SDK or a module does not take the windows with
it. Each request runs on a worker thread of that process, so a slow call
such as discovery or connecting a device does not stop live data. No network
port is opened for the UI or the API.

Sample delivery is incremental. The engine keeps a ring buffer per signal and
each window a cursor into it and every frame carries only what that window
has not seen. Cost therefore scales with the *sample rate* and not with the
zoom level. When a window asks for fewer points per second than the signal
produces, samples are reduced to min/max pairs per bucket. Frames stay
bounded, nothing aliases and spikes are preserved.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) goes into the details and the
reasoning behind them.

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes and threads, streaming, events, state management |
| [API.md](docs/API.md) | The routes, the live data messages and payload shapes |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running from source, tests, project layout |
| [PACKAGING.md](docs/PACKAGING.md) | Building the macOS and Windows installers |
| [BRANDING.md](docs/BRANDING.md) | Colour tokens and swapping in the official logo |
| [ROADMAP.md](docs/ROADMAP.md) | What is deliberately not built yet |
| [desktop/README.md](desktop/README.md) | The Electron shell |

## Compatibility

- **openDAQ SDK** 3.40.3. The SDK is the one the application was built with
  and ships. `GET /api/system/diagnostics` reports it under `sdk.version`.
- **macOS** on Apple silicon. The engine and the SDK's modules are native
  libraries of one architecture and the installer carries the `arm64` build.
- **Windows** x64, with the Microsoft Visual C++ Redistributable (x64) installed; see [Windows needs the Visual C++ Redistributable](#windows-needs-the-visual-c-redistributable).

The UI refuses to interpret sample frames of a different frame version and
reports the mismatch rather than drawing wrong data.

## License

Apache-2.0, matching the openDAQ SDK. See [LICENSE](LICENSE).

This is an independent project built on the openDAQ SDK. openDAQ is a
trademark of its respective owners; see [docs/BRANDING.md](docs/BRANDING.md)
for how the palette and logo are handled.
