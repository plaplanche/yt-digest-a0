import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseNodeClaimResponse, type ClaimedJob } from "../src/contracts/node-claim-response";
import { parseNodeJobAck } from "../src/contracts/node-job-ack";
import type { TranscriptResult } from "../src/contracts/transcript-result";
import type { Env } from "../src/env";
import { call, captureLogs, enqueue, enroll, expectError, job, OPS } from "./helpers";

const VIDEO = "aaaaaaaaaaa";

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function post(path: string, token: string, body: unknown, overrides: Partial<Env> = {}): Promise<Response> {
  return call(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, overrides);
}

async function claim(token: string, maxJobs = 3): Promise<ClaimedJob[]> {
  const response = await post("/node/claim", token, { max_jobs: maxJobs });
  expect(response.status).toBe(200);
  return parseNodeClaimResponse(await response.json()).jobs;
}

async function claimOne(token: string): Promise<ClaimedJob> {
  const jobs = await claim(token, 1);
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

/** A valid `ok` transcript of `videoId`: 4 words, the truncation marker excluded. */
function transcript(videoId = VIDEO, overrides: Partial<TranscriptResult> = {}): TranscriptResult {
  return {
    video_id: videoId,
    status: "ok",
    lang: "en",
    source: "manual",
    word_count: 4,
    truncated: true,
    sponsor_ratio: 0,
    pages: ["one two\n\nthree", "[…]\n\nfour"],
    ...overrides,
  };
}

function okResult(leaseId: string, videoId = VIDEO): unknown {
  return { lease_id: leaseId, outcome: "ok", transcript: transcript(videoId) };
}

function failure(leaseId: string, outcome: "no_transcript" | "unavailable" | "blocked" | "error"): unknown {
  return { lease_id: leaseId, outcome, transcript: null };
}

async function ack(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  return parseNodeJobAck(await response.json());
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

async function leaseState(leaseId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT state FROM leases WHERE lease_id = ?1").bind(leaseId).first<{ state: string }>();
  return row?.state;
}

async function nodeEvents(): Promise<Record<string, unknown>[]> {
  return rows("SELECT node_id, kind, video_id FROM node_events ORDER BY rowid");
}

/** Freezes the Worker's clock at `iso`. */
function clockAt(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

/** The test R2 bucket, except that every write fails. */
function failingBucket(): R2Bucket {
  return new Proxy(env.TRANSCRIPTS, {
    get(target, key) {
      if (key === "put") return () => Promise.reject(new Error("R2 is down"));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("POST /node/result: ok", () => {
  test("stores the transcript in R2 with its metadata and makes the job done", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const lines = captureLogs();
    const before = Date.now();
    expect(await ack(await post("/node/result", token, okResult(lease.lease_id)))).toEqual({ video_id: VIDEO, status: "done" });

    const object = await env.TRANSCRIPTS.get(`transcripts/${VIDEO}.json`);
    expect(object?.httpMetadata?.contentType).toBe("application/json");
    expect(object?.customMetadata).toEqual({ node_id: "pi-1", lease_id: lease.lease_id, produced_at: expect.any(String) });
    expect(Date.parse(object?.customMetadata?.produced_at ?? "")).toBeGreaterThanOrEqual(before);
    expect(await object?.json()).toEqual(transcript());

    const shown = await job(VIDEO);
    expect(shown).toMatchObject({ status: "done", leased_by: null, lease_expires_at: null, attempts: 1, last_outcome: "ok" });
    expect(Date.parse(String(shown.done_at))).toBeGreaterThanOrEqual(before);
    expect(await rows("SELECT lease_id, state, response_json FROM leases")).toEqual([
      { lease_id: lease.lease_id, state: "completed", response_json: JSON.stringify({ video_id: VIDEO, status: "done" }) },
    ]);
    expect(await rows("SELECT lease_id FROM jobs")).toEqual([{ lease_id: null }]);
    expect(await nodeEvents()).toEqual([{ node_id: "pi-1", kind: "job_ok", video_id: VIDEO }]);
    expect(lines()).toMatchObject([
      { event: "job.completed", video_id: VIDEO, attrs: { node_id: "pi-1", outcome: "ok", status: "done" } },
    ]);
    expect(JSON.stringify(lines())).not.toContain("three");

    const stored = await call(`/ops/transcripts/${VIDEO}`, { headers: OPS });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({
      video_id: VIDEO,
      transcript: transcript(),
      node_id: "pi-1",
      lease_id: lease.lease_id,
      produced_at: object?.customMetadata?.produced_at,
    });
  });

  test("the same result sent again gives the same 200 and writes nothing", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const first = await (await post("/node/result", token, okResult(lease.lease_id))).text();
    const object = await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`);
    const shown = await job(VIDEO);
    const lines = captureLogs();

    for (const body of [okResult(lease.lease_id), failure(lease.lease_id, "error")]) {
      const again = await post("/node/result", token, body);
      expect(again.status).toBe(200);
      expect(await again.text()).toBe(first);
    }
    expect((await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`))?.customMetadata).toEqual(object?.customMetadata);
    expect(await job(VIDEO)).toEqual(shown);
    expect(await nodeEvents()).toHaveLength(1);
    expect(lines()).toEqual([]);
  });

  test("concurrent copies of one result complete it once", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const lines = captureLogs();
    const answers = await Promise.all(Array.from({ length: 5 }, () => post("/node/result", token, okResult(lease.lease_id))));
    for (const answer of answers) expect(await ack(answer)).toEqual({ video_id: VIDEO, status: "done" });
    expect(await nodeEvents()).toHaveLength(1);
    expect(lines().filter((line) => line.event === "job.completed")).toHaveLength(1);
  });

  test("an existing transcript is never overwritten", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    await env.TRANSCRIPTS.put(`transcripts/${VIDEO}.json`, '{"earlier":true}', { customMetadata: { node_id: "pi-0" } });
    expect(await ack(await post("/node/result", token, okResult(lease.lease_id)))).toEqual({ video_id: VIDEO, status: "done" });
    const object = await env.TRANSCRIPTS.get(`transcripts/${VIDEO}.json`);
    expect(await object?.text()).toBe('{"earlier":true}');
    expect(object?.customMetadata).toEqual({ node_id: "pi-0" });
  });

  test("a failed R2 write gives 503 storage_error and keeps the lease", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    await expectError(await post("/node/result", token, okResult(lease.lease_id), { TRANSCRIPTS: failingBucket() }), 503, "storage_error");
    expect(await leaseState(lease.lease_id)).toBe("active");
    expect(await job(VIDEO)).toMatchObject({ status: "leased", leased_by: "pi-1", attempts: 1, last_outcome: null });
    expect(await nodeEvents()).toEqual([]);
    // The node retries once R2 is back.
    expect(await ack(await post("/node/result", token, okResult(lease.lease_id)))).toEqual({ video_id: VIDEO, status: "done" });
  });
});

