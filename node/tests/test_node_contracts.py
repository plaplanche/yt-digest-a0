"""The node protocol and error contracts (lot 2, spec 4.1 and 4.2)."""

from typing import Any

import pytest
from pydantic import BaseModel

from yt_digest_node.contracts import node_result_request
from yt_digest_node.contracts.error import ErrorResponse
from yt_digest_node.contracts.node_claim_request import NodeClaimRequest
from yt_digest_node.contracts.node_claim_response import ClaimedJob, NodeClaimResponse
from yt_digest_node.contracts.node_heartbeat_request import NodeHeartbeatRequest
from yt_digest_node.contracts.node_heartbeat_response import NodeHeartbeatResponse
from yt_digest_node.contracts.node_job_ack import NodeJobAck
from yt_digest_node.contracts.node_release_request import NodeReleaseRequest
from yt_digest_node.contracts.node_result_request import NodeResultRequest
from yt_digest_node.contracts.transcript_result import TranscriptResult

TS = "2026-10-16T07:00:01.123Z"
TRANSCRIPT = {
    "video_id": "dQw4w9WgXcQ",
    "status": "ok",
    "lang": "fr",
    "source": "manual",
    "word_count": 3,
    "truncated": False,
    "sponsor_ratio": 0.0,
    "pages": ["un deux trois"],
}
JOB = {
    "video_id": "dQw4w9WgXcQ",
    "lease_id": "0123456789abcdef",
    "lease_expires_at": TS,
}

VALID: list[tuple[type[BaseModel], dict[str, Any]]] = [
    (
        NodeHeartbeatRequest,
        {
            "version": "0.2.0",
            "uptime_s": 120,
            "jobs_in_progress": 1,
            "last_success_at": TS,
            "last_blocked_at": None,
            "disk_free_ratio": 0.5,
            "cpu_temp_c": 48.5,
        },
    ),
    (NodeHeartbeatRequest, {"version": "x", "uptime_s": 0, "jobs_in_progress": 0}),
    (
        NodeHeartbeatResponse,
        {"node_id": "n1", "state": "healthy", "hourly_budget": 30, "directive": "run"},
    ),
    (NodeClaimRequest, {"max_jobs": 1}),
    (NodeClaimRequest, {"max_jobs": 10}),
    (NodeClaimRequest, {}),
    (NodeClaimResponse, {"jobs": [JOB]}),
    (NodeClaimResponse, {"jobs": []}),
    (NodeResultRequest, {"lease_id": "l", "outcome": "ok", "transcript": TRANSCRIPT}),
    (NodeResultRequest, {"lease_id": "l", "outcome": "error", "transcript": None}),
    (NodeReleaseRequest, {"lease_id": "l"}),
    (NodeJobAck, {"video_id": "dQw4w9WgXcQ", "status": "failed_video"}),
    (ErrorResponse, {"error": {"code": "stale_lease", "message": "lease expired"}}),
]


@pytest.mark.parametrize(("model", "value"), VALID)
def test_a_valid_instance_is_accepted(
    model: type[BaseModel], value: dict[str, Any]
) -> None:
    assert model.model_validate(value).model_dump(exclude_unset=True) == value


@pytest.mark.parametrize(("model", "value"), VALID)
def test_an_extra_field_is_rejected(
    model: type[BaseModel], value: dict[str, Any]
) -> None:
    with pytest.raises(ValueError):
        model.model_validate(value | {"extra": 1})


@pytest.mark.parametrize(
    ("model", "value"),
    [
        (NodeHeartbeatRequest, {"uptime_s": 1, "jobs_in_progress": 0}),
        (NodeHeartbeatRequest, {"version": "", "uptime_s": 1, "jobs_in_progress": 0}),
        (
            NodeHeartbeatRequest,
            {"version": "v" * 65, "uptime_s": 1, "jobs_in_progress": 0},
        ),
        (
            NodeHeartbeatRequest,
            {"version": "v", "uptime_s": 1, "jobs_in_progress": 0, "cpu_temp_c": None},
        ),
        (
            NodeHeartbeatRequest,
            {
                "version": "v",
                "uptime_s": 1,
                "jobs_in_progress": 0,
                "disk_free_ratio": 2,
            },
        ),
        (
            NodeHeartbeatRequest,
            {
                "version": "v",
                "uptime_s": 1,
                "jobs_in_progress": 0,
                "last_success_at": "2026-10-16T07:00:01Z",
            },
        ),
        (
            NodeHeartbeatResponse,
            {"node_id": "n1", "state": "sick", "hourly_budget": 30, "directive": "run"},
        ),
        (NodeClaimRequest, {"max_jobs": 0}),
        (NodeClaimRequest, {"max_jobs": 11}),
        (NodeClaimRequest, {"max_jobs": None}),
        (NodeClaimResponse, {"jobs": [JOB | {"lease_id": "too-short"}]}),
        (NodeClaimResponse, {"jobs": [JOB | {"extra": 1}]}),
        (NodeClaimResponse, {}),
        (NodeResultRequest, {"lease_id": "l", "outcome": "done", "transcript": None}),
        (
            NodeResultRequest,
            {"lease_id": "l", "outcome": "ok", "transcript": TRANSCRIPT | {"pages": 1}},
        ),
        (
            NodeResultRequest,
            {"lease_id": "l", "outcome": "ok", "transcript": TRANSCRIPT | {"x": 1}},
        ),
        (NodeResultRequest, {"lease_id": "l", "outcome": "ok"}),
        (NodeResultRequest, {"lease_id": "", "outcome": "error", "transcript": None}),
        (NodeReleaseRequest, {"lease_id": ""}),
        (NodeJobAck, {"video_id": "dQw4w9WgXcQ", "status": "lost"}),
        (ErrorResponse, {"error": {"code": "stale_lease"}}),
        (ErrorResponse, {"error": {"code": "c", "message": "m", "extra": 1}}),
    ],
)
def test_an_invalid_instance_is_rejected(
    model: type[BaseModel], value: dict[str, Any]
) -> None:
    with pytest.raises(ValueError):
        model.model_validate(value)


def test_the_result_request_uses_the_generated_transcript_result() -> None:
    defined = [
        name
        for name, value in vars(node_result_request).items()
        if isinstance(value, type) and value.__module__ == node_result_request.__name__
    ]
    assert defined == ["NodeResultRequest"]
    assert vars(node_result_request)["TranscriptResult"] is TranscriptResult
    field = NodeResultRequest.model_fields["transcript"]
    assert field.annotation == TranscriptResult | None
    request = NodeResultRequest.model_validate(
        {"lease_id": "l", "outcome": "ok", "transcript": TRANSCRIPT}
    )
    assert isinstance(request.transcript, TranscriptResult)


def test_a_claimed_job_is_a_model() -> None:
    response = NodeClaimResponse.model_validate({"jobs": [JOB]})
    assert response.jobs == [ClaimedJob.model_validate(JOB)]
