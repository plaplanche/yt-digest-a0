import json
import re
from typing import Any

import pytest

from yt_digest_node.contracts.log_event import LogEventName
from yt_digest_node.log import emit


def test_emit_writes_one_json_line_to_stderr(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emit(
        LogEventName.SPONSORBLOCK_CALL,
        request_id="r1",
        video_id="dQw4w9WgXcQ",
        attrs={"status": 200, "segments": 2, "duration_ms": 31},
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    lines = captured.err.splitlines()
    assert len(lines) == 1
    line = json.loads(lines[0])
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", line.pop("ts"))
    assert line == {
        "level": "info",
        "service": "node",
        "event": "sponsorblock.call",
        "request_id": "r1",
        "video_id": "dQw4w9WgXcQ",
        "attrs": {"status": 200, "segments": 2, "duration_ms": 31},
    }


def test_emit_accepts_the_event_name_and_a_level(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emit("service.started", level="debug")
    line = json.loads(capsys.readouterr().err)
    assert (line["event"], line["level"], line["attrs"]) == (
        "service.started",
        "debug",
        {},
    )
    assert "request_id" not in line


def test_a_lot_2_event_is_accepted(capsys: pytest.CaptureFixture[str]) -> None:
    emit(
        "worker.call",
        attrs={"endpoint": "claim", "status": 200, "duration_ms": 12},
    )
    emit(LogEventName.JOB_CLAIMED, video_id="dQw4w9WgXcQ")
    events = [
        json.loads(line)["event"] for line in capsys.readouterr().err.splitlines()
    ]
    assert events == ["worker.call", "job.claimed"]


def test_an_event_outside_the_catalogue_raises(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(ValueError):
        emit("video.deleted")
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize(
    "fields",
    [{"extra": 1}, {"service": "worker"}, {"ts": "2026-10-16T12:00:00.000Z"}],
)
def test_an_unknown_or_reserved_field_raises(fields: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        emit("service.started", **fields)


def test_a_bad_level_raises() -> None:
    with pytest.raises(ValueError):
        emit("service.started", level="fatal")
