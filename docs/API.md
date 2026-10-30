# API reference

68 routes and one channel for live data and events. Everything the UI does
is a request to one of these routes. The engine
(`engine/src/routes/`) answers them. This document covers
the conventions, the routes and the payload shapes.

## Reaching the API

The routes are HTTP-style: a method, a path, query parameters and a JSON
body, answered with JSON and a status. How a request reaches the engine
depends on where the UI runs.

- **In the desktop app** the UI fetches `studio://app/api/...`. The main
  process passes the request to the engine and returns its answer. Live data
  and events travel over the window's message port. No network port is
  opened, so nothing outside the app's window can reach the API.
- **Against the engine's development server** (`make serve`, which runs
  `engine/tool/serve.mjs`) the same routes are served over
  HTTP on port 8420 and live data and events over a WebSocket at `/api/ws`.
  The examples below use it and so do the engine's API tests.

Compared with the Python backend these routes come from, the following are
gone:

- the SDK version manager, every route under `/api/sdk/`;
- read-only mode and the `read_only` error;
- the generated OpenAPI page at `/docs`.

`POST /api/system/shutdown` remains and always answers 403: the desktop shell
stops the engine itself. `GET /api/system/info` and `GET /api/system/version`
answer `"embedded": true`, because the SDK is the one the app was built
with.

## Conventions

### Component ids go in the query string

openDAQ global ids look like `/openDAQDevice/Dev/RefDev0/IO/AI/RefCh0`. They
begin with a slash, contain slashes and may contain spaces. Putting them in
the path would mean double slashes and encoding traps, so every route takes
them as `?id=`:

```bash
curl -sG http://localhost:8420/api/components/detail \
     --data-urlencode 'id=/openDAQDevice/Dev/RefDev0/IO/AI/RefCh0'
```

### Property paths are arrays

A property is addressed by its owning component plus a *path*, the list of
property names to walk. `["AddressInfo", "IPv4", "ConnectionString"]`
descends through two nested object properties. Paths always travel in the
JSON body.

### Errors are structured

```json
{ "code": "conflict", "message": "property 'TestReadOnly' is read-only" }
```

| `code` | Status | Meaning |
|---|---|---|
| `not_found` | 404 | The component, property, module id or route did not resolve |
| `method_not_allowed` | 405 | The route exists but does not take this method |
| `bad_request` | 400 | Structurally valid, but cannot be applied |
| `conflict` | 409 | The instance forbids it (locked device, read-only property, a connection to itself) |
| `sdk_error` | 502 | openDAQ rejected the call; `detail` carries its message |
| `not_ready` | 503 | The engine is not running |
| `offline` | 503 | The engine's process stopped (desktop app) |
| `invalid_request` | 422 | The request failed validation |
| `internal_error` | 500 | An unexpected failure in the engine |

Request bodies are strict. A member a route does not take is refused with
422.

### Hidden components

Most read routes accept `includeHidden=true`, which corresponds to the SDK's
`AnySearchFilter` and to "Show hidden components" in the UI.

## Values on the wire

Scalars (`bool`, `int`, `float`, `string`, `null`), lists and plain objects
pass through as themselves. Anything richer carries a `kind` discriminator,
so the UI can pick an editor and send a faithful value back:

```jsonc
{ "kind": "struct", "typeName": "Range",
  "fieldNames": ["LowValue", "HighValue"],
  "fields": { "LowValue": -10.0, "HighValue": 10.0 } }

{ "kind": "enumeration", "typeName": "ComponentStatusType",
  "name": "Ok", "value": 0, "enumerators": ["Ok", "Warning", "Error"] }

{ "kind": "ratio", "numerator": 1, "denominator": 1000000, "value": 1e-6 }

{ "kind": "complex", "real": 1.0, "imaginary": -0.5 }

{ "kind": "object", "className": null }     // expand via `children`
```

Writing accepts the same shapes. Two conversions are worth knowing:

- A string starting with `eval:` becomes an openDAQ `EvalValue`, matching the
  SDK demo.
- Numeric strings may carry the unit (`"50 Hz"`); the suffix is stripped.

`Range`, `Unit` and `ComplexNumber` are built through their own SDK
factories. Any other struct needs `typeName` to match a registered struct
type.

