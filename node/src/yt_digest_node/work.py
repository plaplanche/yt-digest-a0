"""The node daemon (spec lot 2, section 9): heartbeats, claims jobs, runs the transcript
pipeline on each and sends the results back over the node protocol (section 8)."""

import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, TypeVar

from pydantic import BaseModel, ValidationError

from yt_digest_node import __version__
from yt_digest_node.contracts.log_event import LogEventName
from yt_digest_node.contracts.node_claim_request import NodeClaimRequest
from yt_digest_node.contracts.node_claim_response import ClaimedJob, NodeClaimResponse
from yt_digest_node.contracts.node_heartbeat_request import NodeHeartbeatRequest
from yt_digest_node.contracts.node_heartbeat_response import NodeHeartbeatResponse
from yt_digest_node.contracts.node_job_ack import NodeJobAck
from yt_digest_node.contracts.node_release_request import NodeReleaseRequest
from yt_digest_node.contracts.node_result_request import NodeResultRequest
from yt_digest_node.extractor import Extractor
from yt_digest_node.log import emit
from yt_digest_node.pipeline import Config, transcript

Endpoint = Literal["heartbeat", "claim", "result", "release"]
Response = TypeVar("Response", bound=BaseModel)

# Waits before the retries of /node/result and /node/release.
RETRY_DELAYS = (1.0, 2.0, 4.0)
RETRIED: frozenset[Endpoint] = frozenset({"result", "release"})
TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class Settings:
    """The variables of section 9."""

    worker_url: str
    node_token: str
    claim_batch: int = 3
    poll_seconds: float = 10.0
    heartbeat_seconds: float = 60.0


def _number(environ: Mapping[str, str], name: str, default: float) -> float:
    raw = environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0:
        raise ValueError(f"{name} must be a positive number of seconds, got {raw!r}")
    return value


def settings_from_env(environ: Mapping[str, str]) -> Settings:
    """The settings of section 9; raises `ValueError` on a missing or invalid value."""
    missing = [name for name in ("WORKER_URL", "NODE_TOKEN") if not environ.get(name)]
    if missing:
        raise ValueError(f"missing {', '.join(missing)}")
    raw_batch = environ.get("CLAIM_BATCH", "3")
    try:
        claim_batch = int(raw_batch)
    except ValueError:
        claim_batch = 0
    if not 1 <= claim_batch <= 10:
        raise ValueError(
            f"CLAIM_BATCH must be an integer from 1 to 10, got {raw_batch!r}"
        )
    return Settings(
        worker_url=environ["WORKER_URL"].rstrip("/"),
        node_token=environ["NODE_TOKEN"],
        claim_batch=claim_batch,
        poll_seconds=_number(environ, "POLL_SECONDS", 10.0),
        heartbeat_seconds=_number(environ, "HEARTBEAT_SECONDS", 60.0),
    )


class CallFailed(Exception):
    """A call that got a network error (status 0), a non-2xx status after its retries,
    or a response its contract rejects."""

    def __init__(self, endpoint: Endpoint, status: int) -> None:
        super().__init__(f"{endpoint}: {status}")
        self.status = status


class Unauthorized(Exception):
    """A 401: the Worker refuses the node's token."""


