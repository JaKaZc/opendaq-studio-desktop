# Architecture

This document explains the decisions that shaped openDAQ Studio and why the
alternatives were rejected. It is aimed at whoever has to extend or debug it.

## The shape of the problem

openDAQ Studio is a web UI in an Electron window over one openDAQ instance.
The openDAQ SDK is a C++ library and three of its properties drive most of
the decisions here:

1. **Some calls block for a long time.** Discovery, adding a device and
   saving a configuration take from hundreds of milliseconds to seconds.
2. **Data arrives continuously.** A modest instance produces tens of
   thousands of samples per second and a device can produce far more.
3. **A fault in the SDK or a module ends its process.** Native code that
   crashes takes everything in its process with it.

## Processes

openDAQ runs in the native engine, `engine/`: one openDAQ
instance behind the Studio API, written in C++. The phone app runs the same
engine through Dart FFI, so both apps share one implementation of every
route. The desktop app has three kinds of process:

| Process | Runs | Source |
|---|---|---|
| Main | Windows, the menu, the `studio://` scheme, the API requests | `desktop/src/main.ts`, `engine.ts` |
| Engine host | The engine's Node addon `studio_engine.node` and with it the SDK | `desktop/src/engine-host.ts` |
| Renderer | The UI, one per window, sandboxed | `frontend/` |

The engine host is an Electron utility process. A crash in the SDK or a
module ends that process and not the windows. When it exits, the main
process answers every pending and later request with 503 and the code
`offline` and logs the exit code. The main process starts the host with the
engine's folder (`resources/engine/` in a package,
`engine/dist/<platform>/` from source), the SDK's module
folder below it, a frame interval of 50 ms and at most 4000 points per signal
in one frame.

### The studio:// scheme

The UI is served from `studio://app/`, a scheme registered as standard and
secure with fetch support, so the UI runs unchanged. A path under `/api/` is
an API request. Every other path is a file of the built UI and an unknown
path gets `index.html` for the single-page app's own routes.

For an API request the main process turns the query into JSON (a repeated
parameter becomes a list), passes the method, the path, the query and the
body to the engine host and returns the engine's JSON with its status. Two
routes get more than that. `/api/configuration/download` gets a
`Content-Disposition` with a time-stamped file name. `/api/signals/picture`
returns the picture's bytes, with the media type taken from its first bytes
(openDAQ plot data, PNG, JPEG or BMP) and its number in `X-Picture-Sequence`.

No network port is opened for the UI or the API. The engine opens the ports
of openDAQ itself: mDNS discovery, the servers the user adds and the NTP time
server on UDP 12300.

## Threading in the engine

Nothing in the engine pumps a main loop. The instance is built with the
SDK's default scheduler, which runs on the SDK's own worker threads and
delivers core events from them.

**Requests.** The addon runs each request and each subscription on a libuv
worker thread and answers a promise, so the engine host's event loop never
waits on the SDK. Several requests can run at once. A slow call such as
discovery or connecting a device occupies one worker while live data keeps
flowing. The C interface (`src/c_api.cpp`) holds the engine under a shared
lock for requests, polls and events and under an exclusive lock only to
start and stop it.

**Live data.** The engine host polls each window's client every frame
interval. A poll drains every reader into its ring and builds that client's
next frame, all under the engine's stream lock. Polls, events and pictures
only copy what the engine already holds, so they answer at once on the host's
own thread.

**Events.** Core events arrive on the SDK's threads.
`Engine::onCoreEvent` translates each one and queues it under the event lock.
The engine host takes the queue every 100 ms and posts it to every window.

**Background threads.** The time keeper wakes every five seconds. It points
new devices that follow NTP at Studio's time server and measures the
devices' clocks while devices are aligned. The NTP time server answers on a
thread of its own.

The Python backend this engine replaces ran every SDK call on one thread
that pumped the scheduler. The engine does not serialise SDK calls. Its own
state (streams, clients, events and call counters) is guarded by its own
locks.

### Failure isolation

A route refuses with an `HttpError` and its status. An openDAQ exception
becomes a structured refusal: 404 when the SDK says something was not found,
409 when something is locked or read-only, 400 for an invalid argument and
502 `sdk_error` otherwise. Any other exception becomes 500 `internal_error`.
Every 5xx answer is counted and logged. `GET /api/system/diagnostics` reports
the counters as `loop.errors` and `loop.lastError`. An engine that is quietly
failing is much worse than one that says so.

