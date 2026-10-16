"""The transcript pipeline (spec 5): from a video id to a transcript result."""

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from yt_digest_node.cleaning import paragraphs, parse_vtt
from yt_digest_node.contracts.log_event import LogEventName
from yt_digest_node.contracts.transcript_result import TranscriptResult
from yt_digest_node.extractor import Extractor, choose_track
from yt_digest_node.log import emit
from yt_digest_node.pages import count_words, paginate, truncate
from yt_digest_node.sponsorblock import fetch_segments, sponsor_ratio


@dataclass(frozen=True)
class Config:
    """The configuration of 5.1 the pipeline uses (the extractor is built apart)."""

    langs: tuple[str, ...] = ("fr", "en")
    max_words: int = 60000
    page_words: int = 12000
    sponsorblock_url: str = "https://sponsor.ajay.app"


def parse_langs(value: str) -> tuple[str, ...]:
    """A comma-separated language list; raises `ValueError` when it is empty."""
    langs = tuple(lang.strip() for lang in value.split(",") if lang.strip())
    if not langs:
        raise ValueError(f"no language in {value!r}")
    return langs


def _positive(environ: Mapping[str, str], name: str, default: int) -> int:
    raw = environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value < 1:
        raise ValueError(f"{name} must be a positive integer, got {raw!r}")
    return value


def config_from_env(environ: Mapping[str, str]) -> Config:
    """The configuration of 5.1; raises `ValueError` on an invalid value."""
    default = Config()
    return Config(
        langs=parse_langs(environ.get("TRANSCRIPT_LANGS", ",".join(default.langs))),
        max_words=_positive(environ, "MAX_WORDS", default.max_words),
        page_words=_positive(environ, "PAGE_WORDS", default.page_words),
        sponsorblock_url=environ.get("SPONSORBLOCK_URL", default.sponsorblock_url),
    )


def _without_transcript(
    video_id: str, status: Literal["no_transcript", "unavailable", "blocked"]
) -> TranscriptResult:
    return TranscriptResult(
        video_id=video_id,
        status=status,
        lang=None,
        source=None,
        word_count=0,
        truncated=False,
        sponsor_ratio=None,
        pages=[],
    )


def transcript(
    video_id: str,
    langs: Sequence[str],
    config: Config,
    extractor: Extractor,
    request_id: str | None = None,
) -> TranscriptResult:
    """Runs the pipeline and logs `fetch.transcript`.

    SponsorBlock is called only once a track was chosen.
    """
    started = time.monotonic()
    sponsorblock: str | None = None
    video = extractor.extract(video_id, langs)
    if isinstance(video, str):
        result = _without_transcript(video_id, video)
    else:
        result = _without_transcript(video_id, "no_transcript")
        track = choose_track(video.tracks, langs)
        if track is not None:
            sponsor = fetch_segments(video_id, config.sponsorblock_url, request_id)
            sponsorblock = sponsor.state
            text, truncated = truncate(
                paragraphs(parse_vtt(track.vtt), sponsor.segments), config.max_words
            )
            pages = paginate(text, config.page_words)
            result = TranscriptResult(
                video_id=video_id,
                status="ok",
                lang=track.lang,
                source=track.source,
                word_count=sum(count_words(page) for page in pages),
                truncated=truncated,
                sponsor_ratio=(
                    None
                    if sponsor.state == "error"
                    else sponsor_ratio(sponsor.segments, video.duration)
                ),
                pages=pages,
            )
    ids = {"video_id": video_id}
    if request_id is not None:
        ids["request_id"] = request_id
    emit(
        LogEventName.FETCH_TRANSCRIPT,
        attrs={
            "outcome": result.status,
            "source": result.source,
            "words": result.word_count,
            "pages": len(result.pages),
            "sponsor_ratio": result.sponsor_ratio,
            "sponsorblock": sponsorblock,
            "duration_ms": round((time.monotonic() - started) * 1000),
        },
        **ids,
    )
    return result
