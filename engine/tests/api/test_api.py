"""End-to-end API tests against a real openDAQ instance with a reference device."""

from __future__ import annotations

import json
import struct
import urllib.parse

import httpx
import numpy as np
import pytest


def enc(component_id: str) -> str:
    return urllib.parse.quote(component_id, safe="")


class TestSystem:
    def test_version(self, client: httpx.Client):
        payload = client.get("/api/system/version").json()
        assert payload["apiVersion"]
        assert payload["sdkVersion"]

    def test_health_is_ready(self, client: httpx.Client):
        payload = client.get("/api/system/health").json()
        assert payload["ready"] is True

    def test_diagnostics_reports_a_running_loop(self, client: httpx.Client):
        payload = client.get("/api/system/diagnostics").json()
        assert payload["loop"]["iterations"] > 0
        assert payload["sdk"]["moduleCount"] > 0

    def test_shutdown_is_disabled_by_default(self, client: httpx.Client):
        assert client.post("/api/system/shutdown").status_code == 403


class TestTree:
    def test_root_is_the_instance(self, client: httpx.Client):
        root = client.get("/api/components/tree").json()["root"]
        assert root["kind"] == "instance"
        assert root["device"]["isRoot"] is True

    def test_default_folders_get_readable_names(self, client: httpx.Client):
        root = client.get("/api/components/tree").json()["root"]
        labels = {child["localId"]: child["displayName"] for child in root["children"]}
        assert labels["Sig"] == "Signals"
        assert labels["FB"] == "Function blocks"
        assert labels["Dev"] == "Devices"

    def test_reference_device_is_connected(self, client: httpx.Client, device_id: str):
        assert "RefDev" in device_id

    def test_hidden_components_change_the_tree(self, client: httpx.Client):
        visible = client.get("/api/components/tree").json()["root"]
        hidden = client.get("/api/components/tree", params={"includeHidden": True}).json()["root"]

        def count(node):
            return 1 + sum(count(child) for child in node["children"])

        assert count(hidden) >= count(visible)

    def test_unknown_component_is_404(self, client: httpx.Client):
        response = client.get("/api/components/detail", params={"id": "/openDAQDevice/Dev/Nope"})
        assert response.status_code == 404
        assert response.json()["code"] == "not_found"


class TestDetail:
    def test_channel_detail_has_properties_and_signals(self, client: httpx.Client, channel_id: str):
        payload = client.get("/api/components/detail", params={"id": channel_id}).json()
        assert payload["node"]["kind"] == "channel"
        names = {p["name"] for p in payload["properties"]["properties"]}
        assert {"Frequency", "Amplitude", "Waveform"} <= names
        assert payload["signals"], "a reference channel always publishes a signal"

    def test_attributes_report_lock_state(self, client: httpx.Client, channel_id: str):
        payload = client.get("/api/components/attributes", params={"id": channel_id}).json()
        by_key = {a["key"]: a for a in payload["attributes"]}
        assert by_key["GlobalId"]["locked"] is True
        assert by_key["Name"]["locked"] is False

    def test_selection_property_exposes_its_options(self, client: httpx.Client, channel_id: str):
        payload = client.get("/api/properties", params={"id": channel_id}).json()
        waveform = next(p for p in payload["properties"] if p["name"] == "Waveform")
        labels = [option["label"] for option in waveform["selectionValues"]]
        assert "Sine" in labels
        assert waveform["selectionKey"] is not None

    def test_numeric_limits_are_numbers(self, client: httpx.Client, channel_id: str):
        payload = client.get("/api/properties", params={"id": channel_id}).json()
        frequency = next(p for p in payload["properties"] if p["name"] == "Frequency")
        assert isinstance(frequency["minValue"], (int, float))
        assert isinstance(frequency["maxValue"], (int, float))

    def test_callable_properties_are_only_visible_with_hidden(self, client: httpx.Client, channel_id: str):
        payload = client.get("/api/properties", params={"id": channel_id, "includeHidden": True}).json()
        callables = {p["name"]: p["callable"] for p in payload["properties"] if p["callable"]}
        assert "ResetCounter" in callables
        assert callables["GetAndSetCounter"]["arguments"][0]["type"] == "int"