Non-finite floats become `null`, because JSON has no `NaN` or `Infinity`. The
UI renders `null` as "n/a".

## Routes

### System

| | | |
|---|---|---|
| `GET /api/system/version` | App, API and SDK versions | |
| `GET /api/system/health` | Liveness and readiness | |
| `GET /api/system/info` | Instance identity and effective settings | |
| `GET /api/system/diagnostics` | Call timing, streams, clients, SDK facts | |
| `GET /api/system/events` | Recent notification history | `limit` |
| `GET /api/system/logs` | The engine's and openDAQ's log, merged | `limit`, `since`, `level`, `source`, `search` |
| `PUT /api/system/logs/level` | Set the engine's and the SDK's log level | |
| `POST /api/system/shutdown` | Always refused with 403 | |

`GET /api/system/health` answers `{"ready": true}` once the engine answers at
all, because the engine starts before the window opens.

`GET /api/system/logs` returns the records after sequence number `since` at
`level` or louder, from `source` (`viewer` for the engine, `sdk` for openDAQ,
both when empty), oldest first. `limit` is 1 to 5000 and 500 by default.
`PUT /api/system/logs/level` takes `{"viewer": "debug", "sdk": "info"}`. The
engine's level changes at once. The SDK's is stored in `logs/logging.json` of
the data folder and applies at the next start, which the answer reports as
`restartRequired`. `restartSupported` is always false.

### Components

| | | |
|---|---|---|
| `GET /api/components/tree` | The whole component tree in one call | `includeHidden` |
| `GET /api/components/detail` | Node, attributes, properties, ports, signals | `id`, `includeHidden` |
| `GET /api/components/attributes` | Attribute list | `id` |
| `PUT /api/components/attributes` | Write one attribute | `id` |
| `PUT /api/components/active` | Toggle the active flag | `id` |
| `GET /api/components/statuses` | Status container contents | `id` |
| `POST /api/components/begin-update` | Open a batched-write block | `id` |
| `POST /api/components/end-update` | Commit a batched-write block | `id` |
| `POST /api/components/clear-properties` | Reset every property to its default | `id` |
| `GET /api/components/metadata-fields` | Property metadata columns available | |

`/tree` returns the entire hierarchy including custom components. The
navigator's views are projections of it, computed in the UI.

Each node carries facets for its kind (`device`, `functionBlock`, `signal`,
`inputPort`, `server`), so a client does not need a second request to know
whether a device is locked or a recorder is running.

### Properties

| | | |
|---|---|---|
| `GET /api/properties` | Property tree of a component | `id`, `includeHidden` |
| `POST /api/properties/read` | One property by path | `id` |
| `POST /api/properties/metadata` | Everything the SDK knows about it | `id` |
| `PUT /api/properties/value` | Write a value | `id` |
| `PUT /api/properties/struct-field` | Write one field of a struct | `id` |
| `PUT /api/properties/container` | Replace a list or dict wholesale | `id` |
| `POST /api/properties/clear` | Reset to default | `id` |
| `POST /api/properties/execute` | Invoke a function or procedure | `id` |

```bash
# Set a channel's frequency
curl -X PUT "http://localhost:8420/api/properties/value?id=$ID" \
     -H 'content-type: application/json' \
     -d '{"path": ["Frequency"], "value": 250}'

# Selection properties are written by key, not by label
curl -X PUT "http://localhost:8420/api/properties/value?id=$ID" \
     -H 'content-type: application/json' \
     -d '{"path": ["Waveform"], "value": 1}'

# Structs are immutable, so one field at a time
curl -X PUT "http://localhost:8420/api/properties/struct-field?id=$ID" \
     -H 'content-type: application/json' \
     -d '{"path": ["CustomRange"], "field": "HighValue", "value": 7.5}'

# Call a function property
curl -X POST "http://localhost:8420/api/properties/execute?id=$ID" \
     -H 'content-type: application/json' \
     -d '{"path": ["GetAndSetCounter"], "arguments": [42]}'
```

Callable properties are usually hidden, so pass `includeHidden=true` to see
them.

### Topology graph