describe("POST /node/result: other outcomes", () => {
  test("no_transcript is terminal at once and writes nothing to R2", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    expect(await ack(await post("/node/result", token, failure(lease.lease_id, "no_transcript")))).toEqual({
      video_id: VIDEO,
      status: "done",
    });
    expect(await job(VIDEO)).toMatchObject({ status: "done", attempts: 1, last_outcome: "no_transcript", done_at: expect.any(String) });
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    await expectError(await call(`/ops/transcripts/${VIDEO}`, { headers: OPS }), 404, "not_found");
    expect(await nodeEvents()).toEqual([{ node_id: "pi-1", kind: "job_no_transcript", video_id: VIDEO }]);
    expect(await claim(await enroll("pi-2"))).toEqual([]);
  });

  test.each(["unavailable", "blocked", "error"] as const)("%s requeues the job for another node", async (outcome) => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    const lease = await claimOne(first);
    const lines = captureLogs();
    expect(await ack(await post("/node/result", first, failure(lease.lease_id, outcome)))).toEqual({ video_id: VIDEO, status: "queued" });
    expect(lines()).toMatchObject([{ event: "job.completed", attrs: { node_id: "pi-1", outcome, status: "queued" } }]);
    expect(await job(VIDEO)).toMatchObject({
      status: "queued",
      leased_by: null,
      lease_expires_at: null,
      attempts: 1,
      tried_nodes: ["pi-1"],
      last_outcome: outcome,
      done_at: null,
    });
    expect(await leaseState(lease.lease_id)).toBe("completed");
    expect(await nodeEvents()).toEqual([{ node_id: "pi-1", kind: `job_${outcome}`, video_id: VIDEO }]);
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    expect(await claim(first)).toEqual([]);
    expect((await claim(second)).map((claimed) => claimed.video_id)).toEqual([VIDEO]);
  });

  test("the third failure, on the third node, gives failed_video, and no node gets the job again", async () => {
    const tokens = [await enroll("pi-1"), await enroll("pi-2"), await enroll("pi-3"), await enroll("pi-4")];
    await enqueue([VIDEO]);
    const outcomes = ["unavailable", "blocked", "error"] as const;
    for (const [index, outcome] of outcomes.entries()) {
      const lease = await claimOne(tokens[index]);
      const status = index === 2 ? "failed_video" : "queued";
      expect(await ack(await post("/node/result", tokens[index], failure(lease.lease_id, outcome)))).toEqual({ video_id: VIDEO, status });
    }
    expect(await job(VIDEO)).toMatchObject({
      status: "failed_video",
      attempts: 3,
      tried_nodes: ["pi-1", "pi-2", "pi-3"],
      last_outcome: "error",
      done_at: expect.any(String),
    });
    for (const token of tokens) expect(await claim(token)).toEqual([]);
  });

  test("the response holds only the video id and the job's status", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const body = (await (await post("/node/result", token, okResult(lease.lease_id))).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "video_id"]);
  });
});