class TestPropertyWrites:
    def test_write_and_read_back(self, client: httpx.Client, channel_id: str):
        response = client.put(
            f"/api/properties/value?id={enc(channel_id)}",
            json={"path": ["Frequency"], "value": 123.5},
        )
        assert response.status_code == 200
        assert response.json()["value"] == pytest.approx(123.5)

    def test_clear_restores_the_default(self, client: httpx.Client, channel_id: str):
        client.put(f"/api/properties/value?id={enc(channel_id)}", json={"path": ["Amplitude"], "value": 3.0})
        cleared = client.post(
            f"/api/properties/clear?id={enc(channel_id)}", json={"path": ["Amplitude"]}
        ).json()
        assert cleared["value"] == cleared["defaultValue"]

    def test_read_only_property_is_rejected(self, client: httpx.Client, channel_id: str):
        response = client.put(
            f"/api/properties/value?id={enc(channel_id)}", json={"path": ["TestReadOnly"], "value": False}
        )
        assert response.status_code == 409
        assert response.json()["code"] == "conflict"

    def test_out_of_range_write_is_coerced_or_refused(self, client: httpx.Client, channel_id: str):
        # openDAQ clamps to min/max rather than failing; either behaviour is fine,
        # what matters is that the response tells the UI the real stored value.
        response = client.put(
            f"/api/properties/value?id={enc(channel_id)}", json={"path": ["Frequency"], "value": 1e9}
        )
        if response.status_code == 200:
            assert response.json()["value"] <= response.json()["maxValue"]
        else:
            assert response.json()["code"] in ("bad_request", "conflict", "sdk_error")

    def test_struct_field_write_keeps_the_other_fields(self, client: httpx.Client, channel_id: str):
        before = client.post(
            f"/api/properties/read?id={enc(channel_id)}", json={"path": ["CustomRange"]}
        ).json()["value"]
        after = client.put(
            f"/api/properties/struct-field?id={enc(channel_id)}",
            json={"path": ["CustomRange"], "field": "HighValue", "value": 4.25},
        ).json()["value"]
        assert after["fields"]["HighValue"] == pytest.approx(4.25)
        assert after["fields"]["LowValue"] == before["fields"]["LowValue"]

    def test_unknown_struct_field_is_404(self, client: httpx.Client, channel_id: str):
        response = client.put(
            f"/api/properties/struct-field?id={enc(channel_id)}",
            json={"path": ["CustomRange"], "field": "Nope", "value": 1},
        )
        assert response.status_code == 404

    def test_selection_property_is_written_by_key(self, client: httpx.Client, channel_id: str):
        result = client.put(
            f"/api/properties/value?id={enc(channel_id)}", json={"path": ["Waveform"], "value": 1}
        ).json()
        assert result["selectionKey"] == 1
        assert result["value"] == "Rect"
        client.put(f"/api/properties/value?id={enc(channel_id)}", json={"path": ["Waveform"], "value": 0})

    def test_extra_body_fields_are_rejected(self, client: httpx.Client, channel_id: str):
        response = client.put(
            f"/api/properties/value?id={enc(channel_id)}",
            json={"path": ["Frequency"], "value": 10, "typo": True},
        )
        assert response.status_code == 422


class TestCallables:
    def test_procedure_runs(self, client: httpx.Client, channel_id: str):
        result = client.post(
            f"/api/properties/execute?id={enc(channel_id)}", json={"path": ["ResetCounter"]}
        ).json()
        assert result["returned"] is False

    def test_function_returns_a_value(self, client: httpx.Client, channel_id: str):
        result = client.post(
            f"/api/properties/execute?id={enc(channel_id)}",
            json={"path": ["GetAndSetCounter"], "arguments": [11]},
        ).json()
        assert result["returned"] is True
        assert isinstance(result["result"], int)

    def test_wrong_argument_count_is_rejected(self, client: httpx.Client, channel_id: str):
        response = client.post(
            f"/api/properties/execute?id={enc(channel_id)}",
            json={"path": ["GetAndSetCounter"], "arguments": []},
        )
        assert response.status_code == 400
        assert "argument" in response.json()["message"]

    def test_executing_a_plain_property_is_rejected(self, client: httpx.Client, channel_id: str):
        response = client.post(f"/api/properties/execute?id={enc(channel_id)}", json={"path": ["Frequency"]})
        assert response.status_code == 400