## Streaming

### Incremental, not snapshot

The obvious design resends the whole visible window every frame. At a
60-second window and 20 kHz that is 1.2 M samples per frame per client, which
is unusable.

Instead the engine keeps a ring buffer per signal (300 000 samples) and each
client holds a cursor into it. Every frame carries only samples that client
has not seen. Cost scales with the *sample rate* and not with the zoom level
or the number of clients viewing different windows.

A signal has one openDAQ stream reader however many clients subscribe to it.
The reader is created by the first subscription and released with the last
one. A client is a desktop window or the phone app, which is client 0. A new
subscription is primed with a slice of history (`primeSeconds`), so a freshly
opened Scope is not blank while the buffer fills. A paused client gets no
frames.

### Min/max decimation

A 20 kHz signal drawn into 1200 pixels does not need 20 000 points per second
on the wire. Plain subsampling hides spikes, though. In a measurement tool that is not a
cosmetic problem.

When a client asks for fewer points per second than the signal produces,
samples are grouped into buckets and each bucket is reduced to its minimum
and maximum. The client draws one vertical span per bucket: the classic
oscilloscope look with a bounded frame size and no aliasing. The client
requests roughly two points per pixel and recomputes that whenever the window
or the canvas changes.

The bucket size has a second floor besides the client's resolution. A frame
carries at most `maxPoints` buckets per signal, so it must also carry a frame
interval of input with room to catch up (`chooseDecimation` in
`src/streaming.cpp`). Without that floor a signal fast enough to exceed the
budget was sent raw and fell further behind with every frame. It then dropped
out of the ring and reset over and over and its trace was empty when zoomed
in. The rate it is judged by is the spacing of the samples themselves and not
the descriptor read when the stream opened, because a device's sample rate
can change while it streams.

Each view takes its live edge from its own signals. The Scope takes it from
its visible traces (`liveEdge`), so a 1 kHz signal streaming for the Signals
page does not push a 1 MHz trace out of a millisecond window.

### Frame format

```
  0 ..  3   magic "ODQV"
  4 ..  5   uint16 version
  6 ..  9   uint32 header length
 10 ..  N   UTF-8 JSON header
  N ..      concatenated Float32 payloads, addressed per block
```

Samples stay out of JSON. A 20 kHz Float32 trace is about 80 kB/s and roughly
400 kB/s as JSON numbers. The version is checked on the client, which refuses
to interpret a frame it does not understand rather than drawing wrong data.

### Gaps are explicit

Domain ticks are checked for continuity. A jump, a descriptor change or a
client that fell behind the ring buffer sets `reset` on the next block and
the client clears its buffer instead of splicing unrelated data together.
Each stream also carries an epoch that increments on any discontinuity, so a
client can detect one even if it missed the frame that reported it.

A descriptor change also stops an openDAQ `StreamReader` in place. Switching
a channel off and on again, for example, leaves an event packet at the head
of the reader. The reader then reports no samples available but is not
empty and it delivers nothing more until that packet is read. When a poll
finds no samples, the stream reads the event with a zero-length read
(`consumeEvent`), counts it as a discontinuity and recreates the reader if
the event left it invalid.

## One channel for events and samples

Events and samples share one channel per window. In the app it is the
window's message port; against the engine's development server it is the
WebSocket at `/api/ws`. Both carry the same messages: JSON text for control
messages and events, binary ODQV frames for samples. One channel gives the UI
a single reconnect strategy and keeps events ordered relative to the sample
frames around them. That matters when a descriptor change and a buffer reset
land in the same instant. `PortSocket` in `frontend/src/lib/realtime.ts`
makes the port look like a WebSocket, so the rest of the UI does not know
which one it has.

The shell gives a window a new port each time its page loads. The engine
host then opens a client for it and sends `hello` and the last 40
notifications. The UI replays its desired subscription set on every open, so
a reloaded window recovers on its own.

### Events

The engine sends each event as `{type, seq, at, payload}`. Structural core
events (a component added or removed, a signal connected, a lock or
operation mode changed) are coalesced into one `tree.changed` per take of the
queue and the UI then reads the tree again. Property, attribute, status and
connection changes go out one by one. The last 200 notifications are kept
for `GET /api/system/events`, which is how a window that opens later sees
them. The queue holds about 500 events and a host that stops taking them
loses the oldest. The next `tree.changed` makes its clients read the state
again.

