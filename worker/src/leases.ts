import type { NodeJobAck } from "./contracts/node-job-ack";
import type { NodeReleaseRequest } from "./contracts/node-release-request";
import type { NodeResultRequest } from "./contracts/node-result-request";
import type { TranscriptResult } from "./contracts/transcript-result";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { failureSet } from "./jobs";
import { log } from "./log";

/** A row of `leases`. */
interface Lease {
  lease_id: string;
  video_id: string;
  node_id: string;
  state: "active" | "completed" | "released" | "expired" | "revoked" | "rejected";
  response_json: string | null;
}

/** The R2 key of a video's transcript (section 6.4). */
export function transcriptKey(videoId: string): string {
  return `transcripts/${videoId}.json`;
}

/** The marker truncation puts between the two parts of a transcript (lot 1 section 5.6); not a word. */
const MARKER = "[…]";

async function getLease(env: Env, leaseId: string): Promise<Lease | null> {
  return env.DB.prepare("SELECT lease_id, video_id, node_id, state, response_json FROM leases WHERE lease_id = ?1")
    .bind(leaseId)
    .first<Lease>();
}

function stale(nodeId: string, lease: Lease | null): HttpError {
  const job = lease === null ? {} : { video_id: lease.video_id };
  log("job.stale_result", { level: "warn", ...job, attrs: { node_id: nodeId } });
  return new HttpError(409, "stale_lease", "this lease is not the node's current lease");
}

/**
 * The answer to a lease that is not (or no longer) active: its stored answer when it is in
 * state `done` (`completed` for a result, `released` for a release, 8.4 C3 and 8.5), else
 * 409 `stale_lease`.
 */
function settled(nodeId: string, lease: Lease | null, done: Lease["state"]): Response {
  if (lease !== null && lease.node_id === nodeId && lease.state === done && lease.response_json !== null) {
    return new Response(lease.response_json, { headers: { "Content-Type": "application/json" } });
  }
  throw stale(nodeId, lease);
}

/** Why a result breaks the validation of 8.4 step 3, or null. */
export function validationFailure(videoId: string, body: NodeResultRequest): string | null {
  const transcript = body.transcript;
  if (body.outcome !== "ok") return transcript === null ? null : "transcript_not_null";
  if (transcript === null) return "transcript_missing";
  if (transcript.status !== "ok") return "status_not_ok";
  if (transcript.video_id !== videoId) return "video_id_mismatch";
  if (transcript.pages.length === 0) return "pages_empty";
  const words = transcript.pages.flatMap((page) => page.split(/\s+/)).filter((word) => word !== "" && word !== MARKER);
  if (transcript.word_count !== words.length) return "word_count_mismatch";
  return null;
}

/**
 * Writes a transcript to R2 unless an object exists (6.4, C5): the conditional put never
 * overwrites, even when two writes race. The body is the transcript result as JSON.
 */
async function storeTranscript(env: Env, transcript: TranscriptResult, nodeId: string, leaseId: string): Promise<void> {
  await env.TRANSCRIPTS.put(transcriptKey(transcript.video_id), JSON.stringify(transcript), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { node_id: nodeId, lease_id: leaseId, produced_at: new Date().toISOString() },
  });
}

/**
 * Settles an active lease in one D1 batch: the node event, the lease's new state and answer, then
 * the job's update. Each statement holds only while the job still holds the lease (a lease is
 * `active` exactly while its job is `leased` with this `lease_id`), so a concurrent duplicate
 * changes nothing; the job's RETURNING tells whether this request settled the lease.
 */
