import { parseNodeClaimRequest } from "./contracts/node-claim-request";
import type { NodeClaimResponse } from "./contracts/node-claim-response";
import { parseNodeHeartbeatRequest } from "./contracts/node-heartbeat-request";
import type { NodeHeartbeatResponse } from "./contracts/node-heartbeat-response";
import { sha256Hex } from "./crypto";
import { leaseSeconds, type Env } from "./env";
import { bearer, HttpError, json, notFound, readBody } from "./http";
import { parseNodeReleaseRequest } from "./contracts/node-release-request";
import { parseNodeResultRequest } from "./contracts/node-result-request";
import { claimJobs, sweepExpired } from "./jobs";
import { releaseLease, submitResult } from "./leases";
import { log } from "./log";

/** The node a token belongs to. */
interface Node {
  node_id: string;
  hourly_budget: number;
}

/**
 * The node protocol (section 8): the route, then the node's bearer (8.1), then the body, then the
 * expiry sweep (8.6).
 */
export async function handleNode(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") throw notFound();
  if (path === "/node/heartbeat") return heartbeat(request, env, await authenticate(request, env));
  if (path === "/node/claim") return claim(request, env, await authenticate(request, env));
  if (path === "/node/result") {
    const node = await authenticate(request, env);
    const body = await readBody(request, parseNodeResultRequest);
    await sweepExpired(env);
    return submitResult(env, node.node_id, body);
  }
  if (path === "/node/release") {
    const node = await authenticate(request, env);
    const body = await readBody(request, parseNodeReleaseRequest);
    await sweepExpired(env);
    return releaseLease(env, node.node_id, body);
  }
  throw notFound();
}

/** The node whose token is the request's bearer; 401 `unauthorized` for a missing, unknown or revoked one. */
async function authenticate(request: Request, env: Env): Promise<Node> {
  const token = bearer(request);
  let reason: "missing" | "unknown" | "revoked" = "missing";
  if (token !== null) {
    const row = await env.DB.prepare("SELECT node_id, hourly_budget, revoked_at FROM nodes WHERE token_hash = ?1")
      .bind(await sha256Hex(token))
      .first<Node & { revoked_at: string | null }>();
    if (row !== null && row.revoked_at === null) return { node_id: row.node_id, hourly_budget: row.hourly_budget };
    reason = row === null ? "unknown" : "revoked";
  }
  log("auth.bearer.rejected", { level: "warn", attrs: { surface: "node", reason } });
  throw new HttpError(401, "unauthorized", "a valid node bearer is required");
}

/** `POST /node/heartbeat` (8.2). */
async function heartbeat(request: Request, env: Env, node: Node): Promise<Response> {
  const body = await readBody(request, parseNodeHeartbeatRequest);
  await sweepExpired(env);
  await env.DB.prepare("UPDATE nodes SET last_heartbeat_at = ?2, version = ?3 WHERE node_id = ?1")
    .bind(node.node_id, new Date().toISOString(), body.version)
    .run();
  log("node.heartbeat", {
    attrs: { node_id: node.node_id, version: body.version, jobs_in_progress: body.jobs_in_progress },
  });
  const response: NodeHeartbeatResponse = {
    node_id: node.node_id,
    state: "healthy",
    hourly_budget: node.hourly_budget,
    directive: "run",
  };
  return json(response);
}

/** `POST /node/claim` (8.3). */
async function claim(request: Request, env: Env, node: Node): Promise<Response> {
  const body = await readBody(request, parseNodeClaimRequest);
  await sweepExpired(env);
  const seconds = leaseSeconds(env);
  const claims = await claimJobs(env, node.node_id, body.max_jobs ?? 3, seconds);
  for (const job of claims) {
    log("job.claimed", {
      video_id: job.video_id,
      attrs: { node_id: node.node_id, attempt: job.attempts, lease_seconds: seconds },
    });
  }
  const response: NodeClaimResponse = {
    jobs: claims.map(({ video_id, lease_id, lease_expires_at }) => ({ video_id, lease_id, lease_expires_at })),
  };
  return json(response);
}