describe("POST /node/result: lease check and body", () => {
  test("an unknown lease gives 409 stale_lease, is logged and changes nothing", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    await claimOne(token);
    const shown = await job(VIDEO);
    const lines = captureLogs();
    await expectError(await post("/node/result", token, okResult("no-such-lease-0000")), 409, "stale_lease");
    expect(lines()).toMatchObject([{ event: "job.stale_result", level: "warn", attrs: { node_id: "pi-1" } }]);
    expect(await job(VIDEO)).toEqual(shown);
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
  });

  test("another node's lease gives 409 stale_lease and changes nothing", async () => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    const lease = await claimOne(first);
    const shown = await job(VIDEO);
    await expectError(await post("/node/result", second, okResult(lease.lease_id)), 409, "stale_lease");
    await expectError(await post("/node/release", second, { lease_id: lease.lease_id }), 409, "stale_lease");
    expect(await job(VIDEO)).toEqual(shown);
    expect(await leaseState(lease.lease_id)).toBe("active");
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    expect(await nodeEvents()).toEqual([]);
  });

  test.each([
    ["no transcript key", { lease_id: "x", outcome: "error" }],
    ["an empty lease_id", { lease_id: "", outcome: "error", transcript: null }],
    ["an unknown outcome", { lease_id: "x", outcome: "validation_failed", transcript: null }],
    ["a transcript breaking its schema", { lease_id: "x", outcome: "ok", transcript: { ...transcript(), extra: 1 } }],
    ["an extra field", { lease_id: "x", outcome: "error", transcript: null, node_id: "pi-2" }],
  ])("%s gives 400 invalid_request and changes nothing", async (_, body) => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const shown = await job(VIDEO);
    await expectError(await post("/node/result", token, { ...body, lease_id: body.lease_id && lease.lease_id }), 400, "invalid_request");
    expect(await job(VIDEO)).toEqual(shown);
    expect(await leaseState(lease.lease_id)).toBe("active");
  });

  test("authentication comes before the body", async () => {
    await expectError(await call("/node/result", { method: "POST", body: "{not json" }), 401, "unauthorized");
    await expectError(await call("/node/release", { method: "POST", body: "{not json" }), 401, "unauthorized");
  });
});

