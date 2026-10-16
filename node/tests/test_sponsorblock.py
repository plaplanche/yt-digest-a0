import json
import socket
import threading
import urllib.parse
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from yt_digest_node.sponsorblock import (
    SponsorBlockResult,
    fetch_segments,
    skip_segments_url,
    sponsor_ratio,
)

VIDEO_ID = "dQw4w9WgXcQ"


class FakeSponsorBlock(HTTPServer):
    """A local SponsorBlock answering every request with `status` and `body`."""

    status = 200
    body = b"[]"
    paths: list[str]


class Handler(BaseHTTPRequestHandler):
    server: FakeSponsorBlock

    def do_GET(self) -> None:
        self.server.paths.append(self.path)
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.server.body)))
        self.end_headers()
        self.wfile.write(self.server.body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def server() -> Iterator[FakeSponsorBlock]:
    fake = FakeSponsorBlock(("127.0.0.1", 0), Handler)
    fake.paths = []
    thread = threading.Thread(target=fake.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    yield fake
    fake.shutdown()
    fake.server_close()
    thread.join()


def base_url(server: FakeSponsorBlock) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}"


def logged(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 1
    line: dict[str, Any] = json.loads(lines[0])
    assert line["event"] == "sponsorblock.call"
    assert line["video_id"] == VIDEO_ID
    assert isinstance(line["attrs"].pop("duration_ms"), int)
    return line


def test_the_url_carries_the_video_id_and_the_encoded_categories() -> None:
    url = skip_segments_url("https://sb.example/", VIDEO_ID)
    assert url == (
        "https://sb.example/api/skipSegments?videoID=dQw4w9WgXcQ"
        "&categories=%5B%22sponsor%22%2C%22selfpromo%22%2C%22interaction%22%5D"
    )
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert json.loads(query["categories"][0]) == [
        "sponsor",
        "selfpromo",
        "interaction",
    ]


def test_200_gives_the_segments(
    server: FakeSponsorBlock, capsys: pytest.CaptureFixture[str]
) -> None:
    server.body = json.dumps(
        [
            {"segment": [1.5, 10], "category": "sponsor", "UUID": "x"},
            {"segment": [30, 42.25], "category": "selfpromo"},
        ]
    ).encode()
    result = fetch_segments(VIDEO_ID, base_url(server), request_id="r1")
    assert result == SponsorBlockResult(((1.5, 10.0), (30.0, 42.25)), "ok")
    assert server.paths == [skip_segments_url("", VIDEO_ID)]
    line = logged(capsys)
    assert line["request_id"] == "r1"
    assert line["attrs"] == {"status": 200, "segments": 2}


def test_404_gives_no_segments_and_none(
    server: FakeSponsorBlock, capsys: pytest.CaptureFixture[str]
) -> None:
    server.status, server.body = 404, b"Not Found"
    result = fetch_segments(VIDEO_ID, base_url(server))
    assert result == SponsorBlockResult((), "none")
    line = logged(capsys)
    assert "request_id" not in line
    assert line["attrs"] == {"status": 404, "segments": 0}


def test_500_gives_no_segments_and_error(
    server: FakeSponsorBlock, capsys: pytest.CaptureFixture[str]
) -> None:
    server.status, server.body = 500, b"oops"
    assert fetch_segments(VIDEO_ID, base_url(server)) == SponsorBlockResult((), "error")
    assert logged(capsys)["attrs"] == {"status": 500, "segments": 0}


@pytest.mark.parametrize(
    "body", [b"not json", b"{}", b'[{"segment": [1]}]', b'[{"category": "x"}]']
)
def test_a_200_body_of_the_wrong_shape_is_an_error(
    server: FakeSponsorBlock, capsys: pytest.CaptureFixture[str], body: bytes
) -> None:
    server.body = body
    assert fetch_segments(VIDEO_ID, base_url(server)) == SponsorBlockResult((), "error")
    assert logged(capsys)["attrs"] == {"status": 200, "segments": 0}


def test_a_refused_connection_gives_no_segments_and_status_0(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    result = fetch_segments(VIDEO_ID, f"http://127.0.0.1:{port}")
    assert result == SponsorBlockResult((), "error")
    assert logged(capsys)["attrs"] == {"status": 0, "segments": 0}


# sponsor_ratio


def test_no_segment_gives_0() -> None:
    assert sponsor_ratio([], 100.0) == 0.0


def test_overlapping_segments_count_once() -> None:
    assert sponsor_ratio([(10.0, 30.0), (20.0, 40.0), (25.0, 35.0)], 100.0) == 0.3


def test_touching_and_disjoint_segments_add_up() -> None:
    assert sponsor_ratio([(50.0, 60.0), (0.0, 10.0), (10.0, 20.0)], 100.0) == 0.3


def test_segments_are_clipped_to_the_duration() -> None:
    assert sponsor_ratio([(90.0, 150.0)], 100.0) == 0.1
    assert sponsor_ratio([(-5.0, 5.0), (120.0, 130.0)], 100.0) == 0.05
    assert sponsor_ratio([(0.0, 500.0)], 100.0) == 1.0


def test_the_ratio_is_rounded_to_3_decimals() -> None:
    assert sponsor_ratio([(0.0, 1.0)], 3.0) == 0.333
    assert sponsor_ratio([(0.0, 2.0)], 3.0) == 0.667
