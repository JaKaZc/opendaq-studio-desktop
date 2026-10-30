"""The devices' synchronization and clocks (GET /api/time), against the
reference device the suite connects."""

from __future__ import annotations

import httpx


def test_reference_device_reports_its_sync_and_clock(client: httpx.Client, device_id: str):
    devices = client.get("/api/time").raise_for_status().json()["devices"]
    device = next(entry for entry in devices if entry["id"] == device_id)
    names = [item["name"] for item in device["sync"]["interfaces"]]
    assert "InterfaceClockSync" in names
    assert any(item["selected"] for item in device["sync"]["interfaces"])
    # The reference device counts from the Unix epoch on this computer's
    # clock, so the two agree to within the time the measurement takes.
    assert abs(device["clock"]["offsetMs"]) < 50
    root = next(entry for entry in devices if entry["isRoot"])
    assert "clock" not in root


def test_aligning_devices_can_be_switched(client: httpx.Client):
    assert client.put("/api/time/align", json={"enabled": True}).raise_for_status().json() == {"enabled": True}
    assert client.get("/api/time").raise_for_status().json()["align"] == {"enabled": True}
    assert client.put("/api/time/align", json={"enabled": False}).raise_for_status().json() == {"enabled": False}


def test_the_fleet_lists_the_connected_devices(client: httpx.Client, device_id: str):
    devices = client.get("/api/fleet").raise_for_status().json()["devices"]
    entry = next(item for item in devices if item["id"] == device_id)
    assert entry["connected"] is True
    assert entry["channels"]["total"] >= 1
    assert entry["operationMode"]
    assert entry["system"] is None  # a reference device has no System channel
    assert entry["time"]["sync"]["locked"] is True