class TestSignals:
    def test_chartable_filter(self, client: httpx.Client):
        payload = client.get("/api/signals", params={"chartableOnly": True}).json()
        assert payload["signals"]
        assert all(signal["chartable"] for signal in payload["signals"])

    def test_sample_rate_is_derived(self, client: httpx.Client, signal_id: str):
        detail = client.get("/api/signals/detail", params={"id": signal_id}).json()
        assert detail["sampleRate"] and detail["sampleRate"] > 0
        assert detail["domainDescriptor"]["tickResolution"]["denominator"] > 0

    def test_last_values_in_one_call(self, client: httpx.Client):
        payload = client.get("/api/signals/last-values").json()
        assert payload["values"]
        assert any(value["displayValue"] for value in payload["values"])

    def test_domain_signal_last_value_is_a_timestamp(self, client: httpx.Client, signal_id: str):
        detail = client.get("/api/signals/detail", params={"id": signal_id}).json()
        domain_id = detail["domainSignalId"]
        assert domain_id
        domain = client.get("/api/signals/detail", params={"id": domain_id}).json()
        # A time-domain signal reports ticks; the API converts them so the UI
        # never shows a bare 16-digit integer.
        assert domain["lastValue"]["kind"] == "timestamp"
        assert domain["lastValue"]["timestamp"].startswith("20")


class TestTypesAndModules:
    def test_device_types_include_the_reference_device(self, client: httpx.Client):
        ids = {t["id"] for t in client.get("/api/device-types").json()["types"]}
        assert "daqref" in ids

    def test_device_type_has_a_connection_prefix(self, client: httpx.Client):
        types = {t["id"]: t for t in client.get("/api/device-types").json()["types"]}
        assert types["daqref"]["connectionStringPrefix"] == "daqref"

    def test_modules_report_versions(self, client: httpx.Client):
        modules = client.get("/api/modules").json()["modules"]
        assert modules
        assert all(module["version"] for module in modules)

    def test_module_type_detail_includes_default_config(self, client: httpx.Client):
        modules = client.get("/api/modules").json()["modules"]
        for module in modules:
            for kind, entries in module["types"].items():
                if not entries:
                    continue
                detail = client.get(
                    "/api/modules/type",
                    params={"moduleId": module["id"], "kind": kind, "typeKey": entries[0]["key"]},
                ).json()
                assert detail["id"]
                return
        pytest.skip("no module exposes a component type")


class TestConnectionPlan:
    def test_plan_for_a_known_prefix(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "daqref://device9"}
        ).json()
        assert plan["impliedProtocol"] == "daqref"
        assert plan["errors"] == []
        sections = {p["name"] for p in plan["config"]["properties"]}
        assert {"General", "Device", "Streaming"} <= sections

    def test_plan_rejects_an_unknown_prefix(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "nosuch://thing"}
        ).json()
        assert plan["impliedProtocol"] is None
        assert plan["errors"]

    def test_smart_string_needs_discovery(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "daq://openDAQ_unknown"}
        ).json()
        assert any("daq://" in error for error in plan["errors"])

    def test_connecting_a_missing_device_reports_an_sdk_error(self, client: httpx.Client):
        response = client.post("/api/devices", json={"connectionString": "daqref://device9"})
        assert response.status_code in (400, 502)
        assert response.json()["code"] in ("bad_request", "sdk_error")


