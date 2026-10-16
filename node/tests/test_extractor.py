from pathlib import Path
from types import TracebackType
from typing import Any, Self

import pytest
from yt_dlp.utils import DownloadError  # type: ignore[import-untyped]

from yt_digest_node.extractor import (
    FakeExtractor,
    SilentLogger,
    Track,
    Video,
    YtDlpExtractor,
    choose_track,
    extractor_from_env,
    parse_delay,
)

FIXTURES = Path(__file__).parent / "fixtures" / "fake_ytdlp"
VIDEO_ID = "dQw4w9WgXcQ"
LANGS = ["fr", "en"]


def fake() -> FakeExtractor:
    return FakeExtractor(FIXTURES)


# Fake extractor


def test_a_missing_directory_is_unavailable() -> None:
    assert fake().extract("missingVid1", LANGS) == "unavailable"


def test_a_blocked_status_in_meta_is_blocked() -> None:
    assert fake().extract("blockedVid1", LANGS) == "blocked"


def test_an_unavailable_status_in_meta_is_unavailable() -> None:
    assert fake().extract("unavailVid1", LANGS) == "unavailable"


def test_the_fake_reads_the_duration_and_every_track_file() -> None:
    video = fake().extract("bothTracks1", LANGS)
    assert isinstance(video, Video)
    assert video.duration == 120.0
    assert sorted(video.tracks, key=lambda track: track.lang) == [
        Track("en", "manual", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello\n"),
        Track("fr", "auto", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nbonjour\n"),
    ]


def test_the_manual_english_track_wins_over_the_auto_french_one() -> None:
    video = fake().extract("bothTracks1", LANGS)
    assert isinstance(video, Video)
    assert choose_track(video.tracks, LANGS) == Track(
        "en", "manual", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello\n"
    )


def test_only_a_german_track_gives_no_transcript() -> None:
    video = fake().extract("germanOnly1", LANGS)
    assert isinstance(video, Video)
    assert video.duration == 60.5
    assert [track.lang for track in video.tracks] == ["de"]
    assert choose_track(video.tracks, LANGS) is None


# Track choice


def test_manual_tracks_follow_the_language_order() -> None:
    tracks = [Track("en", "manual", "en"), Track("fr", "manual", "fr")]
    assert choose_track(tracks, ["fr", "en"]) == Track("fr", "manual", "fr")
    assert choose_track(tracks, ["en", "fr"]) == Track("en", "manual", "en")


def test_auto_tracks_follow_the_language_order_when_no_manual_matches() -> None:
    tracks = [
        Track("de", "manual", "de"),
        Track("en", "auto", "en"),
        Track("fr", "auto", "fr"),
    ]
    assert choose_track(tracks, ["fr", "en"]) == Track("fr", "auto", "fr")


def test_no_track_at_all_gives_none() -> None:
    assert choose_track([], LANGS) is None


# yt-dlp extractor, with yt-dlp replaced by a stub


class StubResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def read(self) -> bytes:
        return self.body


class StubYoutubeDL:
    """Records its options and requests; answers with `info` or raises `error`."""

    def __init__(
        self,
        options: dict[str, Any],
        info: dict[str, Any] | None,
        error: str | None,
        calls: list[str],
    ) -> None:
        self.options = options
        self.info = info
        self.error = error
        self.calls = calls

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        pass

    def extract_info(self, url: str, download: bool) -> dict[str, Any] | None:
        assert download is False
        self.calls.append(f"extract {url}")
        if self.error is not None:
            raise DownloadError(self.error)
        return self.info

    def urlopen(self, url: str) -> StubResponse:
        self.calls.append(f"open {url}")
        return StubResponse(f"WEBVTT from {url}".encode())


class Stub:
    """A `ydl_factory` building `StubYoutubeDL`s, and a `sleep` recording delays."""

    def __init__(
        self, info: dict[str, Any] | None = None, error: str | None = None
    ) -> None:
        self.info = info
        self.error = error
        self.options: list[dict[str, Any]] = []
        self.calls: list[str] = []

    def factory(self, options: dict[str, Any]) -> StubYoutubeDL:
        self.options.append(options)
        return StubYoutubeDL(options, self.info, self.error, self.calls)

    def sleep(self, seconds: float) -> None:
        self.calls.append(f"sleep {seconds}")

    def extractor(self, delay: tuple[float, float] = (0.0, 0.0)) -> YtDlpExtractor:
        return YtDlpExtractor(delay, ydl_factory=self.factory, sleep=self.sleep)


INFO = {
    "duration": 212,
    "subtitles": {
        "en": [
            {"ext": "srv1", "url": "https://yt.example/en.srv1"},
            {"ext": "vtt", "url": "https://yt.example/en.vtt"},
        ],
        "de": [{"ext": "vtt", "url": "https://yt.example/de.vtt"}],
    },
    "automatic_captions": {
        "fr": [{"ext": "vtt", "url": "https://yt.example/fr-auto.vtt"}],
        "it": [{"ext": "vtt", "url": "https://yt.example/it-auto.vtt"}],
    },
}


def test_yt_dlp_gets_the_options_of_the_spec_and_no_cookies() -> None:
    stub = Stub(INFO)
    stub.extractor().extract(VIDEO_ID, LANGS)
    [options] = stub.options
    assert isinstance(options.pop("logger"), SilentLogger)
    assert options == {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt",
    }


def test_yt_dlp_tracks_in_the_languages_are_downloaded_after_a_delay_each() -> None:
    stub = Stub(INFO)
    video = stub.extractor((2.0, 2.0)).extract(VIDEO_ID, LANGS)
    assert video == Video(
        212.0,
        (
            Track("en", "manual", "WEBVTT from https://yt.example/en.vtt"),
            Track("fr", "auto", "WEBVTT from https://yt.example/fr-auto.vtt"),
        ),
    )
    assert stub.calls == [
        "sleep 2.0",
        f"extract https://www.youtube.com/watch?v={VIDEO_ID}",
        "sleep 2.0",
        "open https://yt.example/en.vtt",
        "sleep 2.0",
        "open https://yt.example/fr-auto.vtt",
    ]


def test_the_delay_is_drawn_in_its_range() -> None:
    stub = Stub({"duration": 10})
    stub.extractor((2.0, 5.0)).extract(VIDEO_ID, LANGS)
    [sleep] = [call for call in stub.calls if call.startswith("sleep")]
    assert 2.0 <= float(sleep.split()[1]) <= 5.0


def test_a_video_without_subtitles_has_no_tracks() -> None:
    assert Stub({"duration": None}).extractor().extract(VIDEO_ID, LANGS) == Video(
        0.0, ()
    )


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted"
        " access to this video",
        "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be"
        " inappropriate for some users.",
        "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed"
        " by the uploader",
    ],
)
def test_private_age_restricted_or_removed_is_unavailable(message: str) -> None:
    assert Stub(error=message).extractor().extract(VIDEO_ID, LANGS) == "unavailable"


