from typing import Any

import pytest

from yt_digest_node.contracts.log_event import LogEvent, LogEventName
from yt_digest_node.contracts.transcript_result import TranscriptResult


def transcript_result(**changes: object) -> dict[str, Any]:
    result: dict[str, Any] = {
        "video_id": "dQw4w9WgXcQ",
        "status": "ok",
        "lang": "fr",
        "source": "manual",
        "word_count": 3,
        "truncated": False,
        "sponsor_ratio": 0.125,
        "pages": ["un deux trois"],
    }
    return result | changes


def log_line(**changes: object) -> dict[str, Any]:
    line: dict[str, Any] = {
        "ts": "2026-10-16T12:00:00.000Z",
        "level": "info",
        "service": "node",
        "event": "service.started",
        "attrs": {"version": "0.1.0"},
    }
    return line | changes


def test_a_valid_transcript_result_is_accepted() -> None:
    assert (
        TranscriptResult.model_validate(transcript_result()).video_id == "dQw4w9WgXcQ"
    )


def test_a_failed_transcript_result_is_accepted() -> None:
    failed = transcript_result(
        status="unavailable",
        lang=None,
        source=None,
        word_count=0,
        sponsor_ratio=None,
        pages=[],
    )
    assert TranscriptResult.model_validate(failed).status == "unavailable"


@pytest.mark.parametrize(
    "result",
    [
        transcript_result(extra="field"),
        transcript_result(video_id="too-short"),
        transcript_result(video_id="dQw4w9WgXcQ!"),
        transcript_result(status="done"),
        transcript_result(source="human"),
        transcript_result(word_count=-1),
        transcript_result(word_count="3"),
        transcript_result(truncated=0),
        transcript_result(sponsor_ratio=1.5),
        transcript_result(pages=[1]),
        {k: v for k, v in transcript_result().items() if k != "lang"},
    ],
)
def test_an_invalid_transcript_result_is_rejected(result: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        TranscriptResult.model_validate(result)


def test_a_valid_log_line_is_accepted() -> None:
    line = LogEvent.model_validate(log_line(request_id="r1", video_id="dQw4w9WgXcQ"))
    assert line.event is LogEventName.SERVICE_STARTED


def test_the_catalogue_is_a_str_enum() -> None:
    assert [e.value for e in LogEventName] == [
        "service.started",
        "fetch.transcript",
        "sponsorblock.call",
        "node.enrolled",
        "node.revoked",
        "node.heartbeat",
        "job.enqueued",
        "job.claimed",
        "job.completed",
        "job.released",
        "job.lease_expired",
        "job.stale_result",
        "job.validation_failed",
        "auth.bearer.rejected",
        "auth.client.registered",
        "auth.oauth.completed",
        "auth.oauth.denied",
        "auth.token.issued",
        "auth.refresh.reuse_detected",
        "auth.origin.rejected",
        "mcp.tool.call",
        "worker.call",
    ]
    assert LogEventName("fetch.transcript") is LogEventName.FETCH_TRANSCRIPT
    assert LogEventName("job.claimed") is LogEventName.JOB_CLAIMED


@pytest.mark.parametrize(
    "line",
    [
        log_line(event="video.deleted"),
        log_line(level="fatal"),
        log_line(service="cron"),
        log_line(ts="2026-10-16T12:00:00Z"),
        log_line(request_id=None),
        log_line(extra="field"),
        log_line(attrs=[]),
    ],
)
def test_an_invalid_log_line_is_rejected(line: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        LogEvent.model_validate(line)