class TestFunctionBlocks:
    def test_add_connect_and_remove(self, client: httpx.Client, signal_id: str):
        added = client.post("/api/function-blocks", json={"typeId": "RefFBModuleStatistics"}).json()
        block_id = added["componentId"]
        assert block_id

        try:
            ports = client.get("/api/input-ports", params={"id": block_id}).json()["ports"]
            assert ports and ports[0]["signalId"] is None

            candidates = client.get("/api/input-ports/candidates", params={"id": ports[0]["id"]}).json()[
                "signals"
            ]
            assert any(candidate["id"] == signal_id for candidate in candidates)

            connected = client.put(
                f"/api/input-ports/connection?id={enc(ports[0]['id'])}", json={"signalId": signal_id}
            ).json()
            assert connected["signalId"] == signal_id

            disconnected = client.put(
                f"/api/input-ports/connection?id={enc(ports[0]['id'])}", json={"signalId": None}
            ).json()
            assert disconnected["signalId"] is None
        finally:
            removed = client.request("DELETE", "/api/function-blocks", params={"id": block_id})
            assert removed.status_code == 200

        assert client.get("/api/components/detail", params={"id": block_id}).status_code == 404

    def test_channels_cannot_be_removed(self, client: httpx.Client, channel_id: str):
        response = client.request("DELETE", "/api/function-blocks", params={"id": channel_id})
        assert response.status_code == 409

    def test_unknown_type_is_rejected(self, client: httpx.Client):
        response = client.post("/api/function-blocks", json={"typeId": "NoSuchBlock"})
        assert response.status_code in (400, 502)


class TestConfiguration:
    def test_save_then_inspect(self, client: httpx.Client):
        saved = client.get("/api/configuration").json()
        assert saved["sizeBytes"] > 0
        assert saved["suggestedFilename"].endswith(".json")

        inspected = client.post("/api/configuration/inspect", json={"content": saved["content"]}).json()
        assert inspected["summary"]["deviceCount"] >= 1
        parameter_names = {p["name"] for p in inspected["parameters"]["properties"]}
        assert "RemoteUpdate" in parameter_names

        # Per-device remapping needs SDK interfaces that older versions lack.
        # The endpoint reports an empty mode list there rather than offering
        # something the SDK would refuse.
        capabilities = client.get("/api/system/diagnostics").json()["sdk"]["capabilities"]
        if capabilities["deviceUpdateOptions"]:
            assert "Load" in inspected["updateModes"]
            assert "Remap" in inspected["updateModes"]
        else:
            assert inspected["updateModes"] == []

    def test_invalid_json_is_rejected(self, client: httpx.Client):
        response = client.post("/api/configuration/inspect", json={"content": "{not json"})
        assert response.status_code == 400

    def test_download_sets_a_filename(self, client: httpx.Client):
        response = client.get("/api/configuration/download")
        assert response.status_code == 200
        assert "attachment" in response.headers["content-disposition"]


