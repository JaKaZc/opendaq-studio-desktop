"""Shared fixtures of the engine's API tests.

The suite was the Python backend's own, and its expectations are what the
engine was ported to match: routes, JSON shapes, statuses, the WebSocket's
messages and the binary frames. It runs against the engine behind
tool/serve.mjs, which serves the HTTP API and the /api/ws WebSocket through
the Node addon, so it needs `tool/build_desktop.sh` run first.

The fixtures connect the SDK's reference device rather than mocking it: the
engine's value is that it matches SDK behaviour, and a mock would agree with a
wrong assumption about descriptors, selection properties or domain ticks.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Iterator

import httpx
import pytest

ENGINE_ROOT = Path(os.environ.get("STUDIO_ENGINE_ROOT") or Path(__file__).resolve().parents[2])
#: The devices the engine connects at start.
DEVICES = ["daqref://device0"]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class EngineServer:
    """The engine behind tool/serve.mjs, in a child process."""

    def __init__(self, devices: list[str], data_dir: Path) -> None:
        self.port = free_port()
        self._devices = devices
        self._data_dir = data_dir
        self._process: subprocess.Popen | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/api/ws"

    def start(self, timeout: float = 90.0) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("node is needed to serve the engine")
        command = [node, str(ENGINE_ROOT / "tool" / "serve.mjs"), "--port", str(self.port), "--stream-interval", "0.02"]
        for device in self._devices:
            command += ["--device", device]
        # The engine keeps its logs and settings in the data folder; the suite
        # must not touch the one the installed app uses.
        environment = {**os.environ, "OPENDAQ_STUDIO_DATA_DIR": str(self._data_dir)}
        self._process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                raise RuntimeError(f"the engine server exited with {self._process.returncode}")
            try:
                response = httpx.get(f"{self.base_url}/api/system/health", timeout=2.0)
                if response.status_code == 200 and response.json().get("ready"):
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        raise RuntimeError("the engine server did not become ready in time")

    def stop(self, timeout: float = 30.0) -> None:
        if self._process is None:
            return
        self._process.terminate()
        try:
            self._process.wait(timeout)
        except subprocess.TimeoutExpired:
            self._process.kill()


@pytest.fixture(scope="session")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[EngineServer]:
    live = EngineServer(DEVICES, tmp_path_factory.mktemp("studio-data"))
    live.start()
    try:
        yield live
    finally:
        live.stop()


@pytest.fixture(scope="session")
def ws_url(server: EngineServer) -> str:
    return server.ws_url


@pytest.fixture(scope="session")
def client(server: EngineServer) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=server.base_url, timeout=30.0) as http_client:
        yield http_client


@pytest.fixture(scope="session")
def device_id(client: httpx.Client) -> str:
    root = client.get("/api/components/tree").raise_for_status().json()["root"]
    for folder in root["children"]:
        if folder["localId"] == "Dev":
            assert folder["children"], "no reference device was connected"
            return folder["children"][0]["id"]
    raise AssertionError("no device folder in the tree")


@pytest.fixture(scope="session")
def channel_id(client: httpx.Client) -> str:
    root = client.get("/api/components/tree").raise_for_status().json()["root"]

    def find(node):
        if node["kind"] == "channel":
            return node["id"]
        for child in node["children"]:
            found = find(child)
            if found:
                return found
        return None

    channel = find(root)
    assert channel, "the reference device exposes no channels"
    return channel


@pytest.fixture(scope="session")
def signal_id(client: httpx.Client) -> str:
    signals = client.get("/api/signals", params={"chartableOnly": True}).raise_for_status().json()["signals"]
    assert signals, "no chartable signals found"
    return signals[0]["id"]
