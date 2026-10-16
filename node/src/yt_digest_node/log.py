"""Structured logging: one JSON line per event on stderr (contracts/log-event)."""

import sys
from datetime import UTC, datetime

from yt_digest_node.contracts.log_event import LogEvent, LogEventName

SET_BY_THE_LOGGER = {"ts", "service"}


def emit(event: LogEventName | str, level: str = "info", **fields: object) -> None:
    """Writes one log line, validated against the generated model.

    `fields` are the other fields of a log line: `request_id`, `video_id` and `attrs`
    (an empty object when absent). An event outside the catalogue, an unknown field or
    an invalid value raises `ValueError`.
    """
    overridden = SET_BY_THE_LOGGER & fields.keys()
    if overridden:
        raise ValueError(f"set by the logger: {', '.join(sorted(overridden))}")
    ts = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    line = LogEvent.model_validate(
        {
            "attrs": {},
            **fields,
            "ts": ts,
            "level": level,
            "service": "node",
            "event": event,
        }
    )
    print(line.model_dump_json(exclude_unset=True), file=sys.stderr, flush=True)