| | | |
|---|---|---|
| `GET /api/topology/graph` | The instance as a dataflow graph | `includeHidden` |

One request rather than one per component: the engine walks the instance
once. It returns `nodes`, `edges`, `groups` and `stats`.

Input ports are **not** nodes. They are `ports` on the function block that
owns them, which is how the diagram draws them and saves a hop per
connection:

```jsonc
{
  "nodes": [
    { "id": "…/RefCh0", "kind": "channel", "groupId": "…/RefDev0", "ports": [] },
    { "id": "…/AI0", "kind": "signal", "detail": { "sampleRate": 1000.0, "domainSignalName": "AI0Time" } },
    { "id": "…/Statistics_1", "kind": "functionBlock",
      "ports": [{ "id": "…/Input", "name": "Input", "requiresSignal": true, "signalId": "…/AI0" }] }
  ],
  "edges": [
    { "source": "…/RefCh0", "target": "…/AI0", "kind": "produces", "label": "" },
    { "source": "…/AI0", "target": "…/Statistics_1", "kind": "signal", "label": "Input" }
  ]
}
```

Edge kinds: `produces` (who owns an output signal), `signal` (a connection
into an input port), `domain` (what timestamps a signal), `contains` and
`publishes` (hierarchy). Domain signals are hidden components, so they and
their edges appear only under `includeHidden`. Every value signal names its
own regardless.

### Function blocks without a module here

Components openDAQ Studio has no module for come back with
`functionBlock.moduleAvailable: false` on both the tree and the detail
routes. Channels are always `null`, because an unknown channel type mirrors
fine.

### Devices, function blocks, servers

| | | |
|---|---|---|
| `GET /api/devices/discover` | Run a discovery sweep *(slow)* | `id` |
| `GET /api/devices/connection-plan` | Options for one connection string | `connectionString`, `id` |
| `GET /api/devices/info` | Full info of a discovered device | `connectionString`, `id` |
| `POST /api/devices` | Connect a device | |
| `DELETE /api/devices` | Disconnect a device | `id` |
| `PUT /api/devices/lock` | Lock, unlock or force unlock | `id` |
| `PUT /api/devices/operation-mode` | Set the operation mode | `id` |
| `GET /api/device-types` | Device types a device can instantiate | `id` |
| `GET /api/function-block-types` | Block types a host can instantiate | `id` |
| `POST /api/function-blocks` | Add a function block | |
| `DELETE /api/function-blocks` | Remove one | `id` |
| `PUT /api/function-blocks/recording` | Start or stop a recorder | `id` |
| `GET /api/server-types`, `GET /api/servers` | Server types and running servers | |
| `POST /api/servers`, `DELETE /api/servers` | Start and stop servers | `id` |
| `PUT /api/servers/discovery` | Enable or disable discovery | `id` |
| `GET /api/streaming-types` | Streaming types across all modules | |
| `GET /api/type-config` | Default configuration of one type | `kind`, `typeId`, `id` |
| `GET /api/input-ports` | Ports of a function block | `id` |
| `GET /api/input-ports/candidates` | Signals a port can connect to | `id` |
| `PUT /api/input-ports/connection` | Connect or disconnect (`null` to clear) | `id` |

`GET /api/function-block-types` lists, for a device, the types of that
device's own modules. Discovery marks an entry that is this instance itself
with `isSelf`. A configuration connection to this instance's own server is
refused with 409 (see ARCHITECTURE.md).

#### Connecting with configuration

The flow is stateless. Ask what the connection string implies, then submit a
flat override map:

```bash
curl -sG http://localhost:8420/api/devices/connection-plan \
     --data-urlencode 'connectionString=daq.nd://192.168.1.20'
```

```jsonc
{
  "impliedProtocol": "OpenDAQNativeConfiguration",
  "discoverable": true,
  "configProtocols": ["OpenDAQNativeConfiguration"],
  "streamingProtocols": ["OpenDAQNativeStreaming", "OpenDAQLTStreaming"],
  "addressTypes": ["IPv4", "IPv6"],
  "config": { /* the SDK's default configuration tree */ },
  "errors": []
}
```

