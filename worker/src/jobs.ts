import type { ClaimedJob } from "./contracts/node-claim-response";
import type { Env } from "./env";
import { log } from "./log";

/** A video id (spec/lot-2.md section 4.1). */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A job as `GET /ops/jobs/<video_id>` shows it (section 7). */
export interface JobView {
  video_id: string;
  kind: string;
  priority: number;
  status: string;
  leased_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  tried_nodes: string[];
  last_outcome: string | null;
  created_at: string;
  done_at: string | null;
}

type JobRow = Omit<JobView, "tried_nodes"> & { tried_nodes: string };

/** The `primary` job of a video, or null. */
export async function getJob(env: Env, videoId: string): Promise<JobView | null> {
  const row = await env.DB.prepare(
    `SELECT video_id, kind, priority, status, leased_by, lease_expires_at, attempts, tried_nodes,
            last_outcome, created_at, done_at
     FROM jobs WHERE video_id = ?1 AND kind = 'primary'`,
  )
    .bind(videoId)
    .first<JobRow>();
  if (row === null) return null;
  return { ...row, tried_nodes: JSON.parse(row.tried_nodes) as string[] };
}

/** A job just leased by a claim. */
export interface Claim extends ClaimedJob {
  attempts: number;
}

/**
 * Leases up to `maxJobs` eligible jobs to `nodeId` (section 8.3) in one D1 batch, which runs as a
 * transaction: the UPDATE picks the jobs and leases them in a single conditional statement, so
 * that concurrent claims never take the same job (C1) and each sees the jobs the others left; the
 * INSERT then adds the `leases` row of every lease that has none, which are exactly this claim's.
 */
export async function claimJobs(env: Env, nodeId: string, maxJobs: number, leaseSeconds: number): Promise<Claim[]> {
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const [claimed] = await env.DB.batch<Claim & { priority: number; created_at: string }>([
    env.DB.prepare(
      `UPDATE jobs SET
         status = 'leased', leased_by = ?1, lease_id = lower(hex(randomblob(16))), lease_expires_at = ?2,
         attempts = attempts + 1, tried_nodes = json_insert(tried_nodes, '$[#]', ?1)
       WHERE rowid IN (
         SELECT rowid FROM jobs
         WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM json_each(jobs.tried_nodes) WHERE value = ?1)
         ORDER BY priority DESC, created_at ASC, video_id ASC
         LIMIT ?3
       )
       RETURNING video_id, lease_id, lease_expires_at, attempts, priority, created_at`,
    ).bind(nodeId, expiresAt, maxJobs),
    env.DB.prepare(
      `INSERT INTO leases (lease_id, video_id, node_id, issued_at, expires_at, state)
       SELECT lease_id, video_id, leased_by, ?2, lease_expires_at, 'active' FROM jobs
       WHERE status = 'leased' AND leased_by = ?1
         AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.lease_id = jobs.lease_id)`,
    ).bind(nodeId, issuedAt),
  ]);
  // RETURNING gives no order: sort as the claim picked them.
  return claimed.results
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        compareText(a.created_at, b.created_at) ||
        compareText(a.video_id, b.video_id),
    )
    .map(({ video_id, lease_id, lease_expires_at, attempts }) => ({ video_id, lease_id, lease_expires_at, attempts }));
}

/** Compares strings by code unit, as SQLite's default BINARY collation does for ASCII text. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The failure handling of section 8.7, as the SET clause of an UPDATE of `jobs`: the lease is
 * cleared, and the job becomes `failed_video` (with `done_at` = `?now`) after its third attempt,
 * else `queued`. `?outcome` is the `last_outcome`.
 */
export function failureSet(now: string, outcome: string): string {
  return `status = CASE WHEN attempts >= 3 THEN 'failed_video' ELSE 'queued' END,
         done_at = CASE WHEN attempts >= 3 THEN '${now}' ELSE done_at END,
         leased_by = NULL, lease_id = NULL, lease_expires_at = NULL, last_outcome = '${outcome}'`;
}

/**
 * The expiry sweep (section 8.6), one D1 batch: every `leased` job whose lease expires at or
 * before now gets an `expired` lease, a `lease_expired` node event against its holder, and the
 * failure handling. The first statement reads the holders, which the transaction keeps consistent
 * with the writes that follow, so that a concurrent sweep never expires a lease twice.
 */
export async function sweepExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const expired = "status = 'leased' AND lease_expires_at <= ?1";
  const [holders, , , swept] = await env.DB.batch<{ video_id: string; leased_by: string; attempts: number; status: string }>([
    env.DB.prepare(`SELECT video_id, leased_by FROM jobs WHERE ${expired}`).bind(now),
    env.DB.prepare(
      `INSERT INTO node_events (node_id, ts, kind, video_id)
       SELECT leased_by, ?1, 'lease_expired', video_id FROM jobs WHERE ${expired}`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE leases SET state = 'expired'
       WHERE state = 'active' AND lease_id IN (SELECT lease_id FROM jobs WHERE ${expired})`,
    ).bind(now),
    env.DB.prepare(`UPDATE jobs SET ${failureSet(now, "lease_expired")} WHERE ${expired} RETURNING video_id, attempts, status`).bind(
      now,
    ),
  ]);
  const holderOf = new Map(holders.results.map((row) => [row.video_id, row.leased_by]));
  for (const job of swept.results) {
    log("job.lease_expired", {
      level: "warn",
      video_id: job.video_id,
      attrs: { node_id: holderOf.get(job.video_id) ?? null, attempts: job.attempts, status: job.status },
    });
  }
}
