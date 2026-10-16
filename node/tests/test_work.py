"""The daemon `yt-digest-node work` (spec lot 2, section 9), run as a subprocess against
a local fake Worker, with the fake extractor and a local SponsorBlock."""

import json
import os
import signal
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from conftest import FakeSponsorBlock, base_url
from test_cli import COMMAND, CONFIG, FIXTURES, TRANSCRIPT_WORDS

import yt_digest_node
from yt_digest_node.contracts.log_event import LogEvent
from yt_digest_node.contracts.node_heartbeat_request import NodeHeartbeatRequest
from yt_digest_node.contracts.node_release_request import NodeReleaseRequest
from yt_digest_node.contracts.node_result_request import NodeResultRequest
from yt_digest_node.extractor import FakeExtractor
from yt_digest_node.pipeline import Config, transcript
from yt_digest_node.work import (
    RETRY_DELAYS,
    CallFailed,
    Unauthorized,
    WorkerClient,
    settings_from_env,
)

TOKEN = "ytd_node_secret-token-never-logged-0123456789abc"
WORK_CONFIG = (
    *CONFIG,
    "WORKER_URL",
    "NODE_TOKEN",
    "CLAIM_BATCH",
    "POLL_SECONDS",
    "HEARTBEAT_SECONDS",
)


@dataclass
class Request:
    endpoint: str
    authorization: str | None
    body: dict[str, Any]


Reply = tuple[int, Any]


class FakeWorker(ThreadingHTTPServer):
    """Answers `/node/<endpoint>` with the next scripted reply of the endpoint, or a
    default one: an empty claim, and a `done` acknowledgement of the lease's job."""

    replies: dict[str, list[Reply]]
    requests: list[Request]
    leases: dict[str, str]
    before_reply: Callable[[Request], None] | None

    def script_jobs(self, *video_ids: str) -> None:
        jobs = []
        for index, video_id in enumerate(video_ids):
            lease_id = f"lease-{index:02d}-0123456789abcdef"
            self.leases[lease_id] = video_id
            jobs.append(
                {
                    "video_id": video_id,
                    "lease_id": lease_id,
                    "lease_expires_at": "2026-10-16T07:10:00.000Z",
                }
            )
        self.replies["claim"].append((200, {"jobs": jobs}))

    def default(self, request: Request) -> Reply:
        if request.endpoint == "heartbeat":
            body = {
                "node_id": "node-a",
                "state": "healthy",
                "hourly_budget": 60,
                "directive": "run",
            }
            return 200, body
        if request.endpoint == "claim":
            return 200, {"jobs": []}
        status = "queued" if request.endpoint == "release" else "done"
        video_id = self.leases[request.body["lease_id"]]
        return 200, {"video_id": video_id, "status": status}


