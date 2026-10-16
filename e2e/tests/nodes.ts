import { expect, type APIRequestContext } from "@playwright/test";

// Helpers of the node protocol tests (spec/lot-2.md sections 7 and 8).

export const ops = { Authorization: `Bearer ${process.env.OPS_TOKEN ?? "ops-local"}` };

/** The stack's lease duration: the e2e check starts it with LEASE_SECONDS=2. */
export const leaseMs = Number(process.env.LEASE_SECONDS ?? "2") * 1000;

export interface Lease {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
}

export async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post("/ops/reset", { headers: ops })).status()).toBe(200);
}

export async function enroll(request: APIRequestContext, nodeId: string): Promise<string> {
  const response = await request.post("/ops/nodes", { headers: ops, data: { node_id: nodeId, owner_label: nodeId } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

export async function enqueue(request: APIRequestContext, videoIds: string[]): Promise<void> {
  const response = await request.post("/ops/jobs", { headers: ops, data: { video_ids: videoIds } });
  expect(await response.json()).toEqual({ enqueued: videoIds, existing: [] });
}

export async function job(request: APIRequestContext, videoId: string): Promise<Record<string, unknown>> {
  const response = await request.get(`/ops/jobs/${videoId}`, { headers: ops });
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

export function nodeHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function claim(request: APIRequestContext, token: string, maxJobs: number): Promise<Lease[]> {
  const response = await request.post("/node/claim", { headers: nodeHeaders(token), data: { max_jobs: maxJobs } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { jobs: Lease[] }).jobs;
}

/** A valid `ok` transcript result of `videoId`. */
export function transcript(videoId: string): Record<string, unknown> {
  return {
    video_id: videoId,
    status: "ok",
    lang: "en",
    source: "manual",
    word_count: 4,
    truncated: false,
    sponsor_ratio: 0,
    pages: [`Words of ${videoId} here`],
  };
}

export function okResult(lease: Lease): Record<string, unknown> {
  return { lease_id: lease.lease_id, outcome: "ok", transcript: transcript(lease.video_id) };
}
