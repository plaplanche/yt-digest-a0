"""End to end: the `yt-digest-node transcript` command run as a subprocess, with the
fake extractor and a local SponsorBlock."""

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeSponsorBlock, base_url

import yt_digest_node
from yt_digest_node.contracts.log_event import LogEvent
from yt_digest_node.contracts.transcript_result import TranscriptResult

COMMAND = Path(sys.executable).parent / "yt-digest-node"
FIXTURES = Path(__file__).parent / "fixtures" / "fake_ytdlp"
CONFIG = (
    "TRANSCRIPT_LANGS",
    "MAX_WORDS",
    "PAGE_WORDS",
    "SPONSORBLOCK_URL",
    "FETCHER_FAKE_YTDLP",
    "FAKE_YTDLP_DIR",
    "YT_DELAY_SECONDS",
)
# Words of the fixture tracks, none of which may reach a log line.
TRANSCRIPT_WORDS = ("Bonjour", "bienvenue", "sponsorisée", "Acme", "commence", "Hello")


@dataclass
class Run:
    code: int
    stdout: str
    logs: list[dict[str, Any]]
    stderr: str


def run(sponsorblock: FakeSponsorBlock, *args: str, **env: str) -> Run:
    environ = {key: value for key, value in os.environ.items() if key not in CONFIG}
    environ |= {
        "FETCHER_FAKE_YTDLP": "1",
        "FAKE_YTDLP_DIR": str(FIXTURES),
        "SPONSORBLOCK_URL": base_url(sponsorblock),
    }
    environ |= env
    done = subprocess.run(
        [str(COMMAND), *args], env=environ, capture_output=True, text=True, timeout=60
    )
    logs = []
    if done.returncode == 0:
        for line in done.stderr.splitlines():
            LogEvent.model_validate_json(line)
            logs.append(json.loads(line))
    return Run(done.returncode, done.stdout, logs, done.stderr)


def result_of(done: Run) -> dict[str, Any]:
    assert done.code == 0
    TranscriptResult.model_validate_json(done.stdout)
    result: dict[str, Any] = json.loads(done.stdout)
    return result


def fetch_attrs(done: Run, request_id: str | None = None) -> dict[str, Any]:
    """Checks the log lines of a run and returns the `fetch.transcript` attributes."""
    first, *_, last = done.logs
    assert first["event"] == "service.started"
    assert first["attrs"] == {"version": yt_digest_node.__version__}
    assert last["event"] == "fetch.transcript"
    assert [line["event"] for line in done.logs].count("fetch.transcript") == 1
    assert last["video_id"] == json.loads(done.stdout)["video_id"]
    assert last.get("request_id") == request_id
    attrs: dict[str, Any] = last["attrs"]
    assert isinstance(attrs.pop("duration_ms"), int)
    for word in TRANSCRIPT_WORDS:
        assert word not in done.stderr
    return attrs


def sponsorblock_calls(done: Run) -> list[dict[str, Any]]:
    return [line for line in done.logs if line["event"] == "sponsorblock.call"]


def test_ok_with_sponsor_cuts(server: FakeSponsorBlock) -> None:
    server.body = json.dumps([{"segment": [9, 21], "category": "sponsor"}]).encode()
    done = run(server, "transcript", "sponsorVid1", "--request-id", "req-1")
    assert result_of(done) == {
        "video_id": "sponsorVid1",
        "status": "ok",
        "lang": "fr",
        "source": "manual",
        "word_count": 10,
        "truncated": False,
        "sponsor_ratio": 0.12,
        "pages": ["Bonjour à tous bienvenue dans la vidéo.\n\nOn commence maintenant."],
    }
    assert fetch_attrs(done, "req-1") == {
        "outcome": "ok",
        "source": "manual",
        "words": 10,
        "pages": 1,
        "sponsor_ratio": 0.12,
        "sponsorblock": "ok",
    }
    (call,) = sponsorblock_calls(done)
    assert call["request_id"] == "req-1"
    assert call["attrs"]["segments"] == 1


def test_truncation_and_pages_follow_the_environment(server: FakeSponsorBlock) -> None:
    server.status = 404
    done = run(server, "transcript", "sponsorVid1", MAX_WORDS="6", PAGE_WORDS="3")
    result = result_of(done)
    assert result["truncated"] is True
    assert result["word_count"] == 6
    assert result["sponsor_ratio"] == 0
    assert result["pages"] == ["Bonjour à tous\n\n[…]", "On commence maintenant."]
    attrs = fetch_attrs(done)
    assert (attrs["pages"], attrs["sponsorblock"]) == (2, "none")


def test_a_sponsorblock_error_gives_a_null_ratio(server: FakeSponsorBlock) -> None:
    server.status = 500
    done = run(server, "transcript", "sponsorVid1")
    result = result_of(done)
    assert result["status"] == "ok"
    assert result["sponsor_ratio"] is None
    assert result["word_count"] == 16
    attrs = fetch_attrs(done)
    assert (attrs["sponsor_ratio"], attrs["sponsorblock"]) == (None, "error")


def test_langs_come_from_the_option_then_the_environment(
    server: FakeSponsorBlock,
) -> None:
    by_option = run(server, "transcript", "sponsorVid1", "--langs", "de,en")
    by_env = run(server, "transcript", "sponsorVid1", TRANSCRIPT_LANGS="en")
    for done in (by_option, by_env):
        result = result_of(done)
        assert (result["lang"], result["source"]) == ("en", "auto")
        assert result["pages"] == ["Hello everyone"]
        assert fetch_attrs(done)["source"] == "auto"


def no_result(video_id: str, status: str) -> dict[str, Any]:
    return {
        "video_id": video_id,
        "status": status,
        "lang": None,
        "source": None,
        "word_count": 0,
        "truncated": False,
        "sponsor_ratio": None,
        "pages": [],
    }


@pytest.mark.parametrize(
    ("video_id", "status"),
    [
        ("germanOnly1", "no_transcript"),
        ("unavailVid1", "unavailable"),
        ("missingVid1", "unavailable"),
        ("blockedVid1", "blocked"),
    ],
)
def test_a_video_without_a_transcript(
    server: FakeSponsorBlock, video_id: str, status: str
) -> None:
    done = run(server, "transcript", video_id, "--request-id", "req-2")
    assert result_of(done) == no_result(video_id, status)
    assert fetch_attrs(done, "req-2") == {
        "outcome": status,
        "source": None,
        "words": 0,
        "pages": 0,
        "sponsor_ratio": None,
        "sponsorblock": None,
    }
    assert sponsorblock_calls(done) == []
    assert server.paths == []


@pytest.mark.parametrize(
    "args",
    [
        ("transcript", "short"),
        ("transcript", "sponsorVid1!"),
        ("transcript", "sponsorVid1", "--langs", ","),
        ("transcript",),
        (),
    ],
)
def test_a_bad_argument_exits_2_without_a_result(
    server: FakeSponsorBlock, args: tuple[str, ...]
) -> None:
    done = run(server, *args)
    assert (done.code, done.stdout) == (2, "")
    assert server.paths == []


@pytest.mark.parametrize(
    "env",
    [{"MAX_WORDS": "0"}, {"PAGE_WORDS": "many"}, {"FAKE_YTDLP_DIR": ""}],
)
def test_an_invalid_configuration_exits_2_without_a_result(
    server: FakeSponsorBlock, env: dict[str, str]
) -> None:
    done = run(server, "transcript", "sponsorVid1", **env)
    assert (done.code, done.stdout) == (2, "")