describe("POST /node/result: validation", () => {
  const cases: [string, (leaseId: string) => unknown, string][] = [
    ["ok without a transcript", (id) => ({ lease_id: id, outcome: "ok", transcript: null }), "transcript_missing"],
    [
      "ok with a transcript whose status is not ok",
      (id) => ({ lease_id: id, outcome: "ok", transcript: transcript(VIDEO, { status: "no_transcript" }) }),
      "status_not_ok",
    ],
    [
      "ok with another video's transcript",
      (id) => ({ lease_id: id, outcome: "ok", transcript: transcript("bbbbbbbbbbb") }),
      "video_id_mismatch",
    ],
    [
      "ok without pages",
      (id) => ({ lease_id: id, outcome: "ok", transcript: transcript(VIDEO, { pages: [], word_count: 0 }) }),
      "pages_empty",
    ],
    [
      "ok with a word_count counting the marker",
      (id) => ({ lease_id: id, outcome: "ok", transcript: transcript(VIDEO, { word_count: 5 }) }),
      "word_count_mismatch",
    ],
    [
      "ok with a word_count one short",
      (id) => ({ lease_id: id, outcome: "ok", transcript: transcript(VIDEO, { word_count: 3 }) }),
      "word_count_mismatch",
    ],
    [
      "no_transcript with a transcript",
      (id) => ({ lease_id: id, outcome: "no_transcript", transcript: transcript(VIDEO, { status: "no_transcript" }) }),
      "transcript_not_null",
    ],
    ["error with a transcript", (id) => ({ lease_id: id, outcome: "error", transcript: transcript() }), "transcript_not_null"],
  ];

  test.each(cases)("%s gives 422 validation_failed and counts as a failure", async (_, body, reason) => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    const lease = await claimOne(first);
    const lines = captureLogs();
    await expectError(await post("/node/result", first, body(lease.lease_id)), 422, "validation_failed");
    expect(lines()).toMatchObject([{ event: "job.validation_failed", video_id: VIDEO, attrs: { node_id: "pi-1", reason } }]);
    expect(await leaseState(lease.lease_id)).toBe("rejected");
    expect(await nodeEvents()).toEqual([{ node_id: "pi-1", kind: "validation_failed", video_id: VIDEO }]);
    expect(await job(VIDEO)).toMatchObject({ status: "queued", leased_by: null, attempts: 1, last_outcome: "validation_failed" });
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    // The rejected lease is stale from then on, also for a valid result; the job goes to another node.
    await expectError(await post("/node/result", first, okResult(lease.lease_id)), 409, "stale_lease");
    expect((await claim(second)).map((claimed) => claimed.video_id)).toEqual([VIDEO]);
  });

  test("a valid result with no word outside the marker is accepted", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const lease = await claimOne(token);
    const body = { lease_id: lease.lease_id, outcome: "ok", transcript: transcript(VIDEO, { pages: ["  a\tb\n c  "], word_count: 3 }) };
    expect(await ack(await post("/node/result", token, body))).toEqual({ video_id: VIDEO, status: "done" });
  });

  test("a third validation failure gives failed_video", async () => {
    const tokens = [await enroll("pi-1"), await enroll("pi-2"), await enroll("pi-3")];
    await enqueue([VIDEO]);
    for (const token of tokens) {
      const lease = await claimOne(token);
      await expectError(await post("/node/result", token, { lease_id: lease.lease_id, outcome: "ok", transcript: null }), 422, "validation_failed");
    }
    expect(await job(VIDEO)).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "validation_failed", done_at: expect.any(String) });
  });
});

