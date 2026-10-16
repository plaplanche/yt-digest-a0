"""Extractors and track choice (spec 5.2): a video's duration and subtitle tracks."""

import json
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Any, Literal, Protocol, Self

import yt_dlp  # type: ignore[import-untyped]
from yt_dlp.utils import DownloadError  # type: ignore[import-untyped]

Source = Literal["manual", "auto"]
Failure = Literal["unavailable", "blocked"]

DEFAULT_DELAY = "2-5"
TRACK_FILE = re.compile(r"^(?P<lang>.+)\.(?P<source>manual|auto)\.vtt$")
BOT_CHECK = "not a bot"


@dataclass(frozen=True)
class Track:
    """One subtitle track: its language, whether it is manual or auto, its VTT text."""

    lang: str
    source: Source
    vtt: str


@dataclass(frozen=True)
class Video:
    """What an extractor found: the duration in seconds and the subtitle tracks."""

    duration: float
    tracks: tuple[Track, ...]


class Extractor(Protocol):
    def extract(self, video_id: str, langs: Sequence[str]) -> Failure | Video:
        """The video, or why it cannot be read; tracks outside `langs` may be absent."""
        ...


def choose_track(tracks: Sequence[Track], langs: Sequence[str]) -> Track | None:
    """The first manual track in the order of `langs`, then the first auto track.

    None when no track matches: the status is then `no_transcript`.
    """
    for source in ("manual", "auto"):
        for lang in langs:
            for track in tracks:
                if track.source == source and track.lang == lang:
                    return track
    return None


class FakeExtractor:
    """Reads `<directory>/<video_id>/`: `meta.json` and `<lang>.<manual|auto>.vtt`."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def extract(self, video_id: str, langs: Sequence[str]) -> Failure | Video:
        video_dir = self.directory / video_id
        if not video_dir.is_dir():
            return "unavailable"
        meta = json.loads((video_dir / "meta.json").read_text(encoding="utf-8"))
        status = meta.get("status")
        if status == "unavailable":
            return "unavailable"
        if status == "blocked":
            return "blocked"
        tracks = []
        for path in sorted(video_dir.iterdir()):
            match = TRACK_FILE.match(path.name)
            if match and path.is_file():
                source: Source = "manual" if match["source"] == "manual" else "auto"
                tracks.append(
                    Track(match["lang"], source, path.read_text(encoding="utf-8"))
                )
        return Video(float(meta["duration"]), tuple(tracks))


class Response(Protocol):
    def read(self) -> bytes: ...


class YoutubeDL(Protocol):
    """The part of `yt_dlp.YoutubeDL` the extractor uses."""

    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> object: ...

    def extract_info(self, url: str, download: bool) -> dict[str, Any] | None: ...

    def urlopen(self, url: str) -> Response: ...


class SilentLogger:
    """Swallows yt-dlp's messages, so that stdout holds only the result."""

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        pass


def ydl_options() -> dict[str, Any]:
    """The yt-dlp options of 5.2 (no cookie option), plus a silent logger."""
    return {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt",
        "logger": SilentLogger(),
    }


def map_error(error: DownloadError) -> Failure:
    """A bot check is `blocked`; any other yt-dlp error (private, age-restricted,
    removed...) is `unavailable`."""
    return "blocked" if BOT_CHECK in str(error).lower() else "unavailable"


def parse_delay(value: str) -> tuple[float, float]:
    """`YT_DELAY_SECONDS`: `<min>-<max>` or a single number of seconds."""
    low, _, high = value.partition("-")
    bounds = (float(low), float(high or low))
    if not 0 <= bounds[0] <= bounds[1]:
        raise ValueError(f"invalid YT_DELAY_SECONDS: {value!r}")
    return bounds


class YtDlpExtractor:
    """yt-dlp as a library, waiting a random delay before each YouTube request."""

    def __init__(
        self,
        delay: tuple[float, float],
        ydl_factory: Callable[[dict[str, Any]], YoutubeDL] = yt_dlp.YoutubeDL,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.delay = delay
        self.ydl_factory = ydl_factory
        self.sleep = sleep

    def _wait(self) -> None:
        self.sleep(random.uniform(*self.delay))

    def extract(self, video_id: str, langs: Sequence[str]) -> Failure | Video:
        """Only the VTT tracks in `langs` are downloaded."""
        try:
            with self.ydl_factory(ydl_options()) as ydl:
                self._wait()
                info = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}", download=False
                )
                if info is None:
                    return "unavailable"
                tracks = []
                sources: tuple[tuple[Source, str], ...] = (
                    ("manual", "subtitles"),
                    ("auto", "automatic_captions"),
                )
                for source, key in sources:
                    available = info.get(key) or {}
                    for lang in langs:
                        url = next(
                            (
                                entry["url"]
                                for entry in available.get(lang) or []
                                if entry.get("ext") == "vtt" and entry.get("url")
                            ),
                            None,
                        )
                        if url is not None:
                            self._wait()
                            vtt = ydl.urlopen(url).read().decode("utf-8")
                            tracks.append(Track(lang, source, vtt))
        except DownloadError as error:
            return map_error(error)
        return Video(float(info.get("duration") or 0), tuple(tracks))


def extractor_from_env(environ: Mapping[str, str]) -> Extractor:
    """The fake extractor when `FETCHER_FAKE_YTDLP=1` (no delay), else yt-dlp."""
    if environ.get("FETCHER_FAKE_YTDLP") == "1":
        directory = environ.get("FAKE_YTDLP_DIR")
        if not directory:
            raise ValueError("FAKE_YTDLP_DIR is required when FETCHER_FAKE_YTDLP=1")
        return FakeExtractor(Path(directory))
    return YtDlpExtractor(parse_delay(environ.get("YT_DELAY_SECONDS", DEFAULT_DELAY)))
