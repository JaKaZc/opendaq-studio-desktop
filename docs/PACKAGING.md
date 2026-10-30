# Packaging

openDAQ Studio is distributed as a desktop installer. The macOS and Windows
installers are both built on a Mac. Linux packaging is configured but has not
been built or tried.

## Desktop installers

The apps run the native openDAQ engine, in `engine/`.

```bash
python3 scripts/build_desktop.py   # -> desktop/release/
```

`CSC_NAME` names the certificate the app is signed with; see macOS signing and notarisation below.

On macOS that runs three steps in order:

```bash
npm --prefix frontend run build                    # UI -> frontend/dist/
engine/tool/build_desktop.sh                       # engine -> engine/dist/darwin-arm64/
npm --prefix desktop run build && npm --prefix desktop exec -- electron-builder --mac dmg   # DMG -> desktop/release/
```

A local build writes the DMG only. `--release` also writes the ZIP of the
app, as a release ships it (`npm --prefix desktop run dist`); the ZIP takes
about two minutes more. On Windows `--release` adds the ZIP beside the NSIS
setup in the same way.

Run them individually when iterating on one part. `--skip-frontend` and
`--skip-engine` reuse the existing UI and engine, `--skip-npm-install`
assumes `desktop/node_modules` is current and `--dir` produces an unpacked
application that is faster to test. `make package` runs the script without
options. The script uses the standard library only.

`electron-builder` copies the engine into the app bundle under
`resources/engine/` and the UI under `resources/ui/`. The shell runs the
engine in an Electron utility process and serves the UI from
`studio://app/`. It answers the UI's `/api/...` requests through the engine
and gives each window a message port for live data and events, so no network
port is opened for the UI. The engine's README describes its build.

The npm targets in `desktop/` are `dist:mac`, `dist:win` and `dist:linux`.
`pack` builds an unpacked directory.

### macOS builds for Apple silicon

The engine and the SDK's modules are native libraries of one architecture.
`desktop/electron-builder.yml` packages
`engine/dist/darwin-arm64` and the macOS target carries no
`arch:` list, so electron-builder builds for the host. An Intel build would
need an engine built for `x86_64` and that folder named in the configuration.

### The Windows installer is built on the Mac

```bash
python3 scripts/build_desktop.py --windows
```

The Windows engine is cross-built by `engine/tool/build_windows.sh`:

* Nothing of openDAQ's is compiled. The SDK's core DLLs and its modules come
  from the openDAQ **`win_amd64` wheel** of the same release. Import
  libraries are made from their export tables, because every function they
  export is a plain C function.
* The engine, its Node addon and UniversalFunctionBlocksModule are compiled
  with **`clang-cl`** and linked with **`lld-link`** (Homebrew's `llvm` and
  `lld`) against the Windows SDK and the MSVC C runtime. **`xwin`** downloads
  them once, after accepting Microsoft's license.
* Every binary's PE header is checked before packaging. That catches the
  classic cross-build mistake of shipping the host's libraries.

The result lands in `engine/dist/windows-x86_64/` and is
packaged as `resources/engine/`, as on macOS. The Mac cannot run it: Wine is
no longer installable from Homebrew, so a Windows PC or a Windows 11 on Arm VM
is needed to try the installer.

The engine and the SDK's DLLs need the Visual C++ runtime (`MSVCP140.dll`,
`VCRUNTIME140.dll` and `VCRUNTIME140_1.dll`), which the installer does not
carry yet. A PC without the Visual C++ Redistributable cannot start the
engine.

Two host-specific details are both handled by `build_desktop.py`:

* **`rcedit`** puts the icon and version strings into the app `.exe` and
  electron-builder runs it under a bundled x86-64 Wine. On Apple silicon
  without Rosetta that cannot run at all, so off Windows the step is skipped
  and `desktop/scripts/brand-exe.mjs` edits the PE resources directly
  instead.
* **`makensis`** is also x86-64 in electron-builder's toolchain. When it
  cannot run, the build substitutes a native one (`brew install makensis`).

  What comes from where matters here and getting it wrong is quiet. NSIS
  builds an installer by appending the compiled script to a prebuilt
  **stub** executable from `Stubs/`. A stub from a different NSIS release is
  not guaranteed to understand the header a newer compiler writes. The first
  attempt at this mixed electron-builder's 3.0.4.1 stubs with a 3.12
  compiler. The result passed every structural check (valid PE, correct NSIS
  header lengths, payload intact) and did nothing at all when run, with no
  error and no window. So the stubs now come from the system NSIS, matched to
  its own compiler. Only the version-independent parts (language files,
  macros, plugin DLLs, `elevate.exe`) are overlaid from electron-builder.

  The tell, if it ever happens again, is the size of the installer's exehead,
  which is the stub plus its resources. It moved by exactly the 512-byte
  difference between the two stubs.

### Linux

`desktop/electron-builder.yml` has a Linux target (AppImage and deb) that
packages `engine/dist/linux-x86_64`. The engine's
`tool/build_desktop.sh` would build that folder on a Linux machine. Neither
has been built or tried.

### The SDK's modules