class TestWebSocket:
    """The realtime path, driven the way a browser drives it.

    These run against uvicorn (see ``conftest``) because the streaming task keeps
    sending while the client closes - a pattern starlette's TestClient transport
    cannot represent.
    """

    @staticmethod
    def decode(frame: bytes):
        assert frame[:4] == b"ODQV", "frame is missing the magic prefix"
        version, header_length = struct.unpack_from("<HI", frame, 4)
        assert version == 1
        header = json.loads(frame[10 : 10 + header_length])
        body = frame[10 + header_length :]
        blocks = []
        for block in header["blocks"]:
            raw = body[block["byteOffset"] : block["byteOffset"] + block["byteLength"]]
            blocks.append((block, np.frombuffer(raw, dtype=np.float32)))
        return header, blocks

    @staticmethod
    async def collect(socket, *, frames: int = 0, want_text: str = "", timeout: float = 8.0):
        """Read until enough sample frames arrived, or a given text type appeared."""
        import asyncio

        binary, texts = [], []
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            try:
                message = await asyncio.wait_for(socket.recv(), timeout=max(0.05, remaining))
            except asyncio.TimeoutError:
                break
            if isinstance(message, bytes):
                binary.append(message)
            else:
                texts.append(json.loads(message))
                if want_text and texts[-1]["type"] == want_text:
                    break
            if frames and len(binary) >= frames:
                break
        return binary, texts

    def test_hello_then_samples(self, ws_url: str, signal_id: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as socket:
                hello = json.loads(await socket.recv())
                assert hello["type"] == "hello"
                assert hello["payload"]["clientId"]

                await socket.send(
                    json.dumps({"type": "subscribe", "signalIds": [signal_id], "pointsPerSecond": 20000})
                )
                binary, texts = await self.collect(socket, frames=3)

                subscribed = [t for t in texts if t["type"] == "subscribed"]
                assert subscribed, "the server never confirmed the subscription"
                meta = subscribed[0]["payload"]["signals"][0]
                assert meta["signalId"] == signal_id
                assert meta["sampleRate"] > 0
                assert meta["tickResolution"]["denominator"] > 0

                assert binary, "no sample frames arrived"
                total = 0
                for frame in binary:
                    header, blocks = self.decode(frame)
                    assert header["type"] == "samples"
                    for block, values in blocks:
                        assert block["signalId"] == signal_id
                        assert block["mode"] in ("raw", "minmax", "reset")
                        total += len(values)
                assert total > 0

        asyncio.run(scenario())

    def test_first_block_resets_and_carries_a_timebase(self, ws_url: str, signal_id: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [signal_id]}))
                binary, _ = await self.collect(socket, frames=4)
                assert binary

                blocks = [block for frame in binary for block, _ in self.decode(frame)[1]]
                # A fresh subscription must tell the client to clear its buffer.
                # That can arrive as a data-less "reset" marker when no samples
                # are buffered yet, so only require the flag on the first block.
                assert blocks[0]["reset"] is True

                data_blocks = [block for block in blocks if block["mode"] in ("raw", "minmax")]
                assert data_blocks, "no block carried samples"
                first = data_blocks[0]
                # An absolute start time plus a step is what lets the client place
                # samples on a shared time axis without asking again.
                assert first["startTime"] > 0
                assert first.get("sampleInterval") or first.get("bucketSeconds")

        asyncio.run(scenario())

    def test_samples_are_continuous_across_frames(self, ws_url: str, signal_id: str):
        """The cursor arithmetic must not drop or repeat samples between frames."""
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(
                    json.dumps(
                        {
                            "type": "subscribe",
                            "signalIds": [signal_id],
                            "pointsPerSecond": 1_000_000,  # force raw mode
                            "primeSeconds": 0,
                        }
                    )
                )
                binary, _ = await self.collect(socket, frames=6)
                assert len(binary) >= 3

                previous_end = None
                for frame in binary:
                    _, blocks = self.decode(frame)
                    for block, values in blocks:
                        if block["mode"] != "raw" or not len(values):
                            continue
                        start = block["startTime"]
                        interval = block["sampleInterval"]
                        if previous_end is not None and not block["reset"]:
                            # Each chunk should begin exactly one sample after the
                            # previous one ended; allow half a sample of slack.
                            assert abs(start - previous_end) < interval * 0.5 + 1e-9, (
                                f"gap of {start - previous_end:.9f}s between frames"
                            )
                        previous_end = start + interval * len(values)

        asyncio.run(scenario())

    def test_decimation_preserves_the_signal_range(self, ws_url: str, channel_id: str, client: httpx.Client):
        """Min/max buckets must still show the peaks of a full-scale sine.

        The channel is configured here rather than relying on defaults: a
        generator frequency near the sample rate aliases to DC, which would make
        this pass or fail depending on what an earlier test left behind.
        """
        import asyncio

        import websockets

        for name, value in (("Waveform", 0), ("Amplitude", 5.0), ("Frequency", 10.0)):
            client.put(
                f"/api/properties/value?id={enc(channel_id)}", json={"path": [name], "value": value}
            ).raise_for_status()

        detail = client.get("/api/components/detail", params={"id": channel_id}).json()
        signal_id = detail["signals"][0]["id"]

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(
                    json.dumps({"type": "subscribe", "signalIds": [signal_id], "pointsPerSecond": 20})
                )
                binary, _ = await self.collect(socket, frames=8, timeout=10.0)
                modes, low, high = set(), float("inf"), float("-inf")
                for frame in binary:
                    _, blocks = self.decode(frame)
                    for block, values in blocks:
                        modes.add(block["mode"])
                        if len(values):
                            low = min(low, float(values.min()))
                            high = max(high, float(values.max()))
                assert "minmax" in modes, "20 points/s should have triggered decimation"
                # A 5 V sine decimated to 20 points/s must still reach both peaks -
                # that is the whole point of min/max over plain subsampling.
                # (The descriptor's valueRange is only a hint on this device and can
                # be narrower than the data, so it is not asserted against.)
                assert high > 4.0 and low < -4.0, f"decimated range [{low}, {high}] lost the peaks"

        asyncio.run(scenario())

    def test_pause_stops_frames_and_resume_restarts_them(self, ws_url: str, signal_id: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [signal_id]}))
                first, _ = await self.collect(socket, frames=2)
                assert first

                await socket.send(json.dumps({"type": "pause", "paused": True}))
                await asyncio.sleep(0.3)
                # Drain anything already queued before the pause took effect.
                await self.collect(socket, frames=1, timeout=0.3)
                paused, _ = await self.collect(socket, frames=1, timeout=0.6)
                assert not paused, "frames kept arriving while paused"

                await socket.send(json.dumps({"type": "pause", "paused": False}))
                resumed, _ = await self.collect(socket, frames=1, timeout=3.0)
                assert resumed, "frames did not resume"

        asyncio.run(scenario())

    def test_unsubscribe_stops_frames(self, ws_url: str, signal_id: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [signal_id]}))
                await self.collect(socket, frames=2)
                await socket.send(json.dumps({"type": "unsubscribe"}))
                _, texts = await self.collect(socket, want_text="unsubscribed", timeout=3.0)
                confirmation = [t for t in texts if t["type"] == "unsubscribed"]
                assert confirmation and confirmation[0]["payload"]["signals"] == []
                await asyncio.sleep(0.2)
                binary, _ = await self.collect(socket, frames=1, timeout=0.6)
                assert not binary

        asyncio.run(scenario())

    def test_ping_pong(self, ws_url: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "ping", "payload": 7}))
                _, texts = await self.collect(socket, want_text="pong", timeout=3.0)
                pong = [t for t in texts if t["type"] == "pong"]
                assert pong and pong[0]["payload"]["echo"] == 7

        asyncio.run(scenario())

    def test_bad_messages_are_reported_but_keep_the_socket(self, ws_url: str):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()

                await socket.send("this is not json")
                _, texts = await self.collect(socket, want_text="error", timeout=3.0)
                assert any(t["type"] == "error" for t in texts)

                await socket.send(json.dumps({"type": "nonsense"}))
                _, texts = await self.collect(socket, want_text="error", timeout=3.0)
                errors = [t for t in texts if t["type"] == "error"]
                assert errors and errors[-1]["payload"]["code"] == "bad_request"

                # Still alive after two bad messages.
                await socket.send(json.dumps({"type": "ping"}))
                _, texts = await self.collect(socket, want_text="pong", timeout=3.0)
                assert any(t["type"] == "pong" for t in texts)

        asyncio.run(scenario())

    def test_subscribing_to_a_domain_signal_is_refused(
        self, ws_url: str, signal_id: str, client: httpx.Client
    ):
        import asyncio

        import websockets

        detail = client.get("/api/signals/detail", params={"id": signal_id}).json()
        domain_id = detail["domainSignalId"]
        assert domain_id

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [domain_id]}))
                _, texts = await self.collect(socket, want_text="error", timeout=4.0)
                errors = [t for t in texts if t["type"] == "error"]
                assert errors, "a domain signal has no scalar trace and must be refused"
                assert errors[0]["payload"]["code"] in ("bad_request", "not_found")

        asyncio.run(scenario())

    def test_one_unstreamable_signal_does_not_block_the_others(
        self, ws_url: str, signal_id: str, client: httpx.Client
    ):
        """A measurement output without a time axis yet must not stop its neighbours streaming."""
        import asyncio

        import websockets

        detail = client.get("/api/signals/detail", params={"id": signal_id}).json()
        domain_id = detail["domainSignalId"]

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [domain_id, signal_id]}))
                _, texts = await self.collect(socket, want_text="subscribed", timeout=4.0)
                replies = [t for t in texts if t["type"] == "subscribed"]
                assert replies, "the streamable signal must still be subscribed"
                streamed = [meta["signalId"] for meta in replies[0]["payload"]["signals"]]
                assert streamed == [signal_id]

        asyncio.run(scenario())

    def test_property_change_is_broadcast_to_other_clients(
        self, ws_url: str, channel_id: str, client: httpx.Client
    ):
        """A second browser tab must see edits made in the first one."""
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await asyncio.sleep(0.2)
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: client.put(
                        f"/api/properties/value?id={enc(channel_id)}",
                        json={"path": ["Amplitude"], "value": 2.25},
                    ),
                )
                _, texts = await self.collect(socket, want_text="component.propertyChanged", timeout=5.0)
                changes = [t for t in texts if t["type"] == "component.propertyChanged"]
                assert changes, "no propertyChanged event reached the second client"
                assert changes[0]["payload"]["componentId"] == channel_id

        asyncio.run(scenario())

    def test_topology_change_invalidates_the_tree(self, ws_url: str, client: httpx.Client):
        import asyncio

        import websockets

        async def scenario():
            async with websockets.connect(ws_url) as socket:
                await socket.recv()
                await asyncio.sleep(0.2)
                added = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: client.post(
                        "/api/function-blocks", json={"typeId": "RefFBModuleStatistics"}
                    ).json(),
                )
                try:
                    _, texts = await self.collect(socket, want_text="tree.changed", timeout=5.0)
                    assert any(t["type"] == "tree.changed" for t in texts)
                finally:
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: client.request(
                            "DELETE", "/api/function-blocks", params={"id": added["componentId"]}
                        ),
                    )

        asyncio.run(scenario())