## Frontend state

The main stores, split by lifetime:

| Store | Holds | Persisted |
|---|---|---|
| `useSettings` | Theme, view options, panel sizes | localStorage |
| `useSession` | Connection, component tree, selection, log | No |
| `useTracks` | Which signals are tracks, the window, the selection | Partly |
| `useScope` | The Scope's traces and view options and the live subscription | Partly |

**Sample data is deliberately not in React state.** Frames arrive around 20
times a second. Putting them through a store would re-render the application
at that rate for data only the canvas reads. `store/traceStore.ts` holds the
ring buffers as plain objects and the canvas pulls from them inside
`requestAnimationFrame`. React is notified only when something structural
changes: a new signal, new descriptor metadata or a buffer reset.

### Deriving rather than syncing

State that can be computed is computed. The component tree's expansion, for
example, is derived from the view's defaults, the path to the current
selection and a map of explicit user toggles. Storing the *effective*
expansion instead would mean syncing it whenever the tree, the view or the
selection changed and every one of those syncs is a frame where the tree is
briefly wrong.

The same rule applies to the connection-plan preview, the type picker's
default selection and the command palette's highlight. The
`react-hooks/set-state-in-effect` lint rule is enabled to keep it that way.

### Modes

`lib/workspaces.ts` is the one list of modes (Signals, Scope, Devices, Flow,
Fleet and Modules) with their labels, icons and one-line purposes. The
header's mode switch, the command palette and the number keys are all
derived from it and a mode's key is its position (`1` to `6`).
`store/useNav.ts` holds the mode in view, so any component can call
`go('devices')` without a callback threaded through the pages.

### Only what the SDK offers, with one exception

openDAQ Studio presents the openDAQ SDK. When a feature is wanted, it is
mapped to an SDK concept first. Processing is a function block type from a
loaded module. Recording is a recorder function block started through the
SDK's recorder interface. A component's health is its status container.
Values shown outside the tracks and the Scope are the signal's last value as
openDAQ reports it.

The exception is deliberate: the **Scope** analyses streamed samples in the
UI with its own trigger, cursors, window statistics and spectrum. It is kept
in its own mode, so the rest of the application stays a view of the SDK.

A Scope that stops moving looks the same whatever the reason, so a status
strip under its toolbar (`ScopeStatus`) names the reason and offers the
action that undoes it. A paused, frozen or holding view gets "Jump to live",
which is also the toolbar's Live button and the `L` key. A plotted signal
with no frame for three seconds gets "Restart the stream", which clears its
buffer and subscribes again. When a component above the signal is inactive
in the tree, the strip names it and offers to switch it on instead. The gear
in each legend row opens `ScopeSettings`, a drawer with the property cards of
the trace's channel, device and signal, so a sample rate can be changed while
the trace stays in view.

## The Signals mode

The app opens on Signals. Every chartable signal is a track on one shared
time axis, with the recorder function blocks in a bar above and an inspector
on the right.

**One loop, no React per sample.** `components/signals/trackLoop.ts` runs a
single `requestAnimationFrame` loop. Each track, the ruler and the
inspector's live reading register a painter. On a frame in which samples
arrived (`traces.dataVersion`) or the window moved, the loop computes the
window once and calls every painter with it. A track's samples, its live
value and the cursor readout never pass through React. React renders a row
only when its name or selection changes.

**Envelopes.** `drawTrack` draws the minimum and maximum of each pixel column
(`TraceBuffer.toColumns`) as a band and the newest value of each column as a
line, so a 20 kHz signal shows every spike at any window. A sparse signal,
such as a Statistics block that gives one result per block of samples, is
joined across empty columns and marked with a dot per result. The vertical
range (`nextRange` in `lib/tracks.ts`) grows at once and shrinks slowly, so a
peak is never clipped and a quiet stretch does not make the trace jump.

**Streaming.** One subscription serves the tracks and the Scope.
`useScope.setPinned` adds the tracks to the Scope's traces, so a signal shown
in both costs one reader on the device. The engine leaves out a signal it
cannot stream yet instead of refusing the whole request, because a function
block output may have no domain descriptor until its first sample. The
Signals page asks again for any track that has no stream when it next
refreshes its signal list.

