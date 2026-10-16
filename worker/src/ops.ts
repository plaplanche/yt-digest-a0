import { randomBase64url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { bearer, HttpError, json, notFound, readBody, secretsEqual } from "./http";
import { getJob, VIDEO_ID } from "./jobs";
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
  const job = /^\/ops\/jobs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && job) return readJob(env, decodeURIComponent(job[1]));
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

/** `GET /ops/jobs/<video_id>`. */
async function readJob(env: Env, videoId: string): Promise<Response> {
  const job = await getJob(env, videoId);
  if (job === null) throw new HttpError(404, "not_found", "no such job");
  return json(job);
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