class TestLocalDeviceConnectionPlan:
    """A local device is discoverable but advertises no server capabilities.

    Reporting it as "streaming only" would hide the configuration section it
    actually has - and local devices (reference, simulator, audio) are the first
    thing anyone tries.
    """

    def test_reference_device_offers_its_configuration_section(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "daqref://device0"}
        ).json()

        assert plan["discoverable"] is True
        assert plan["impliedProtocol"] == "daqref"
        assert plan["configProtocols"] == ["daqref"], "a local device still has a Device section"
        assert plan["errors"] == []

        # The section the plan names must exist in the configuration tree.
        device_section = next(p for p in plan["config"]["properties"] if p["name"] == "Device")
        assert "daqref" in {child["name"] for child in device_section["children"]}

    def test_local_device_reports_no_streaming(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "daqref://device0"}
        ).json()
        # It is not a network device, so there is nothing to stream over.
        assert plan["hasStreaming"] is False
        assert plan["serverCapabilities"] == []

    def test_unknown_prefix_still_offers_nothing(self, client: httpx.Client):
        plan = client.get(
            "/api/devices/connection-plan", params={"connectionString": "nosuch://thing"}
        ).json()
        assert plan["configProtocols"] == []
        assert plan["errors"]


class TestSdkCompatibility:
    """The viewer supports a range of SDK versions, and that range is not uniform.

    Some interfaces do not exist in the older ones; referencing them directly
    used to take out a whole page. These check the graceful path.
    """

    def test_diagnostics_reports_what_this_sdk_supports(self, client: httpx.Client):
        capabilities = client.get("/api/system/diagnostics").json()["sdk"]["capabilities"]
        assert capabilities["sdkVersion"]
        # Both are booleans regardless of the SDK; the UI branches on them.
        assert isinstance(capabilities["developmentVersionInfo"], bool)
        assert isinstance(capabilities["deviceUpdateOptions"], bool)

    def test_modules_list_works_without_the_development_version_interface(self, client: httpx.Client):
        # IDevelopmentVersionInfo was added after 3.30. Its absence must cost the
        # branch and hash fields, not the entire Modules page.
        modules = client.get("/api/modules").json()["modules"]
        assert modules, "the module list must survive on every supported SDK"
        for module in modules:
            assert module["version"], "every module reports a version"
            assert isinstance(module["isDevelopment"], bool)

    def test_configuration_load_rejects_remap_clearly_when_unsupported(self, client: httpx.Client):
        capabilities = client.get("/api/system/diagnostics").json()["sdk"]["capabilities"]
        if capabilities["deviceUpdateOptions"]:
            pytest.skip("this SDK supports device update options")

        saved = client.get("/api/configuration").json()
        response = client.post(
            "/api/configuration/load",
            json={"content": saved["content"], "deviceOptions": {"0": {"updateMode": "Remap"}}},
        )
        # It must say why, not fail with an AttributeError from deep in the SDK.
        assert response.status_code == 400
        assert "remap" in response.json()["message"].lower()