def test_a_bot_check_is_blocked() -> None:
    message = (
        "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot."
        " Use --cookies-from-browser or --cookies for the authentication."
    )
    assert Stub(error=message).extractor().extract(VIDEO_ID, LANGS) == "blocked"


# Configuration


def test_the_fake_extractor_is_selected_by_the_environment() -> None:
    extractor = extractor_from_env(
        {"FETCHER_FAKE_YTDLP": "1", "FAKE_YTDLP_DIR": str(FIXTURES)}
    )
    assert isinstance(extractor, FakeExtractor)
    assert extractor.directory == FIXTURES


def test_the_fake_extractor_requires_its_directory() -> None:
    with pytest.raises(ValueError, match="FAKE_YTDLP_DIR"):
        extractor_from_env({"FETCHER_FAKE_YTDLP": "1"})


def test_yt_dlp_is_the_default_with_a_delay_of_2_to_5_seconds() -> None:
    extractor = extractor_from_env({})
    assert isinstance(extractor, YtDlpExtractor)
    assert extractor.delay == (2.0, 5.0)


def test_the_delay_comes_from_yt_delay_seconds() -> None:
    extractor = extractor_from_env({"YT_DELAY_SECONDS": "0.5-1"})
    assert isinstance(extractor, YtDlpExtractor)
    assert extractor.delay == (0.5, 1.0)


@pytest.mark.parametrize(
    ("value", "bounds"), [("2-5", (2.0, 5.0)), ("3", (3.0, 3.0)), ("0", (0.0, 0.0))]
)
def test_parse_delay(value: str, bounds: tuple[float, float]) -> None:
    assert parse_delay(value) == bounds


@pytest.mark.parametrize("value", ["5-2", "-1", "a-b", ""])
def test_parse_delay_rejects_a_bad_range(value: str) -> None:
    with pytest.raises(ValueError):
        parse_delay(value)
