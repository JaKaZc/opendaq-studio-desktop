# Roadmap

What is deliberately not built yet and what it would take. It is listed so
the gaps are a choice rather than a surprise.

## Not implemented

**Authentication and authorisation.** openDAQ Studio has no user model. It
needs none today, because the UI and the API are reachable only from the
app's own window and no network port is opened for them. Remote access to
the UI would need both.

openDAQ itself has a permission manager and devices carry a client type
(`Control`, `Exclusive Control` or `View Only`). Mapping openDAQ Studio users
onto those is the natural next step and would need a session store and a
login flow.

**Recording.** Recording is done by recorder function blocks, such as the CSV
and Parquet recorders, which are added, configured, connected, started and
stopped from the UI. Their files go wherever the block's Path property says,
on the computer that runs openDAQ Studio. openDAQ Studio does not read the
files back.

**Multi-instance.** One engine owns one openDAQ instance and the desktop
shell's single-instance lock allows one engine per user. A single engine
holding several instances would need its routes to name the instance.

**Signal maths.** Derived signals come from function blocks that a loaded
module provides (Statistics, Scaling, FFT and others), which a track's
inspector adds and connects in one step. Blocks that need two inputs, such as
Power, are added from the Devices mode, where each input port is connected on
its own.

**Persisted layouts.** Panel sizes, theme and the tracks shown are remembered
on this computer, but there is no named layout that can be shared with a colleague.

**Linux and Intel Macs.** The Linux packages are configured but have not been
built or tried. The macOS installer carries only the Apple silicon engine.

## Known limitations

**Structs are edited field by field.** openDAQ structs are immutable, so each
edit rebuilds the struct. Nested structs inside structs are shown but not
editable.

**Only scalar signals stream.** Only scalar numeric signals with a domain
signal are streamed as tracks. A signal with an array per sample, such as an
FFT spectrum, shows its newest array and an image signal shows its newest
picture. Other signals appear in the component tree with their last value.

**The Windows installer lacks the Visual C++ runtime.** A PC without the
Visual C++ Redistributable cannot start the engine until the installer
carries `MSVCP140.dll` and the two `VCRUNTIME140` DLLs.

## Upgrading the SDK

openDAQ Studio runs the SDK it was built with, 3.40.3. The SDK cannot be
changed at run time. Upgrading it means building and shipping a new
openDAQ Studio:

- `opendaq-universal-function-blocks/tool/build_desktop.sh` builds the SDK core
  the engine is compiled against, at `SDK_REF` (`v3.40.3`).
- `engine/tool/build_desktop.sh` and `build_windows.sh`
  download the openDAQ wheel whose libraries and modules the app ships, at
  `SDK_VERSION` (`3.40.3`).

Both have to name the same release. The engine's README explains why the
headers of one build and the libraries of the wheel match.

Then run the engine's API tests (`make test`). They assert against the
reference device's real property set, so an SDK change that alters it fails
the suite loudly rather than silently. `GET /api/system/diagnostics` then
reports the new release as `sdk.version`.

Nothing in the UI is version-aware. It renders whatever the engine describes,
so new device types, function blocks and properties appear without a code
change. In the engine these places know SDK specifics:

- `src/common.cpp`: openDAQ values to JSON and back. A new core type needs a
  wire name and both conversions.
- `kindOf` in `src/common.cpp`: a new component kind needs a name there and
  an icon in the UI.
- `src/routes/topology.cpp`: the add-device configuration sections are read
  dynamically, so new protocols appear on their own. New *section* names
  would not.