**Processing with a function block.** An input port's `acceptsSignal` answers
yes for every reference block and every signal, so it cannot say which blocks
work. The engine asks the blocks instead (`src/routes/fit.cpp`). For each
function block type it adds the block, connects the signal to the first
input port, reads the status the block sets during the connect (`Invalid
sample type`, `Port Current is not connected!`) and removes the block again.
Only types that report OK are offered and the rest are listed with their
reason. The verdicts are cached per type and kind of signal (the parts of the
descriptors a block can react to). The probe blocks' core events are filtered
out by the engine (`beginProbe` and `ignoreComponents`), so the UI never sees
them. The Renderer and the Video Player are never probed, because they open
a native window as soon as they exist.

Adding a block creates it with its default configuration and connects its
first input port to the signal. Its output signals are added as tracks right
after the signal. `inputSources` in `components/signals/signalData.ts` reads
from the component tree which signal a block's input port is connected to,
so a block's outputs are grouped under the device of the signal they read.

**Array tracks.** A signal with a one-dimensional value per sample, such as
the FFT block's spectrum, is not streamed. Its track draws the newest array
from the signal's last value, polled a few times a second, with the element
index as the horizontal axis and the largest element marked. The SDK's FFT
descriptor does not say which frequency an element is, so the track does not
claim one.

**Recorders.** Every function block the tree marks as a recorder appears in
the bar above the tracks with Record and Stop, which start and stop it
through the SDK's recorder interface. "Connect the tracks" connects each
track not yet recorded to the recorder's next free input port. Recorders such
as the CSV recorder add a new free port whenever one is connected.

### The device inspector

The detail side of the **Devices** mode is a column of cards over the
component: `BlockHeader` (breadcrumb, name, active, operation mode and lock
controls), `SignalsPanel` ("Live outputs", each with its last value),
`PropertyInspector` and the input ports. The inspector has two presentations
of the same property tree, switched by `useSettings.propertyView`: *cards*
(the default) and the classic *table* (`PropertyGrid`). Both share
`PropertyEditor` and the row menu (`usePropertyMenuItems`), so an editor
added for one exists in both.

The decisions the cards make live in `lib/properties.ts`, each with tests.
`isChangedFromDefault` compares selections by key, since their `value` is
the label. It never calls a read-only value changed, because the device set
it and nobody can reset it. `segmentable` shows buttons only while every
option fits on a line. `sliderScale` needs both limits, is logarithmic once
the range spans two decades and snaps integers. `filterProperties` combines
search with "changed only" and keeps an object while any descendant
survives. `humanizeName` turns property names into labels. A slider writes
on release and never during a drag, so sweeping a sample rate does not
reconfigure the device on every pixel. Row layout uses container queries and
not viewport breakpoints, because the pane's width decides whether the label
and control share a line.

### The navigator

The engine serialises the whole component tree in one call and the
navigator is a projection of it computed in the UI (`lib/navigator.ts`, with
tests). Switching what it shows therefore costs nothing.

openDAQ stores a device as folders (`Dev`, `IO`, `FB`, `Sig`, `IP`, `Srv`)
and the navigator used to show them. That meant `Devices › Inputs/Outputs ›
AI` before the first channel. It is device-centric now. A device's channels,
blocks and sub-devices sit directly under it, storage folders disappear and
a folder a device names itself ("AI", "CAN") becomes a caption above its
rows. Channels and blocks show their last value, polled in one batched
`last-values` request for the rows on screen. Hovering one shows it as a
track.

Filter chips (All, Devices, Channels, Signals, Blocks) replace the old five
tabs. The flat filters give every row a second line saying where it lives
("RefCh1 · RefDev1"), because a list of identical channel names is useless
without the tree around it. The SDK's complete tree, folders and all, is one
menu item away. It used to be a tab called "Topology", which collided with
the diagram of the same name (now the Flow mode).

Rows are flattened from the projection, so keyboard navigation (arrows, Home,
End, Enter), search and rendering share one list. Expansion is derived:
devices are open, everything above the selection is open and only the rows
someone toggled are stored. A selection made anywhere else in the app is
therefore always revealed.

## API conventions

Component ids are openDAQ *global ids* such as `/openDAQDevice/Dev/RefDev0`.
They begin with a slash, contain slashes and may contain spaces, so they
always travel as the `id` **query parameter** and never as a path segment.

Errors are structured as `{code, message, detail}`, so the UI can show
`message` directly and branch on `code`. A route refuses with
`fail(status, code, message)` and openDAQ's exceptions are mapped to the
same shape (see Failure isolation).