describe("lease expiry", () => {
  test("an expired lease requeues the job; its late result gets 409 stale_lease and writes nothing", async () => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    clockAt("2026-10-16T07:00:00.000Z");
    const lease = await claimOne(first);
    expect(lease.lease_expires_at).toBe("2026-10-16T07:10:00.000Z");

    clockAt("2026-10-16T07:10:00.000Z");
    const lines = captureLogs();
    expect(await job(VIDEO)).toMatchObject({
      status: "queued",
      leased_by: null,
      lease_expires_at: null,
      attempts: 1,
      tried_nodes: ["pi-1"],
      last_outcome: "lease_expired",
    });
    expect(lines()).toMatchObject([
      { event: "job.lease_expired", video_id: VIDEO, attrs: { node_id: "pi-1", attempts: 1, status: "queued" } },
    ]);
    expect(await leaseState(lease.lease_id)).toBe("expired");
    expect(await nodeEvents()).toEqual([{ node_id: "pi-1", kind: "lease_expired", video_id: VIDEO }]);

    expect(await claim(first)).toEqual([]);
    const next = await claimOne(second);
    expect(next.video_id).toBe(VIDEO);
    await expectError(await post("/node/result", first, okResult(lease.lease_id)), 409, "stale_lease");
    await expectError(await post("/node/release", first, { lease_id: lease.lease_id }), 409, "stale_lease");
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    expect(await job(VIDEO)).toMatchObject({ status: "leased", leased_by: "pi-2", attempts: 2 });
    expect(await nodeEvents()).toHaveLength(1);
  });

  test("a lease expires exactly at lease_expires_at, not a millisecond before", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    clockAt("2026-10-16T07:00:00.000Z");
    const lease = await claimOne(token);
    clockAt("2026-10-16T07:09:59.999Z");
    expect((await job(VIDEO)).status).toBe("leased");
    clockAt(lease.lease_expires_at);
    expect((await job(VIDEO)).status).toBe("queued");
  });

  test.each([
    ["heartbeat", { version: "0.1.0", uptime_s: 1, jobs_in_progress: 0 }],
    ["claim", {}],
    ["result", { lease_id: "no-such-lease-0000", outcome: "error", transcript: null }],
    ["release", { lease_id: "no-such-lease-0000" }],
  ])("/node/%s runs the sweep", async (endpoint, body) => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    clockAt("2026-10-16T07:00:00.000Z");
    const lease = await claimOne(first);
    clockAt("2026-10-16T08:00:00.000Z");
    await post(`/node/${endpoint}`, second, body);
    expect(await leaseState(lease.lease_id)).toBe("expired");
  });

  test("an expiry on the third attempt gives failed_video", async () => {
    const tokens = [await enroll("pi-1"), await enroll("pi-2"), await enroll("pi-3")];
    await enqueue([VIDEO]);
    let now = Date.parse("2026-10-16T07:00:00.000Z");
    for (const token of tokens) {
      clockAt(new Date(now).toISOString());
      await claimOne(token);
      now += 600_000;
    }
    clockAt(new Date(now).toISOString());
    expect(await job(VIDEO)).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "lease_expired", done_at: expect.any(String) });
  });

  test("with LEASE_SECONDS=1 the lease expires on the real clock", async () => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    const [lease] = parseNodeClaimResponse(await (await post("/node/claim", first, {}, { LEASE_SECONDS: "1" })).json()).jobs;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await claim(second)).map((claimed) => claimed.video_id)).toEqual([VIDEO]);
    await expectError(await post("/node/result", first, okResult(lease.lease_id)), 409, "stale_lease");
  });
});

describe("POST /node/release", () => {
  test("undoes the claim and is idempotent", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO]);
    const before = await job(VIDEO);
    const lease = await claimOne(token);
    const lines = captureLogs();
    const first = await post("/node/release", token, { lease_id: lease.lease_id });
    const body = await first.clone().text();
    expect(await ack(first)).toEqual({ video_id: VIDEO, status: "queued" });
    expect(lines()).toMatchObject([{ event: "job.released", video_id: VIDEO, attrs: { node_id: "pi-1" } }]);
    expect(await job(VIDEO)).toEqual({ ...before, last_outcome: "released" });
    expect(await rows("SELECT state, response_json FROM leases")).toEqual([{ state: "released", response_json: body }]);
    expect(await rows("SELECT lease_id FROM jobs")).toEqual([{ lease_id: null }]);
    expect(await nodeEvents()).toEqual([]);

    const again = await post("/node/release", token, { lease_id: lease.lease_id });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(body);
    expect(await job(VIDEO)).toEqual({ ...before, last_outcome: "released" });

    // The node may take the job again, and its old lease is stale for a result.
    await expectError(await post("/node/result", token, okResult(lease.lease_id)), 409, "stale_lease");
    expect((await claimOne(token)).video_id).toBe(VIDEO);
    expect(await job(VIDEO)).toMatchObject({ attempts: 1, tried_nodes: ["pi-1"] });
  });

  test("keeps the other nodes in tried_nodes", async () => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO]);
    await post("/node/result", first, failure((await claimOne(first)).lease_id, "error"));
    const lease = await claimOne(second);
    await ack(await post("/node/release", second, { lease_id: lease.lease_id }));
    expect(await job(VIDEO)).toMatchObject({ status: "queued", attempts: 1, tried_nodes: ["pi-1"], last_outcome: "released" });
  });

  test("a completed, unknown or rejected lease gives 409 stale_lease", async () => {
    const token = await enroll("pi-1");
    await enqueue([VIDEO, "bbbbbbbbbbb"]);
    const [done, rejected] = await claim(token, 2);
    await ack(await post("/node/result", token, failure(done.lease_id, "no_transcript")));
    await post("/node/result", token, { lease_id: rejected.lease_id, outcome: "ok", transcript: null });
    for (const leaseId of [done.lease_id, rejected.lease_id, "no-such-lease-0000"]) {
      await expectError(await post("/node/release", token, { lease_id: leaseId }), 409, "stale_lease");
    }
    expect((await job(VIDEO)).status).toBe("done");
  });

  test.each([[{}], [{ lease_id: "" }], [{ lease_id: "x", extra: 1 }]])("%j gives 400 invalid_request", async (body) => {
    const token = await enroll("pi-1");
    await expectError(await post("/node/release", token, body), 400, "invalid_request");
  });
});

