"""SponsorBlock (spec 5.3): the segments of a video and its `sponsor_ratio`."""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from yt_digest_node.contracts.log_event import LogEventName
from yt_digest_node.log import emit

CATEGORIES = ["sponsor", "selfpromo", "interaction"]
TIMEOUT_SECONDS = 10.0

Segment = tuple[float, float]
State = Literal["ok", "none", "error"]


@dataclass(frozen=True)
class SponsorBlockResult:
    """The segments (start, end) in seconds and the state of the call."""

    segments: tuple[Segment, ...]
    state: State


def skip_segments_url(base_url: str, video_id: str) -> str:
    """The `skipSegments` URL of a video, the category list URL-encoded."""
    query = urllib.parse.urlencode(
        {
            "videoID": video_id,
            "categories": json.dumps(CATEGORIES, separators=(",", ":")),
        }
    )
    return f"{base_url.rstrip('/')}/api/skipSegments?{query}"


def _parse_segments(body: bytes) -> tuple[Segment, ...]:
    """The segments of a 200 body; raises `ValueError` on any other shape."""
    items = json.loads(body)
    if not isinstance(items, list):
        raise ValueError("not a JSON array")
    segments: list[Segment] = []
    for item in items:
        segment = item.get("segment") if isinstance(item, dict) else None
        if not (
            isinstance(segment, list)
            and len(segment) == 2
            and all(
                isinstance(bound, int | float) and not isinstance(bound, bool)
                for bound in segment
            )
        ):
            raise ValueError("an item without a valid segment")
        segments.append((float(segment[0]), float(segment[1])))
    return tuple(segments)


def fetch_segments(
    video_id: str,
    base_url: str,
    request_id: str | None = None,
    timeout: float = TIMEOUT_SECONDS,
) -> SponsorBlockResult:
    """Calls SponsorBlock and logs `sponsorblock.call`; never raises.

    200: the segments (`ok`). 404: no segments (`none`). Any other status, a body that
    is not an array of items with a `segment`, or a network error: no segments
    (`error`), with status 0 in the log line for a network error.
    """
    started = time.monotonic()
    status = 0
    result = SponsorBlockResult((), "error")
    try:
        with urllib.request.urlopen(
            skip_segments_url(base_url, video_id), timeout=timeout
        ) as response:
            status = response.status
            body = response.read()
        if status == 200:
            result = SponsorBlockResult(_parse_segments(body), "ok")
    except urllib.error.HTTPError as error:
        status = error.code
        if status == 404:
            result = SponsorBlockResult((), "none")
    except (OSError, ValueError):
        pass
    ids = {"video_id": video_id}
    if request_id is not None:
        ids["request_id"] = request_id
    emit(
        LogEventName.SPONSORBLOCK_CALL,
        attrs={
            "status": status,
            "segments": len(result.segments),
            "duration_ms": round((time.monotonic() - started) * 1000),
        },
        **ids,
    )
    return result


def sponsor_ratio(segments: Sequence[Segment], duration: float) -> float:
    """Length of the union of the segments clipped to [0, duration], over duration.

    Rounded to 3 decimals; 0 when there is no segment or the duration is not positive.
    """
    if duration <= 0:
        return 0.0
    clipped = sorted(
        (max(start, 0.0), min(end, duration))
        for start, end in segments
        if min(end, duration) > max(start, 0.0)
    )
    covered = 0.0
    current_start: float | None = None
    current_end = 0.0
    for start, end in clipped:
        if current_start is None or start > current_end:
            if current_start is not None:
                covered += current_end - current_start
            current_start, current_end = start, end
        else:
            current_end = max(current_end, end)
    if current_start is not None:
        covered += current_end - current_start
    return round(covered / duration, 3)