Configuration flows are **stateless**. Rather than holding a half-edited
config object between requests, the engine returns the SDK's default
configuration tree and accepts a flat `{"General.Username": "..."}` override
map, which it applies to a *fresh* default object. A stale window cannot
submit against something that no longer exists and the SDK stays the
authority on which options are legal.

## The topology diagram

The engine walks the instance once and returns it as a directed graph
(`GET /api/topology/graph` in `src/routes/topology.cpp`).
`lib/graphLayout.ts` turns that into coordinates. The split is deliberate.
What the relations *are* is an SDK question and belongs in the engine. How
they are *arranged* is a rendering question with no SDK in it, which lets the
layout be a pure function with unit tests instead of a screenshot.

Three decisions shape the picture:

**Devices are boxes, not nodes.** Drawing a device both as a node and as the
container of its channels means every channel gets an arrow that says
nothing. The box says the same thing with no ink.

**Input ports are ports, not nodes.** A port node per connection doubles the
graph for no information. Drawing them on the block, with the edge landing
on the right row, is what every dataflow editor does and stays readable at
twenty blocks.

**The layout is deterministic.** Layer by longest path, order by the median
heuristic with devices kept contiguous, then place. The same graph gives the
same picture. A diagram that reshuffles itself when the page polls cannot be
read.

Rendering is SVG rather than canvas, the opposite of the tracks' choice. A
track redraws sixty times a second and never needs to know what is under the
cursor. A diagram is hovered and clicked far more often than it is redrawn
and SVG makes each of those a one-liner instead of hit-testing arithmetic.

**Live values** put each signal's last value on its node. They come from the
same batched `last-values` request as the signal table, one request for
every signal and not one per node and only while the page is on screen. A
toggle turns them off for an instance where even that is too much. The graph
itself is not fetched again: the layout is stable and only the text on the
signal nodes changes.

## The scope trigger

A free-running scope shows whatever arrived last, so a periodic signal slides
across the plot and a one-off event is gone before anyone sees it. The
trigger pins the display to the moment the source crosses a level.

It is split into two pure parts in `lib/trigger.ts`, so every mode is a table
test rather than a screenshot:

**Detection is incremental.** `CrossingDetector` keeps its place in the trace
buffer (`TraceBuffer.scanAfter`) and examines each sample exactly once. The
obvious version rescans the last window every frame. It either costs a full
window per frame or, with a 1 ms window and 50 ms frames, steps over
crossings that land between two scans, which is the one failure a trigger
exists to prevent. The crossing time is interpolated between the two samples
either side, so the trace does not jitter by a sample period.

**Deciding what to show is stateless.** `decideView` takes the newest
crossing that can be shown *whole*: the samples after it already fill the
right-hand part of the window and the ones before it are still in the ring.
It returns the window's right edge and a status. Normal holds the last
capture while it waits. Auto free-runs after one and a half sweeps with
nothing to trigger on. Single captures the first crossing *after arming* and
stops acquisition, reusing the existing frozen-window mechanism so panning
around a capture works like panning anywhere else.

The window moves at frame rate, so it lives outside React
(`store/triggerState.ts`, for the same reason as the trace buffers). Only the
coarse status (armed, triggered, holding, captured) crosses into React and
only when it changes.

A **noise band** (hysteresis) re-arms the detector only once the signal has
gone that far back past the level. Without it, noise riding a slow edge
crosses the level several times per edge and the display jumps between them.

## The spectrum waterfall

The waterfall is the spectrum's history: one row per transform, newest at the
top, level as colour. Two decisions shape it.

**One hue, not a rainbow.** Level is a magnitude and magnitude is a
sequential ramp. `lib/colorRamp.ts` runs from the plot's own background, so
silence is invisible, through the brand colour to a tint of it, interpolated
in OKLab so equal steps look equal. A rainbow puts a bright yellow band in
the middle of the scale that reads as a peak that is not there. The ramp is
tested to be monotonic in lightness in both themes.

**The colour range follows what is on screen.** It is derived again from the
loudest visible bin each row, so a transient spike dims the plot only until
it scrolls off.

Rows arrive at the transform rate (up to about 12 a second), which a window
that throttles animation frames will lower. The time labels are taken from
each row's own timestamp, so they stay true either way.