```bash
curl -X POST http://localhost:8420/api/devices \
     -H 'content-type: application/json' \
     -d '{
       "connectionString": "daq.nd://192.168.1.20",
       "config": {
         "General.AllowedStreamingProtocols": ["OpenDAQNativeStreaming"],
         "General.Username": "operator"
       }
     }'
```

Keys the SDK does not recognise come back in `ignoredConfigKeys` rather than
failing the connection, so a client one release ahead degrades gracefully.

### Signals

| | | |
|---|---|---|
| `GET /api/signals` | Signals under a component or the instance | `id`, `chartableOnly`, `withDescriptor`, `includeHidden` |
| `GET /api/signals/detail` | One signal with both descriptors | `id` |
| `GET /api/signals/descriptor` | Value and domain descriptors | `id` |
| `GET /api/signals/function-block-fit` | Every function block type, with whether it works on this signal and why not | `id` |
| `GET /api/signals/last-values` | Current value of many signals at once | `id` (repeatable), `scopeId` |
| `GET /api/signals/picture` | The newest picture of an image signal | `id`, `after` |

`last-values` takes `id` repeatedly or none at all for every signal. That is
one request regardless of how many signals a screen shows.

`sampleRate` is derived, not stored. It falls out of the domain signal's
linear data rule (`delta` ticks per sample) and its tick resolution.
`chartable` is true only for scalar numeric signals that have a domain
signal.

`image` is null except for an image signal, such as a phone's camera, where
it names the picture format. openDAQ's video convention, which the SDK's
Video Player function block also reads, gives such a signal sample type
`Binary`, one encoded picture per sample and the format as its unit's symbol
(`jpeg`, `png`, `bmp`). `imageSize` is `{width, height}` when the device puts
them in the descriptor's metadata. `picture` returns the newest picture in
its own format, with its number in the `X-Picture-Sequence` header. With
`after` set to the number the caller has, it answers 204 until a newer one
arrives, so polling costs little. The engine reads an image signal only while
someone asks for its pictures and stops ten seconds after the last request.

### Time

| | | |
|---|---|---|
| `GET /api/time` | Every device's synchronization and clock, the time master and alignment | |
| `PUT /api/time/align` | Align devices in plots by their clock offsets | |
| `PUT /api/time/master` | Point devices that follow NTP at Studio's time server | |

`GET /api/time` returns `devices`, each with its `sync` interfaces (name,
mode, state, whether selected), the addresses it `serves` time on and its
`clock` against this computer's (`offsetMs`, `uncertaintyMs`). It also
returns the time `master` and whether `align` is enabled. Both `PUT` routes
take `{"enabled": true}`. Aligning shifts the times of each device's samples
by its measured offset. The devices themselves are left as they are.

### Fleet

| | | |
|---|---|---|
| `GET /api/fleet` | Every connected device at a glance | |

Each entry of `devices` carries the device's identity, `connected`, its
`operationMode` and the modes it offers, its `status`, the `total` and
`active` count of its `channels` and its `time` as `GET /api/time` reports
it. A phone with the Android device module adds its `system` readings and its
`dashboard` addresses and PIN.

### Configuration and modules

| | | |
|---|---|---|
| `GET /api/configuration` | Current configuration as JSON text | |
| `GET /api/configuration/download` | The same, as a file download | |
| `POST /api/configuration/inspect` | Preview without applying | |
| `POST /api/configuration/load` | Apply | |
| `GET /api/modules` | Loaded modules and their component types | |
| `GET /api/modules/type` | One type with its default configuration | `moduleId`, `kind`, `typeKey` |
| `POST /api/modules/load` | Load a module from disk | |

`inspect` returns the update parameters and the per-device option tree the
file implies, without touching the instance. Each device can then be kept,
skipped, removed or remapped to a different connection string:

```bash
curl -X POST http://localhost:8420/api/configuration/load \
     -H 'content-type: application/json' \
     -d '{
       "content": "...",
       "parameters": { "RemoteUpdate": true },
       "deviceOptions": {
         "0": { "updateMode": "Remap", "newConnectionString": "daq.nd://10.0.0.7" }
       }
     }'
```

### Sharing

| | | |
|---|---|---|
| `GET /api/sharing`, `PUT /api/sharing` | Serve the instance over openDAQ's native streaming protocol | |