class Handler(BaseHTTPRequestHandler):
    server: FakeWorker

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        request = Request(
            endpoint=self.path.removeprefix("/node/"),
            authorization=self.headers.get("Authorization"),
            body=json.loads(self.rfile.read(length)),
        )
        self.server.requests.append(request)
        if self.server.before_reply is not None:
            self.server.before_reply(request)
        scripted = self.server.replies.get(request.endpoint)
        status, body = scripted.pop(0) if scripted else self.server.default(request)
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def worker() -> Iterator[FakeWorker]:
    fake = FakeWorker(("127.0.0.1", 0), Handler)
    fake.replies = {"heartbeat": [], "claim": [], "result": [], "release": []}
    fake.requests = []
    fake.leases = {}
    fake.before_reply = None
    thread = threading.Thread(target=fake.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    yield fake
    fake.shutdown()
    fake.server_close()
    thread.join()


def worker_url(worker: FakeWorker) -> str:
    return f"http://127.0.0.1:{worker.server_address[1]}"


def environment(
    worker: FakeWorker, sponsorblock: FakeSponsorBlock, **env: str
) -> dict[str, str]:
    environ = {
        key: value for key, value in os.environ.items() if key not in WORK_CONFIG
    }
    environ |= {
        "FETCHER_FAKE_YTDLP": "1",
        "FAKE_YTDLP_DIR": str(FIXTURES),
        "SPONSORBLOCK_URL": base_url(sponsorblock),
        "WORKER_URL": worker_url(worker),
        "NODE_TOKEN": TOKEN,
    }
    return environ | env


@dataclass
class Run:
    code: int
    logs: list[dict[str, Any]]
    stdout: str
    stderr: str


def finished(process: "subprocess.Popen[str]") -> Run:
    stdout, stderr = process.communicate(timeout=60)
    return Run(process.returncode, logs_of(stderr), stdout, stderr)


def logs_of(stderr: str) -> list[dict[str, Any]]:
    """Checks that standard error holds only valid JSON log lines, without the token
    or transcript text, and returns them."""
    assert TOKEN not in stderr
    for word in TRANSCRIPT_WORDS:
        assert word not in stderr
    logs = []
    for line in stderr.splitlines():
        LogEvent.model_validate_json(line)
        logs.append(json.loads(line))
    if logs:
        assert logs[0]["event"] == "service.started"
        assert logs[0]["attrs"] == {"version": yt_digest_node.__version__}
    return logs


def start(environ: dict[str, str], *args: str) -> "subprocess.Popen[str]":
    return subprocess.Popen(
        [str(COMMAND), "work", *args],
        env=environ,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def work_once(worker: FakeWorker, sponsorblock: FakeSponsorBlock, **env: str) -> Run:
    return finished(start(environment(worker, sponsorblock, **env), "--once"))


def calls(done: Run) -> list[tuple[str, int]]:
    return [
        (line["attrs"]["endpoint"], line["attrs"]["status"])
        for line in done.logs
        if line["event"] == "worker.call"
    ]


def endpoints(worker: FakeWorker) -> list[str]:
    return [request.endpoint for request in worker.requests]


def bodies(worker: FakeWorker, endpoint: str) -> list[dict[str, Any]]:
    return [r.body for r in worker.requests if r.endpoint == endpoint]


def expected_ok(video_id: str, sponsorblock: FakeSponsorBlock) -> dict[str, Any]:
    """The pipeline's own result for a fixture video."""
    config = Config(sponsorblock_url=base_url(sponsorblock))
    result = transcript(video_id, config.langs, config, FakeExtractor(FIXTURES))
    return result.model_dump()


def test_once_heartbeats_claims_and_sends_one_result_per_job(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    server.status = 404
    worker.script_jobs("sponsorVid1", "germanOnly1", "unavailVid1", "noMetaVid01")
    done = work_once(worker, server)
    assert done.code == 0
    assert done.stdout == ""
    assert endpoints(worker) == ["heartbeat", "claim", *["result"] * 4]
    assert {request.authorization for request in worker.requests} == {f"Bearer {TOKEN}"}

    (heartbeat,) = bodies(worker, "heartbeat")
    NodeHeartbeatRequest.model_validate(heartbeat)
    assert heartbeat.keys() == {"version", "uptime_s", "jobs_in_progress"}
    assert heartbeat["version"] == yt_digest_node.__version__
    assert heartbeat["jobs_in_progress"] == 0
    assert bodies(worker, "claim") == [{"max_jobs": 3}]

    results = bodies(worker, "result")
    for body in results:
        NodeResultRequest.model_validate(body)
    assert [(body["lease_id"], body["outcome"]) for body in results] == [
        ("lease-00-0123456789abcdef", "ok"),
        ("lease-01-0123456789abcdef", "no_transcript"),
        ("lease-02-0123456789abcdef", "unavailable"),
        ("lease-03-0123456789abcdef", "error"),
    ]
    assert results[0]["transcript"] == expected_ok("sponsorVid1", server)
    assert results[0]["transcript"]["status"] == "ok"
    assert [body["transcript"] for body in results[1:]] == [None, None, None]

    assert calls(done) == [
        ("heartbeat", 200),
        ("claim", 200),
        *[("result", 200)] * 4,
    ]
    job_calls = [line for line in done.logs if line["event"] == "worker.call"][2:]
    assert [line["video_id"] for line in job_calls] == [
        "sponsorVid1",
        "germanOnly1",
        "unavailVid1",
        "noMetaVid01",
    ]
    fetches = [line for line in done.logs if line["event"] == "fetch.transcript"]
    assert [(line["video_id"], line["attrs"]["outcome"]) for line in fetches] == [
        ("sponsorVid1", "ok"),
        ("germanOnly1", "no_transcript"),
        ("unavailVid1", "unavailable"),
        ("noMetaVid01", "error"),
    ]


def test_claim_batch_sets_max_jobs(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    done = work_once(worker, server, CLAIM_BATCH="7")
    assert done.code == 0
    assert bodies(worker, "claim") == [{"max_jobs": 7}]
    assert endpoints(worker) == ["heartbeat", "claim"]


def test_a_503_on_result_is_retried_then_succeeds(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    worker.script_jobs("unavailVid1")
    worker.replies["result"].append((503, {"error": {"code": "x", "message": "x"}}))
    started = time.monotonic()
    done = work_once(worker, server)
    assert done.code == 0
    assert time.monotonic() - started >= RETRY_DELAYS[0]
    assert calls(done)[2:] == [("result", 503), ("result", 200)]
    first, second = bodies(worker, "result")
    assert first == second


def test_a_409_on_result_is_not_retried(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    worker.script_jobs("unavailVid1", "germanOnly1")
    stale = {"error": {"code": "stale_lease", "message": "stale"}}
    worker.replies["result"].append((409, stale))
    done = work_once(worker, server)
    assert done.code == 0
    assert calls(done)[2:] == [("result", 409), ("result", 200)]
    assert [body["outcome"] for body in bodies(worker, "result")] == [
        "unavailable",
        "no_transcript",
    ]


@pytest.mark.parametrize(
    ("endpoint", "reply"),
    [
        ("claim", (500, {"error": {"code": "x", "message": "x"}})),
        ("claim", (400, {"error": {"code": "invalid_request", "message": "x"}})),
        ("claim", (200, {"jobs": [{"video_id": "short"}]})),
        ("heartbeat", (503, {"error": {"code": "x", "message": "x"}})),
        ("heartbeat", (401, {"error": {"code": "unauthorized", "message": "x"}})),
    ],
)
def test_a_failed_heartbeat_or_claim_exits_1(
    worker: FakeWorker, server: FakeSponsorBlock, endpoint: str, reply: Reply
) -> None:
    worker.replies[endpoint].append(reply)
    done = work_once(worker, server)
    assert done.code == 1
    assert endpoints(worker)[-1] == endpoint
    assert calls(done)[-1] == (endpoint, reply[0])


def test_a_network_error_exits_1(server: FakeSponsorBlock) -> None:
    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
    environ = {
        key: value for key, value in os.environ.items() if key not in WORK_CONFIG
    }
    environ |= {
        "FETCHER_FAKE_YTDLP": "1",
        "FAKE_YTDLP_DIR": str(FIXTURES),
        "WORKER_URL": f"http://127.0.0.1:{port}",
        "NODE_TOKEN": TOKEN,
    }
    done = finished(start(environ, "--once"))
    assert done.code == 1
    assert calls(done) == [("heartbeat", 0)]


@pytest.mark.parametrize(
    ("env", "reason"),
    [
        ({"NODE_TOKEN": None}, "missing NODE_TOKEN"),
        ({"WORKER_URL": None}, "missing WORKER_URL"),
        ({"NODE_TOKEN": ""}, "missing NODE_TOKEN"),
        ({"CLAIM_BATCH": "11"}, "CLAIM_BATCH"),
        ({"POLL_SECONDS": "0"}, "POLL_SECONDS"),
        ({"HEARTBEAT_SECONDS": "soon"}, "HEARTBEAT_SECONDS"),
    ],
)
def test_a_missing_or_invalid_setting_exits_2_without_any_request(
    worker: FakeWorker,
    server: FakeSponsorBlock,
    env: dict[str, str | None],
    reason: str,
) -> None:
    environ = environment(worker, server)
    for name, value in env.items():
        if value is None:
            del environ[name]
        else:
            environ[name] = value
    process = start(environ, "--once")
    _, stderr = process.communicate(timeout=60)
    assert process.returncode == 2
    assert reason in stderr
    assert TOKEN not in stderr
    assert worker.requests == []


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_a_signal_finishes_the_job_in_progress_and_releases_the_others(
    worker: FakeWorker, server: FakeSponsorBlock, signum: signal.Signals
) -> None:
    worker.script_jobs("unavailVid1", "germanOnly1", "blockedVid1")
    processes: list[subprocess.Popen[str]] = []

    def signal_on_first_result(request: Request) -> None:
        if request.endpoint == "result":
            processes[0].send_signal(signum)
            time.sleep(0.3)

    worker.before_reply = signal_on_first_result
    processes.append(start(environment(worker, server)))
    done = finished(processes[0])
    assert done.code == 0
    assert endpoints(worker) == ["heartbeat", "claim", "result", "release", "release"]
    assert bodies(worker, "result")[0]["lease_id"] == "lease-00-0123456789abcdef"
    for body in bodies(worker, "release"):
        NodeReleaseRequest.model_validate(body)
    assert bodies(worker, "release") == [
        {"lease_id": "lease-01-0123456789abcdef"},
        {"lease_id": "lease-02-0123456789abcdef"},
    ]
    assert calls(done)[-2:] == [("release", 200), ("release", 200)]


def test_the_loop_polls_heartbeats_and_stops_on_sigterm(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    process = start(
        environment(worker, server, POLL_SECONDS="0.1", HEARTBEAT_SECONDS="0.25")
    )
    deadline = time.monotonic() + 30
    while endpoints(worker).count("heartbeat") < 3 and time.monotonic() < deadline:
        time.sleep(0.05)
    process.send_signal(signal.SIGTERM)
    done = finished(process)
    assert done.code == 0
    assert endpoints(worker).count("heartbeat") >= 3
    assert endpoints(worker).count("claim") > endpoints(worker).count("heartbeat")
    assert endpoints(worker)[0] == "heartbeat"
    uptimes = [body["uptime_s"] for body in bodies(worker, "heartbeat")]
    assert uptimes == sorted(uptimes)


def test_a_401_in_the_loop_exits_1(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    worker.script_jobs("unavailVid1", "germanOnly1")
    worker.replies["result"].append(
        (401, {"error": {"code": "unauthorized", "message": "x"}})
    )
    done = finished(start(environment(worker, server, POLL_SECONDS="0.1")))
    assert done.code == 1
    assert endpoints(worker) == ["heartbeat", "claim", "result"]


def test_a_failed_claim_in_the_loop_is_tried_again(
    worker: FakeWorker, server: FakeSponsorBlock
) -> None:
    worker.replies["claim"].append((500, {"error": {"code": "x", "message": "x"}}))
    worker.script_jobs("germanOnly1")
    process = start(environment(worker, server, POLL_SECONDS="0.1"))
    deadline = time.monotonic() + 30
    while "result" not in endpoints(worker) and time.monotonic() < deadline:
        time.sleep(0.05)
    process.send_signal(signal.SIGTERM)
    done = finished(process)
    assert done.code == 0
    assert endpoints(worker)[:4] == ["heartbeat", "claim", "claim", "result"]


# The client in process, its waits recorded instead of slept.


def client(worker: FakeWorker | str, waits: list[float]) -> WorkerClient:
    url = worker if isinstance(worker, str) else worker_url(worker)
    return WorkerClient(url, TOKEN, sleep=waits.append, timeout=5)


def test_result_and_release_are_retried_3_times_after_1_2_and_4_seconds(
    worker: FakeWorker,
) -> None:
    from yt_digest_node.contracts.node_job_ack import NodeJobAck

    failure = (502, {"error": {"code": "x", "message": "x"}})
    worker.leases["lease-0123456789abcdef"] = "unavailVid1"
    for endpoint in ("result", "release"):
        worker.replies[endpoint] = [failure] * 4
        waits: list[float] = []
        body = NodeReleaseRequest(lease_id="lease-0123456789abcdef")
        with pytest.raises(CallFailed):
            client(worker, waits).call(endpoint, body, NodeJobAck)
        assert waits == [1.0, 2.0, 4.0]
        worker.replies[endpoint] = [failure] * 3
        ack = client(worker, waits).call(endpoint, body, NodeJobAck)
        assert ack.video_id == "unavailVid1"
    assert endpoints(worker) == ["result"] * 8 + ["release"] * 8


def test_a_network_error_is_retried(capsys: pytest.CaptureFixture[str]) -> None:
    from yt_digest_node.contracts.node_job_ack import NodeJobAck

    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{closed.getsockname()[1]}"
    waits: list[float] = []
    body = NodeReleaseRequest(lease_id="lease-0123456789abcdef")
    with pytest.raises(CallFailed):
        client(url, waits).call("release", body, NodeJobAck, "unavailVid1")
    assert waits == list(RETRY_DELAYS)
    lines = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [line["attrs"]["status"] for line in lines] == [0, 0, 0, 0]
    assert {line["video_id"] for line in lines} == {"unavailVid1"}


def test_heartbeat_and_claim_and_4xx_are_not_retried(worker: FakeWorker) -> None:
    from yt_digest_node.contracts.node_claim_request import NodeClaimRequest
    from yt_digest_node.contracts.node_claim_response import NodeClaimResponse
    from yt_digest_node.contracts.node_job_ack import NodeJobAck

    waits: list[float] = []
    worker.replies["claim"].append((503, {}))
    with pytest.raises(CallFailed):
        client(worker, waits).call("claim", NodeClaimRequest(), NodeClaimResponse)
    worker.replies["result"].append((422, {}))
    body = NodeReleaseRequest(lease_id="x")
    with pytest.raises(CallFailed):
        client(worker, waits).call("result", body, NodeJobAck)
    worker.replies["release"].append((401, {}))
    with pytest.raises(Unauthorized):
        client(worker, waits).call("release", body, NodeJobAck)
    assert waits == []
    assert endpoints(worker) == ["claim", "result", "release"]


def test_settings_defaults() -> None:
    settings = settings_from_env({"WORKER_URL": "http://w/", "NODE_TOKEN": "t"})
    assert settings.worker_url == "http://w"
    assert (
        settings.claim_batch,
        settings.poll_seconds,
        settings.heartbeat_seconds,
    ) == (3, 10.0, 60.0)
