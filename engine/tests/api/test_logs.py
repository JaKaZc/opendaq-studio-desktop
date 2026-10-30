"""The log the Logs page reads: what openDAQ Studio and the SDK said, and the
levels each one logs at."""

from __future__ import annotations

import httpx

#: The log levels the API accepts.
LEVELS = ("trace", "debug", "info", "warning", "error", "critical")


class TestEndpoints:
    def test_both_streams_are_returned_with_the_current_levels(self, client: httpx.Client) -> None:
        payload = client.get("/api/system/logs", params={"level": "trace"}).raise_for_status().json()
        assert payload["captured"] > 0
        assert payload["viewerLevel"] in LEVELS
        assert payload["sdkLevel"] in LEVELS
        assert {entry["source"] for entry in payload["entries"]} <= {"viewer", "sdk"}

    def test_the_viewer_level_changes_at_once_and_the_sdk_level_waits(self, client: httpx.Client) -> None:
        try:
            result = (
                client.put("/api/system/logs/level", json={"viewer": "debug", "sdk": "debug"})
                .raise_for_status()
                .json()
            )
            assert result["viewerLevel"] == "debug"
            assert result["sdkLevel"] == "debug"
            # openDAQ fixes a component's level when it is created, so this one
            # only takes effect on the next start.
            assert result["restartRequired"] is True
        finally:
            client.put("/api/system/logs/level", json={"viewer": "info", "sdk": "info"})

    def test_an_unknown_level_is_refused(self, client: httpx.Client) -> None:
        response = client.put("/api/system/logs/level", json={"viewer": "loud"})
        assert response.status_code == 400
        assert "loud" in response.json()["message"]