class TestSampleRateChange:
    def test_a_stream_follows_a_changed_device_sample_rate(self, client: httpx.Client, ws_url: str) -> None:
        """Streaming must keep up after the reference device is set to 1 MHz, even at full resolution."""
        import asyncio

        import websockets

        device = "/openDAQDevice/Dev/RefDev0"
        signals = client.get("/api/signals", params={"id": device, "chartableOnly": True}).json()["signals"]
        signal_id = signals[0]["id"]
        original = client.post(
            "/api/properties/read", params={"id": device}, json={"path": ["GlobalSampleRate"]}
        ).json()

        async def scenario() -> list:
            async with websockets.connect(ws_url, max_size=16 * 1024 * 1024) as socket:
                await socket.recv()
                await socket.send(
                    json.dumps({"type": "subscribe", "signalIds": [signal_id], "pointsPerSecond": 10_000_000})
                )
                await asyncio.sleep(0.5)
                await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda: client.put(
                        "/api/properties/value",
                        params={"id": device},
                        json={"path": ["GlobalSampleRate"], "value": 1_000_000},
                    ),
                )
                headers = []
                deadline = asyncio.get_running_loop().time() + 4.0
                while asyncio.get_running_loop().time() < deadline:
                    message = await asyncio.wait_for(socket.recv(), timeout=4.0)
                    if isinstance(message, bytes):
                        # "ODQV", a 2-byte version, a 4-byte header length, the JSON header.
                        length = int.from_bytes(message[6:10], "little")
                        headers.append(json.loads(message[10 : 10 + length]))
                return headers

        try:
            headers = asyncio.run(scenario())
        finally:
            client.put(
                "/api/properties/value",
                params={"id": device},
                json={"path": ["GlobalSampleRate"], "value": original["value"]},
            )
        recent = headers[-20:]
        blocks = [block for header in recent for block in header["blocks"]]
        assert blocks, "no samples arrived after the rate change"
        # It keeps up: nothing resets, and every frame's newest sample is recent.
        assert not any(block.get("reset") for block in blocks)
        for header in recent:
            for block in header["blocks"]:
                if not block.get("count"):
                    continue
                newest = block["startTime"] + block["count"] * (block.get("sampleInterval") or 0)
                assert header["sentAt"] - newest < 0.5, (header["sentAt"] - newest, block)


