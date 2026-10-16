import { randomBase64url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { bearer, HttpError, json, notFound, readBody, secretsEqual } from "./http";
import { failureSet, getJob, sweepExpired, VIDEO_ID } from "./jobs";
import { transcriptKey } from "./leases";
import { log } from "./log";

/** Every table of spec/lot-2.md section 6.3. */
export const TABLES = [
  "nodes",
  "jobs",
  "leases",
  "node_events",
  "invites",
  "users",
  "oauth_clients",
  "oauth_requests",
  "oauth_codes",
  "oauth_tokens",
] as const;

/** The operator endpoints (section 7): authentication first, then the route. */
export async function handleOps(request: Request, env: Env, path: string): Promise<Response> {
  const token = env.OPS_TOKEN ?? "";
  if (token === "") throw notFound();
  const given = bearer(request);
  if (given === null || !(await secretsEqual(given, token))) {
    log("auth.bearer.rejected", {
      level: "warn",
      attrs: { surface: "ops", reason: given === null ? "missing" : "unknown" },
    });
    throw new HttpError(401, "unauthorized", "a valid operator bearer is required");
  }
  if (request.method === "POST" && path === "/ops/reset") return reset(env);
  if (request.method === "POST" && path === "/ops/nodes") return enrollNode(request, env);
  if (request.method === "POST" && path === "/ops/jobs") return enqueueJobs(request, env);
  if (request.method === "POST" && path === "/ops/invites") return invite(request, env);
  if (request.method === "POST" && path === "/ops/invites/revoke") return revokeInvite(request, env);
  if (request.method === "GET" && path === "/ops/users") return listUsers(env);
  const job = /^\/ops\/jobs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && job) return readJob(env, decodeURIComponent(job[1]));
  const node = /^\/ops\/nodes\/([^/]+)$/.exec(path);
  if (request.method === "DELETE" && node) return revokeNode(env, decodeURIComponent(node[1]));
  const transcript = /^\/ops\/transcripts\/([^/]+)$/.exec(path);
  if (request.method === "GET" && transcript) return readTranscript(env, decodeURIComponent(transcript[1]));
  throw notFound();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws (into 400 `invalid_request`) when `value` has a key outside `allowed`. */
function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`unknown field ${extra}`);
}

interface NodeEnrollment {
  node_id: string;
  owner_label: string;
}

function parseNodeEnrollment(value: unknown): NodeEnrollment {
  if (!isRecord(value)) throw new Error("expected an object");
  onlyKeys(value, ["node_id", "owner_label"]);
  const { node_id, owner_label } = value;
  if (typeof node_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(node_id)) throw new Error("invalid node_id");
  if (typeof owner_label !== "string" || [...owner_label].length < 1 || [...owner_label].length > 100) {
    throw new Error("invalid owner_label");
  }
  return { node_id, owner_label };
}

