"""Which function block types work on a signal, as the SDK itself reports it."""

from __future__ import annotations

from typing import Any, Dict

import httpx


def fit(client: httpx.Client, signal_id: str) -> Dict[str, Dict[str, Any]]:
    response = client.get("/api/signals/function-block-fit", params={"id": signal_id})
    response.raise_for_status()
    return {entry["id"]: entry for entry in response.json()["types"]}


def block_ids(client: httpx.Client) -> set:
    found = set()

    def walk(node: Dict[str, Any]) -> None:
        if node.get("kind") in ("functionBlock", "recorder"):
            found.add(node["id"])
        for child in node.get("children", []):
            walk(child)

    walk(client.get("/api/components/tree").json()["root"])
    return found


def test_the_check_is_silent_on_the_event_stream(ws_url: str, client: httpx.Client, signal_id: str) -> None:
    """The probe blocks exist for a millisecond; the UI must not hear about them.

    It runs before the other checks in this file, while the engine has not
    probed this kind of signal yet, so the blocks are really added.
    """
    import asyncio
    import json
    import time

    import websockets

    started = time.time()

    async def scenario() -> list:
        async with websockets.connect(ws_url) as socket:
            await socket.recv()  # hello
            await asyncio.get_running_loop().run_in_executor(None, lambda: fit(client, signal_id))
            texts = []
            deadline = asyncio.get_running_loop().time() + 2.0
            while asyncio.get_running_loop().time() < deadline:
                try:
                    message = await asyncio.wait_for(socket.recv(), timeout=0.3)
                except asyncio.TimeoutError:
                    continue
                if isinstance(message, str):
                    texts.append(json.loads(message))
            return texts

    texts = asyncio.run(scenario())
    # The server replays recent history on connect; only what came after counts.
    notices = [t for t in texts if t.get("type") == "notification" and t.get("at", 0) >= started]
    assert not any("component" in (n.get("payload", {}).get("message", "")).lower() for n in notices), notices


class TestFunctionBlockFit:
    def test_single_input_blocks_work_on_an_analog_signal(self, client: httpx.Client, signal_id: str) -> None:
        types = fit(client, signal_id)
        assert types["RefFBModuleStatistics"]["works"] is True
        assert types["RefFBModuleStatistics"]["name"] == "Statistics"
        assert types["RefFBModuleFFT"]["works"] is True

    def test_a_block_that_needs_a_second_signal_says_so(self, client: httpx.Client, signal_id: str) -> None:
        power = fit(client, signal_id)["RefFBModulePower"]
        assert power["works"] is False
        assert power["reason"]

    def test_a_block_for_another_sample_type_is_refused_with_the_sdk_reason(
        self, client: httpx.Client, signal_id: str
    ) -> None:
        decoder = fit(client, signal_id)["RefFBModuleStructDecoder"]
        assert decoder["works"] is False
        assert "sample type" in decoder["reason"].lower()

    def test_the_fft_output_is_an_array(self, client: httpx.Client, signal_id: str) -> None:
        fft = fit(client, signal_id)["RefFBModuleFFT"]
        assert any(output["shape"] == "array" for output in fft["outputs"])

    def test_window_opening_blocks_are_never_added(self, client: httpx.Client, signal_id: str) -> None:
        renderer = fit(client, signal_id).get("RefFBModuleRenderer")
        if renderer is not None:
            assert renderer["works"] is False and "window" in renderer["reason"]

    def test_the_check_leaves_no_block_behind(self, client: httpx.Client, signal_id: str) -> None:
        before = block_ids(client)
        fit(client, signal_id)
        assert block_ids(client) == before

    def test_signals_report_their_shape(self, client: httpx.Client, signal_id: str) -> None:
        detail = client.get("/api/signals/detail", params={"id": signal_id}).json()
        assert detail["shape"] == "scalar"