The phone app uses these routes. `PUT` takes `{"enabled": true}` and starts
or stops a native streaming server on port 7420, announced with mDNS when the
instance has discovery. Both answer `enabled`, `port`, `announced` and
`name`.

## Live data and events

One channel per client carries both events and samples. In the desktop app
it is the window's message port; against the development server it is the
WebSocket at `/api/ws`. **Text** messages are JSON control and event
messages. **Binary** messages are sample frames.

### Client to engine

```jsonc
{ "type": "subscribe", "signalIds": ["/openDAQDevice/.../AI0"],
  "pointsPerSecond": 4000, "primeSeconds": 1 }
{ "type": "unsubscribe", "signalIds": ["..."] }   // omit to drop all
{ "type": "resolution", "pointsPerSecond": 2000 }
{ "type": "pause", "paused": true }
{ "type": "ping" }
```

`pointsPerSecond` drives decimation in the engine. Ask for less than the
signal produces and the engine sends min/max pairs instead of raw samples.
`primeSeconds` is the history the first frame carries.

### Engine to client (text)

Every message is `{type, payload}`. Events also carry `seq` and `at`.

| `type` | Meaning |
|---|---|
| `hello` | Client id, versions, frame interval, points per frame; `readOnly` is always false |
| `subscribed` | Stream metadata: sample rate, unit, tick resolution, epoch offset |
| `unsubscribed` | The signals still subscribed |
| `tree.changed` | The component tree changed; read it again (coalesced in the engine) |
| `component.propertyChanged` | A property changed, possibly from another window |
| `component.attributeChanged`, `component.statusChanged` | Attribute and status updates |
| `component.updated` | Any other core event |
| `device.connectionStatusChanged` | A device connected or dropped |
| `notification` | User-visible log entry with a severity |
| `error` | A command was rejected; the channel stays open |
| `pong` | Reply to `ping` |

Unknown event types should be ignored. A newer engine may emit more of them
and that must not break an older client.

### Engine to client (binary)

```
  0 ..  3   magic "ODQV"
  4 ..  5   uint16 version   (currently 1)
  6 ..  9   uint32 header length
 10 ..  N   UTF-8 JSON header
  N ..      concatenated Float32 payloads
```

The header:

```jsonc
{
  "type": "samples",
  "sentAt": 1788683151.55,
  "blocks": [{
    "signalId": "/openDAQDevice/.../AI0",
    "mode": "raw",              // "raw" | "minmax" | "reset"
    "reset": false,             // clear the client buffer before appending
    "epoch": 0,                 // increments on any discontinuity
    "startTime": 1788683151.55, // absolute epoch seconds of the first sample
    "sampleInterval": 0.00005,  // raw mode
    // "bucketSeconds": 0.005,  // minmax mode: seconds covered per pair
    // "buckets": 100,
    "count": 968,
    "byteOffset": 0,
    "byteLength": 3872,
    "ended": false
  }]
}
```

In `minmax` mode the payload is interleaved `[min, max, min, max, …]`, one
pair per bucket. In `raw` mode it is the samples themselves. A block with
`mode: "reset"` carries no payload and only tells the client to clear.

A client that ignores `reset` will eventually splice unrelated data
together, so it is not optional.

### Reconnecting

The desired subscription set should be replayed on every open, because the
engine keeps no state for a closed client. The UI does this automatically. A
desktop window gets a new port and a new client each time its page loads,
followed by `hello` and the last 40 notifications.

## Scripting example

Against the development server (`make serve`):

```python
import httpx

BASE = "http://localhost:8420"

with httpx.Client(base_url=BASE) as client:
    client.post("/api/devices", json={"connectionString": "daqref://device0"})

    tree = client.get("/api/components/tree").json()["root"]
    channel = next(
        node["id"]
        for node in _walk(tree)          # depth-first over node["children"]
        if node["kind"] == "channel"
    )

    client.put(
        "/api/properties/value",
        params={"id": channel},
        json={"path": ["Frequency"], "value": 250},
    ).raise_for_status()

    for value in client.get("/api/signals/last-values").json()["values"]:
        print(value["id"], value["displayValue"])
```