/** `POST /ops/nodes`: enrolls a `healthy` node and shows its token once; only its SHA-256 is stored. */
async function enrollNode(request: Request, env: Env): Promise<Response> {
  const { node_id, owner_label } = await readBody(request, parseNodeEnrollment);
  const token = `ytd_node_${randomBase64url(32)}`;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO nodes (node_id, owner_label, token_hash, state, state_since, created_at)
     VALUES (?1, ?2, ?3, 'healthy', ?4, ?4) ON CONFLICT (node_id) DO NOTHING`,
  )
    .bind(node_id, owner_label, await sha256Hex(token), now)
    .run();
  if (result.meta.changes === 0) throw new HttpError(409, "conflict", "this node_id exists");
  log("node.enrolled", { attrs: { node_id } });
  return json({ node_id, owner_label, token });
}

interface JobsEnqueue {
  video_ids: string[];
  priority: number;
}

function parseJobsEnqueue(value: unknown): JobsEnqueue {
  if (!isRecord(value)) throw new Error("expected an object");
  onlyKeys(value, ["video_ids", "priority"]);
  const { video_ids, priority = 0 } = value;
  if (!Array.isArray(video_ids) || video_ids.length < 1 || video_ids.length > 100) {
    throw new Error("video_ids must hold 1 to 100 video ids");
  }
  if (!video_ids.every((id): id is string => typeof id === "string" && VIDEO_ID.test(id))) {
    throw new Error("invalid video id");
  }
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0) {
    throw new Error("priority must be an integer >= 0");
  }
  return { video_ids, priority };
}

/**
 * `POST /ops/jobs`: one D1 batch inserts each new id as a `queued` job and raises the priority
 * of the existing ones, never lowering it (design 18.9, C8).
 */
async function enqueueJobs(request: Request, env: Env): Promise<Response> {
  const { video_ids, priority } = await readBody(request, parseJobsEnqueue);
  const now = new Date().toISOString();
  const statements = video_ids.flatMap((videoId) => [
    env.DB.prepare(
      `INSERT INTO jobs (video_id, kind, priority, status, created_at) VALUES (?1, 'primary', ?2, 'queued', ?3)
       ON CONFLICT (video_id, kind) DO NOTHING`,
    ).bind(videoId, priority, now),
    env.DB.prepare(
      "UPDATE jobs SET priority = ?2 WHERE video_id = ?1 AND kind = 'primary' AND priority < ?2",
    ).bind(videoId, priority),
  ]);
  const results = await env.DB.batch(statements);
  const enqueued: string[] = [];
  const existing: string[] = [];
  video_ids.forEach((videoId, index) => {
    (results[2 * index].meta.changes > 0 ? enqueued : existing).push(videoId);
  });
  log("job.enqueued", { attrs: { count: enqueued.length, priority } });
  return json({ enqueued, existing });
}

/** The lowercased `email` of an invite body, a string (containing `@` for a new invite). */
function parseInviteEmail(value: unknown): string {
  if (!isRecord(value)) throw new Error("expected an object");
  onlyKeys(value, ["email"]);
  const { email } = value;
  if (typeof email !== "string") throw new Error("email must be a string");
  return email.toLowerCase();
}

function parseNewInvite(value: unknown): string {
  const email = parseInviteEmail(value);
  if (!email.includes("@")) throw new Error("email must contain @");
  return email;
}

/** `POST /ops/invites`: stores the invite, or re-activates it when it exists (its `invited_at` kept). */
async function invite(request: Request, env: Env): Promise<Response> {
  const email = await readBody(request, parseNewInvite);
  await env.DB.prepare(
    `INSERT INTO invites (email, invited_at, revoked) VALUES (?1, ?2, 0)
     ON CONFLICT (email) DO UPDATE SET revoked = 0`,
  )
    .bind(email, new Date().toISOString())
    .run();
  return json({ email, revoked: false });
}

/** `POST /ops/invites/revoke`: revoking again answers the same; an unknown invite gives 404. */
async function revokeInvite(request: Request, env: Env): Promise<Response> {
  const email = await readBody(request, parseInviteEmail);
  const row = await env.DB.prepare("UPDATE invites SET revoked = 1 WHERE email = ?1 RETURNING email").bind(email).first();
  if (row === null) throw new HttpError(404, "not_found", "no such invite");
  return json({ email, revoked: true });
}

/** `GET /ops/users`, sorted by e-mail. */
async function listUsers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT user_sub, email, role FROM users ORDER BY email, user_sub").all();
  return json({ users: results });
}

/** `GET /ops/jobs/<video_id>`, after the expiry sweep (8.6). */
async function readJob(env: Env, videoId: string): Promise<Response> {
  await sweepExpired(env);
  const job = await getJob(env, videoId);
  if (job === null) throw new HttpError(404, "not_found", "no such job");
  return json(job);
}

/**
 * `DELETE /ops/nodes/<node_id>` (8.8), one D1 batch: the node becomes `disabled` (its first
 * `revoked_at` kept), each of its `active` leases `revoked`, and each job it holds goes through
 * the failure handling. Revoking again answers the same and changes nothing.
 */
async function revokeNode(env: Env, nodeId: string): Promise<Response> {
  const now = new Date().toISOString();
  const [revoked, leases] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE nodes SET state = 'disabled', state_since = CASE WHEN state = 'disabled' THEN state_since ELSE ?2 END,
         revoked_at = COALESCE(revoked_at, ?2)
       WHERE node_id = ?1 RETURNING node_id`,
    ).bind(nodeId, now),
    env.DB.prepare("UPDATE leases SET state = 'revoked' WHERE node_id = ?1 AND state = 'active'").bind(nodeId),
    env.DB.prepare(`UPDATE jobs SET ${failureSet(now, "lease_revoked")} WHERE status = 'leased' AND leased_by = ?1`).bind(nodeId),
  ]);
  if (revoked.results.length === 0) throw new HttpError(404, "not_found", "no such node");
  log("node.revoked", { attrs: { node_id: nodeId, leases_revoked: leases.meta.changes } });
  return json({ node_id: nodeId, state: "disabled" });
}

/** `GET /ops/transcripts/<video_id>`: the stored transcript result and its metadata (6.4). */
async function readTranscript(env: Env, videoId: string): Promise<Response> {
  const object = await env.TRANSCRIPTS.get(transcriptKey(videoId));
  if (object === null) throw new HttpError(404, "not_found", "no such transcript");
  const { node_id, lease_id, produced_at } = object.customMetadata ?? {};
  return json({ video_id: videoId, transcript: await object.json(), node_id, lease_id, produced_at });
}

async function reset(env: Env): Promise<Response> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  let cursor: string | undefined;
  do {
    const page = await env.TRANSCRIPTS.list({ prefix: "transcripts/", cursor });
    if (page.objects.length > 0) await env.TRANSCRIPTS.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return json({ ok: true });
}