class WorkerClient:
    """The node protocol: one POST per call, each logged as `worker.call`."""

    def __init__(
        self,
        url: str,
        token: str,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = TIMEOUT_SECONDS,
    ) -> None:
        self._url = url
        self._token = token
        self._sleep = sleep
        self._timeout = timeout

    def _post(
        self, endpoint: Endpoint, body: BaseModel, video_id: str | None
    ) -> tuple[int, bytes]:
        request = urllib.request.Request(
            f"{self._url}/node/{endpoint}",
            data=body.model_dump_json(exclude_unset=True).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        started = time.monotonic()
        status, payload = 0, b""
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status = error.code
        except (OSError, ValueError):
            pass
        ids = {} if video_id is None else {"video_id": video_id}
        emit(
            LogEventName.WORKER_CALL,
            level="info" if 200 <= status < 300 else "warn",
            attrs={
                "endpoint": endpoint,
                "status": status,
                "duration_ms": round((time.monotonic() - started) * 1000),
            },
            **ids,
        )
        return status, payload

    def call(
        self,
        endpoint: Endpoint,
        body: BaseModel,
        response: type[Response],
        video_id: str | None = None,
    ) -> Response:
        """The validated response of a 2xx. A network error or a 5xx of `result` and
        `release` is retried after each of `RETRY_DELAYS`; a 4xx never is."""
        delays = RETRY_DELAYS if endpoint in RETRIED else ()
        for delay in (*delays, None):
            status, payload = self._post(endpoint, body, video_id)
            if 200 <= status < 300:
                try:
                    return response.model_validate_json(payload)
                except ValidationError:
                    raise CallFailed(endpoint, status) from None
            if status == 401:
                raise Unauthorized(endpoint)
            if delay is None or 0 < status < 500:
                raise CallFailed(endpoint, status)
            self._sleep(delay)
        raise AssertionError("unreachable")


class Daemon:
    """The cycle of section 9; `stop` is set on SIGTERM or SIGINT."""

    def __init__(
        self,
        client: WorkerClient,
        settings: Settings,
        config: Config,
        extractor: Extractor,
        once: bool,
    ) -> None:
        self.client = client
        self.settings = settings
        self.config = config
        self.extractor = extractor
        self.once = once
        self.stop = threading.Event()
        self._started = time.monotonic()
        self._last_heartbeat = 0.0
        self._in_progress = 0

    def run(self) -> int:
        """0 on a clean end; 1 on a 401, or on a failed heartbeat or claim with
        `--once`."""
        try:
            return self._run()
        except Unauthorized:
            return 1

    def _run(self) -> int:
        try:
            self._heartbeat()
        except CallFailed:
            if self.once:
                return 1
        while not self.stop.is_set():
            try:
                jobs = self._claim()
            except CallFailed:
                if self.once:
                    return 1
                jobs = []
            self._work(jobs)
            if self.once:
                return 0
            if not jobs:
                self.stop.wait(self.settings.poll_seconds)
            self._heartbeat_if_due()
        return 0

    def _heartbeat(self) -> None:
        self._last_heartbeat = time.monotonic()
        self.client.call(
            "heartbeat",
            NodeHeartbeatRequest(
                version=__version__,
                uptime_s=int(time.monotonic() - self._started),
                jobs_in_progress=self._in_progress,
            ),
            NodeHeartbeatResponse,
        )

    def _heartbeat_if_due(self) -> None:
        due = time.monotonic() - self._last_heartbeat >= self.settings.heartbeat_seconds
        if self.once or self.stop.is_set() or not due:
            return
        try:
            self._heartbeat()
        except CallFailed:
            pass

    def _claim(self) -> list[ClaimedJob]:
        claimed = self.client.call(
            "claim",
            NodeClaimRequest(max_jobs=self.settings.claim_batch),
            NodeClaimResponse,
        )
        return claimed.jobs

    def _work(self, jobs: list[ClaimedJob]) -> None:
        """Processes the jobs in order; once stopped, releases those not started."""
        self._in_progress = len(jobs)
        for job in jobs:
            try:
                if self.stop.is_set():
                    self._send(
                        "release", NodeReleaseRequest(lease_id=job.lease_id), job
                    )
                else:
                    self._send("result", self._result(job), job)
                    self._heartbeat_if_due()
            finally:
                self._in_progress -= 1

    def _send(self, endpoint: Endpoint, body: BaseModel, job: ClaimedJob) -> None:
        try:
            self.client.call(endpoint, body, NodeJobAck, job.video_id)
        except CallFailed:
            pass  # Logged by `worker.call`; the lease expires on the Worker.

    def _result(self, job: ClaimedJob) -> NodeResultRequest:
        started = time.monotonic()
        try:
            result = transcript(
                job.video_id, self.config.langs, self.config, self.extractor
            )
        except Exception:
            emit(
                LogEventName.FETCH_TRANSCRIPT,
                level="error",
                video_id=job.video_id,
                attrs={
                    "outcome": "error",
                    "source": None,
                    "words": 0,
                    "pages": 0,
                    "sponsor_ratio": None,
                    "sponsorblock": None,
                    "duration_ms": round((time.monotonic() - started) * 1000),
                },
            )
            return NodeResultRequest(
                lease_id=job.lease_id, outcome="error", transcript=None
            )
        return NodeResultRequest(
            lease_id=job.lease_id,
            outcome=result.status,
            transcript=result if result.status == "ok" else None,
        )