openDAQ discovers device, protocol and function block modules by scanning a
directory at run time. The engine's build copies the SDK's modules from the
openDAQ wheel into `engine/dist/<platform>/modules/`. When the sibling
repository opendaq-universal-function-blocks is there, it builds and adds
UniversalFunctionBlocksModule: the Universal renderer, which sends its plot as
plot data that the UI draws, and the Level, Spectrum, Vibration, Sound level
meter and Dashboard blocks. With the module, Studio can add these blocks to
any device. Blocks that already run on a device, such as a phone, are
configured through that device with or without it.
Without the repository, the app is built without the module. Any other module
built against the same SDK release can be put into that folder too, and the
app ships it. The shell starts the engine with that folder as its module
directory.

If a packaged build starts but shows no device types, the modules are what
went wrong. Check the Modules page, which lists what the SDK actually loaded.

### macOS signing and notarisation

The bundle needs the entitlements in `desktop/build/entitlements.mac.plist`:
JIT for Electron and library validation off, because the SDK's modules are
loaded at run time and a self-signed certificate gives them no team
identifier.

An unsigned build runs on the machine that produced it. On anyone else's Mac
Gatekeeper refuses it ("openDAQ Studio is damaged and can't be opened"),
because the download carries a quarantine flag and there is no signature to
check. The first user can right-click and choose **Open** to get past it. For
real distribution, sign and notarise:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...  APPLE_APP_SPECIFIC_PASSWORD=...  APPLE_TEAM_ID=...
npm --prefix desktop run dist:mac
```

`NSLocalNetworkUsageDescription` and the Bonjour service types the openDAQ
SDK's discovery uses are declared in `desktop/electron-builder.yml`
(`_opendaq-streaming-native._tcp`, `_opcua-tcp._tcp`, `_streaming-lt._tcp`,
`_streaming-ws._tcp` and `_opendaq-ip-modification._udp`), so mDNS discovery
prompts correctly on recent macOS. A module that announces another type
needs it added there.

macOS ties the Local Network permission to the app's code signature. An
ad-hoc signed build gets a new signature with every build, so installing a
new one can reset the permission. macOS then asks again or, if the request is
dismissed, silently blocks discovery and every connection to a device on the
local network. The setting is in System Settings, Privacy & Security, Local
Network. A Developer ID signature keeps the permission across updates.

Without an Apple developer account, a self-signed code-signing certificate
gives the same stability on the machine that trusts it. Create one in
Keychain Access (Certificate Assistant, Create a Certificate, Self Signed
Root, type Code Signing), set it to Always Trust for code signing and build
with its name:

```bash
CSC_NAME="openDAQ Studio Local" python3 scripts/build_desktop.py --skip-npm-install
```

The designated requirement then names the bundle identifier and the
certificate rather than a hash of the files, so macOS keeps the Local Network
permission across builds signed with the same certificate. Other Macs still
see an app from an unidentified developer.

### Windows

The NSIS installer is per user by default, so it needs no administrator
rights. It offers a destination, creates Start Menu and desktop shortcuts and
registers an uninstaller. The user's logs in `%LOCALAPPDATA%\openDAQ Studio`
survive an uninstall. Sign the installer by setting `CSC_LINK` and
`CSC_KEY_PASSWORD` as above. An unsigned installer raises a SmartScreen
warning the user has to click through.

### Keeping the installers small

Most of an installer is the Electron runtime and the openDAQ SDK with its
modules, which stay. What is trimmed:

* Electron's language packs, except English (`electronLanguages`). On macOS
  they live inside the Electron framework, which the option does not reach,
  so `desktop/scripts/after-pack.cjs` removes them there.
* Local symbols in every macOS library of the engine and the SDK (`strip -x`
  in `engine/tool/build_desktop.sh`), a third of the
  openDAQ SDK's size. Exported symbols stay, so modules still load by name.
  Each file is signed ad hoc again and the app's build signs them properly.
* `studio_cli`, the engine's command line client for tests.
* The UI's source maps, which stay in `frontend/dist` for debugging.
* Installers use maximum compression.

### Icons and installer artwork

Everything the installers display is generated from `assets/brand/*.svg`,
the outlines taken out of the Design Manual, by one script:

```bash
python3 scripts/build_icons.py
```

| Output | Used by |
|---|---|
| `desktop/build/icon.{icns,ico,png}` | The application icon on all three platforms |
| `desktop/build/background.png`, `background@2x.png` | The DMG window: brand gradient, logo, drag arrow |
| `desktop/build/installerSidebar.bmp`, `uninstallerSidebar.bmp` | NSIS welcome and finish pages |
| `desktop/build/installerHeader.bmp` | NSIS inner pages |
| `frontend/public/favicon.svg`, `opendaq-icon.png` | The page icon |

The outputs are committed, so a normal build does not need Pillow. Only
regenerating them does (`pip install Pillow`). The icon is the manual's
gradient with the logo's star badge in white. See [BRANDING.md](BRANDING.md)
for why the full wordmark is not used at icon sizes.

### Continuous integration

`.github/workflows/ci.yml` type checks, lints, tests and builds the UI and
type checks the desktop shell. The engine builds the openDAQ SDK core and
needs the Xcode tools, so the engine, its API tests and the installers are
built and run on the Mac (`make engine`, `make test`, `make package`).

## Versioning

`kAppVersion` and `kApiVersion` in `engine/src/engine.h`
hold the application version and the API version, the contract between the
engine and the UI. `desktop/src/engine-host.ts` sends the same two in its
`hello`. Bump the minor part of the API version for additive changes and the
major part for breaking ones. The binary frame format has its own version,
checked on every frame.

`frontend/package.json` and `desktop/package.json` carry the same
application version. Keep all of them in step when releasing.