describe("DELETE /ops/nodes/<node_id>", () => {
  test("disables the node, refuses its token and reassigns its jobs", async () => {
    const [first, second] = [await enroll("pi-1"), await enroll("pi-2")];
    await enqueue([VIDEO, "bbbbbbbbbbb"]);
    const leases = await claim(first, 2);
    const lines = captureLogs();
    const response = await call("/ops/nodes/pi-1", { method: "DELETE", headers: OPS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ node_id: "pi-1", state: "disabled" });
    expect(lines()).toMatchObject([{ event: "node.revoked", attrs: { node_id: "pi-1", leases_revoked: 2 } }]);

    const node = await env.DB.prepare("SELECT state, revoked_at FROM nodes WHERE node_id = 'pi-1'").first<Record<string, string>>();
    expect(node?.state).toBe("disabled");
    expect(node?.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const lease of leases) {
      expect(await leaseState(lease.lease_id)).toBe("revoked");
      expect(await job(lease.video_id)).toMatchObject({ status: "queued", leased_by: null, attempts: 1, last_outcome: "lease_revoked" });
    }

    await expectError(await post("/node/claim", first, {}), 401, "unauthorized");
    await expectError(await post("/node/result", first, okResult(leases[0].lease_id)), 401, "unauthorized");
    await expectError(await post("/node/release", first, { lease_id: leases[0].lease_id }), 401, "unauthorized");
    expect(await env.TRANSCRIPTS.head(`transcripts/${VIDEO}.json`)).toBeNull();
    expect((await claim(second)).map((claimed) => claimed.video_id).sort()).toEqual([VIDEO, "bbbbbbbbbbb"]);
    // The other node's leases are untouched by a second revocation of pi-1.
    const again = await call("/ops/nodes/pi-1", { method: "DELETE", headers: OPS });
    expect(await again.json()).toEqual({ node_id: "pi-1", state: "disabled" });
    expect((await env.DB.prepare("SELECT revoked_at FROM nodes WHERE node_id = 'pi-1'").first<{ revoked_at: string }>())?.revoked_at).toBe(
      node?.revoked_at,
    );
    expect(await job(VIDEO)).toMatchObject({ status: "leased", leased_by: "pi-2" });
  });

  test("a revocation on the third attempt gives failed_video", async () => {
    const tokens = [await enroll("pi-1"), await enroll("pi-2"), await enroll("pi-3")];
    await enqueue([VIDEO]);
    for (const token of tokens.slice(0, 2)) await post("/node/result", token, failure((await claimOne(token)).lease_id, "blocked"));
    await claimOne(tokens[2]);
    await call("/ops/nodes/pi-3", { method: "DELETE", headers: OPS });
    expect(await job(VIDEO)).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "lease_revoked" });
  });

  test("a node without leases is revoked with leases_revoked 0", async () => {
    await enroll("pi-1");
    const lines = captureLogs();
    expect((await call("/ops/nodes/pi-1", { method: "DELETE", headers: OPS })).status).toBe(200);
    expect(lines()).toMatchObject([{ event: "node.revoked", attrs: { node_id: "pi-1", leases_revoked: 0 } }]);
  });

  test("an unknown node gives 404 not_found", async () => {
    await expectError(await call("/ops/nodes/nobody", { method: "DELETE", headers: OPS }), 404, "not_found");
  });

  test("needs the operator bearer", async () => {
    await enroll("pi-1");
    await expectError(await call("/ops/nodes/pi-1", { method: "DELETE" }), 401, "unauthorized");
    expect((await env.DB.prepare("SELECT state FROM nodes").first<{ state: string }>())?.state).toBe("healthy");
  });
});

describe("GET /ops/transcripts/<video_id>", () => {
  test("an unknown transcript gives 404 not_found", async () => {
    await expectError(await call(`/ops/transcripts/${VIDEO}`, { headers: OPS }), 404, "not_found");
  });

  test("needs the operator bearer", async () => {
    await expectError(await call(`/ops/transcripts/${VIDEO}`), 401, "unauthorized");
  });
});