Averaging, the spectrum's `smoothing`, is done on linear amplitude. The
previous frame arrives in whatever units the last *result* was in, so in dB
mode it is converted back before blending. Blending dB with volts collapses
every bin but the strongest to the -300 dB floor within a frame.

## Logging

Two streams reach the Log tab (`src/logs.cpp`). The engine's own lines are
the first. openDAQ's log is the second: it goes to the console by default,
which nobody sees in an app, so the instance is built with a rotating file
sink (two files of 4 MB) in `logs/` of the data folder and the engine copies
what was appended into the same ring whenever the log is read.

Both live in one bounded ring of 5000 records. Logs are read *after*
something went wrong, so the last few thousand lines are what matter and an
unbounded buffer in a process that runs for weeks is a leak. The UI polls
with a sequence cursor and asks only for records it has not seen.

**Debug is asymmetric and the UI says so.** openDAQ Studio's own level
changes immediately. openDAQ's cannot: its logger components take their level
when they are *created* and connecting a device creates more of them.
Raising it afterwards would apply to part of an instance and not the rest.
The switch therefore stores the choice in `logs/logging.json` and says that
it applies when openDAQ Studio starts again. The engine cannot restart
itself, so the answer carries `restartSupported: false`.

What debug buys is mostly openDAQ Studio's half. The engine logs every
request with its duration at the debug level
(`GET /api/components/tree in 10.2 ms`) and every request that fails with a
5xx status at the warning level. That is the ordered record of what
openDAQ Studio asked the SDK to do and how long each request took.

## Connecting openDAQ Studio to itself

Adding a server, making it discoverable and then connecting to it is an easy
mistake, because openDAQ Studio's own entry appears in the discovery list
beside everything else. Over a **configuration** protocol it is fatal and
fast. The client mirrors the server's device tree into the instance. That
mirror is part of the instance, so the server publishes it too and the
mirror gains a copy of itself:

```
/openDAQDevice/Dev/openDAQDevice/Dev/openDAQDevice/Dev/openDAQDevice/Dev/...
```

Each round also fires `ComponentAdded` for everything it created. openDAQ
does not stop it, so the engine does (`src/routes/selfconnect.cpp`). A
configuration connection to an address on this machine while this instance
is serving is refused with 409 `conflict`. Its detail explains why and names
the streaming address of the same server, which would have worked. Discovery
marks such an entry with `isSelf`.

Two details are deliberate. A **streaming** connection to the same server is
allowed, because it was measured to be safe: signals are mirrored and devices
are not, so there is nothing to recurse through and the object count holds
steady. The *diagnosis* respects the same guard. A "Test connection" that
tried each protocol "just to see" would do precisely the damage it was
invoked to explain.

## A device whose function blocks have no module here

A device can hold function blocks of a type whose module lives only on the
device. A configuration protocol has to rebuild those on the client. It
cannot build a type it cannot load, so openDAQ refuses the connection. A
protocol that only reads the device, such as OPC UA, is unaffected.
Connecting with that connection string is the user's choice in the Add device
dialog.

The components that could not be built are shown rather than hidden, because
hiding them would make the tree disagree with the hardware. Each carries
`functionBlock.moduleAvailable: false`, which the UI renders as a **module
missing** badge and a note saying what it means. The device provides the
block, so its signals and ports are listed. openDAQ Studio cannot build the
type, so its properties are unavailable.

## Where the type definitions live

The engine's routes build the JSON answers and are the single source of
truth for their shape. `frontend/src/lib/types.ts` mirrors them and
`docs/API.md` documents them. The engine was ported from the Python backend
and keeps its shapes. Where the API carries a value as text, such as the
detail of an event, `src/value_text.cpp` writes it. Request bodies are checked strictly, since that is where bad input arrives:
a member a route does not take is refused with 422.

## Testing

- **The engine's API tests** (`engine/tests/api`) run with
  pytest against the engine behind `tool/serve.mjs`, connected to the SDK's
  reference device. They hold the engine to its routes, JSON shapes,
  statuses, WebSocket messages and binary frames and they are its
  contract. Mocking the SDK would only prove the mock agrees with
  whatever assumption produced it.
- **The UI's tests** cover the pure logic: frame decoding, the ring buffer,
  the FFT, the trigger, tree projections and the property rules. A wrong FFT
  still draws a plausible curve, so the tests check the numbers an engineer
  would read off the screen.
