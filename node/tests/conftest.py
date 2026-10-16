"""Shared fixtures: a local SponsorBlock server."""

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest


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