async function settle(
  env: Env,
  lease: Lease,
  change: { event: string | null; state: Lease["state"]; answer: NodeJobAck | null; jobSet: string },
): Promise<{ status: NodeJobAck["status"] } | null> {
  const holds = "SELECT 1 FROM jobs WHERE lease_id = ?1 AND status = 'leased'";
  const statements = [
    env.DB.prepare(
      `UPDATE leases SET state = ?2, response_json = ?3 WHERE lease_id = ?1 AND state = 'active' AND EXISTS (${holds})`,
    ).bind(lease.lease_id, change.state, change.answer === null ? null : JSON.stringify(change.answer)),
    env.DB.prepare(`UPDATE jobs SET ${change.jobSet} WHERE lease_id = ?1 AND status = 'leased' RETURNING status`).bind(
      lease.lease_id,
    ),
  ];
  if (change.event !== null) {
    statements.unshift(
      env.DB.prepare(
        `INSERT INTO node_events (node_id, ts, kind, video_id) SELECT ?2, ?3, ?4, ?5 WHERE EXISTS (${holds})`,
      ).bind(lease.lease_id, lease.node_id, new Date().toISOString(), change.event, lease.video_id),
    );
  }
  const results = await env.DB.batch<{ status: NodeJobAck["status"] }>(statements);
  return results[results.length - 1].results[0] ?? null;
}

/** `POST /node/result` (8.4), after authentication, the body schema and the sweep. */
export async function submitResult(env: Env, nodeId: string, body: NodeResultRequest): Promise<Response> {
  const lease = await getLease(env, body.lease_id);
  if (lease === null || lease.node_id !== nodeId || lease.state !== "active") return settled(nodeId, lease, "completed");
  const job = await env.DB.prepare("SELECT attempts FROM jobs WHERE lease_id = ?1 AND status = 'leased'")
    .bind(lease.lease_id)
    .first<{ attempts: number }>();
  if (job === null) return settled(nodeId, await getLease(env, lease.lease_id), "completed");
  const now = new Date().toISOString();
  const failedStatus = job.attempts >= 3 ? "failed_video" : "queued";

  const reason = validationFailure(lease.video_id, body);
  if (reason !== null) {
    const settledJob = await settle(env, lease, {
      event: "validation_failed",
      state: "rejected",
      answer: null,
      jobSet: failureSet(now, "validation_failed"),
    });
    if (settledJob === null) return settled(nodeId, await getLease(env, lease.lease_id), "completed");
    log("job.validation_failed", { level: "warn", video_id: lease.video_id, attrs: { node_id: nodeId, reason } });
    throw new HttpError(422, "validation_failed", `the result is invalid: ${reason}`);
  }

  if (body.outcome === "ok" && body.transcript !== null) {
    try {
      await storeTranscript(env, body.transcript, nodeId, lease.lease_id);
    } catch {
      throw new HttpError(503, "storage_error", "the transcript could not be stored");
    }
  }
  const terminal = body.outcome === "ok" || body.outcome === "no_transcript";
  const answer: NodeJobAck = { video_id: lease.video_id, status: terminal ? "done" : failedStatus };
  const settledJob = await settle(env, lease, {
    event: `job_${body.outcome}`,
    state: "completed",
    answer,
    jobSet: terminal
      ? `status = 'done', done_at = '${now}', leased_by = NULL, lease_id = NULL, lease_expires_at = NULL,
         last_outcome = '${body.outcome}'`
      : failureSet(now, body.outcome),
  });
  if (settledJob === null) return settled(nodeId, await getLease(env, lease.lease_id), "completed");
  log("job.completed", {
    video_id: lease.video_id,
    attrs: { node_id: nodeId, outcome: body.outcome, status: settledJob.status },
  });
  return json(answer);
}

/** `POST /node/release` (8.5), after authentication, the body schema and the sweep: undoes the claim. */
export async function releaseLease(env: Env, nodeId: string, body: NodeReleaseRequest): Promise<Response> {
  const lease = await getLease(env, body.lease_id);
  if (lease === null || lease.node_id !== nodeId || lease.state !== "active") return settled(nodeId, lease, "released");
  const answer: NodeJobAck = { video_id: lease.video_id, status: "queued" };
  const settledJob = await settle(env, lease, {
    event: null,
    state: "released",
    answer,
    // The claim appended the node to tried_nodes last, and a node is never in it twice.
    jobSet: `status = 'queued', leased_by = NULL, lease_id = NULL, lease_expires_at = NULL, attempts = attempts - 1,
             tried_nodes = json_remove(tried_nodes, '$[#-1]'), last_outcome = 'released'`,
  });
  if (settledJob === null) return settled(nodeId, await getLease(env, lease.lease_id), "released");
  log("job.released", { video_id: lease.video_id, attrs: { node_id: nodeId } });
  return json(answer);
}