class TestChannelToggle:
    def test_a_stream_resumes_after_its_channel_is_switched_off_and_on(
        self, client: httpx.Client, ws_url: str
    ) -> None:
        """The SDK reader holds an event packet after the toggle; the stream must read past it."""
        import asyncio
        import time

        import websockets

        channel = "/openDAQDevice/Dev/RefDev0/IO/AI/RefCh0"
        signal_id = f"{channel}/Sig/AI0"

        async def scenario() -> float:
            async with websockets.connect(ws_url, max_size=16 * 1024 * 1024) as socket:
                await socket.recv()
                await socket.send(json.dumps({"type": "subscribe", "signalIds": [signal_id]}))
                loop = asyncio.get_running_loop()
                await asyncio.sleep(0.5)
                await loop.run_in_executor(
                    None,
                    lambda: client.put(
                        "/api/components/active", params={"id": channel}, json={"active": False}
                    ),
                )
                await asyncio.sleep(1.0)
                await loop.run_in_executor(
                    None,
                    lambda: client.put(
                        "/api/components/active", params={"id": channel}, json={"active": True}
                    ),
                )
                switched_on = time.time()
                last_sample_at = 0.0
                deadline = loop.time() + 3.0
                while loop.time() < deadline:
                    try:
                        message = await asyncio.wait_for(socket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if isinstance(message, bytes):
                        length = int.from_bytes(message[6:10], "little")
                        header = json.loads(message[10 : 10 + length])
                        for block in header["blocks"]:
                            if block["signalId"] == signal_id and block.get("count"):
                                last_sample_at = max(last_sample_at, header["sentAt"])
                return last_sample_at - switched_on

        try:
            after = asyncio.run(scenario())
        finally:
            client.put("/api/components/active", params={"id": channel}, json={"active": True})
        assert after > 1.0, "no samples arrived once the channel was switched on again"
