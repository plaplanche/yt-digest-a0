import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseNodeClaimResponse } from "../src/contracts/node-claim-response";
import { parseNodeHeartbeatResponse } from "../src/contracts/node-heartbeat-response";
import { sha256Hex } from "../src/crypto";
import { call, expectError } from "./helpers";

const OPS = { Authorization: `Bearer ${env.OPS_TOKEN ?? ""}` };

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLogs(): () => Record<string, unknown>[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

/** `count` distinct valid video ids, `prefix` padded to 11 characters. */
function videoIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(11 - prefix.length, "0")}`);
}

async function enroll(nodeId: string): Promise<string> {
  const response = await call("/ops/nodes", {
    method: "POST",
    headers: OPS,
    body: JSON.stringify({ node_id: nodeId, owner_label: `owner of ${nodeId}` }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function enqueue(ids: string[], priority?: number): Promise<{ enqueued: string[]; existing: string[] }> {
  const response = await call("/ops/jobs", {
    method: "POST",
    headers: OPS,
    body: JSON.stringify(priority === undefined ? { video_ids: ids } : { video_ids: ids, priority }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { enqueued: string[]; existing: string[] };
}

async function job(videoId: string): Promise<Record<string, unknown>> {
  const response = await call(`/ops/jobs/${videoId}`, { headers: OPS });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function claimRequest(token: string, body: unknown = {}): Promise<Response> {
  return call("/node/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

async function claim(token: string, body: unknown = {}): Promise<string[]> {
  const response = await claimRequest(token, body);
  expect(response.status).toBe(200);
  return parseNodeClaimResponse(await response.json()).jobs.map((claimed) => claimed.video_id);
}

const HEARTBEAT = { version: "0.1.0", uptime_s: 12, jobs_in_progress: 1 };

describe("POST /ops/nodes", () => {
  test("enrolls a healthy node and shows its token once, storing only its SHA-256", async () => {
    const lines = captureLogs();
    const response = await call("/ops/nodes", {
      method: "POST",
      headers: OPS,
      body: JSON.stringify({ node_id: "pi-1", owner_label: "Alice's Pi" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["node_id", "owner_label", "token"]);
    expect(body).toMatchObject({ node_id: "pi-1", owner_label: "Alice's Pi" });
    expect(body.token).toMatch(/^ytd_node_[A-Za-z0-9_-]{43}$/);

    const row = await env.DB.prepare("SELECT * FROM nodes WHERE node_id = 'pi-1'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ state: "healthy", token_hash: await sha256Hex(body.token), hourly_budget: 60, revoked_at: null });
    expect(JSON.stringify(row)).not.toContain(body.token);
    expect(lines()).toMatchObject([{ event: "node.enrolled", attrs: { node_id: "pi-1" } }]);
    expect(JSON.stringify(lines())).not.toContain(body.token);
  });

  test("each node gets a different token", async () => {
    expect(await enroll("a")).not.toBe(await enroll("b"));
  });

  test("an existing node_id gives 409 conflict and keeps the first token", async () => {
    const token = await enroll("pi-1");
    const response = await call("/ops/nodes", {
      method: "POST",
      headers: OPS,
      body: JSON.stringify({ node_id: "pi-1", owner_label: "other" }),
    });
    await expectError(response, 409, "conflict");
    expect((await call("/node/heartbeat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(HEARTBEAT) })).status).toBe(200);
  });

  test.each([
    ["no owner_label", { node_id: "pi-1" }],
    ["an empty owner_label", { node_id: "pi-1", owner_label: "" }],
    ["an owner_label of 101 characters", { node_id: "pi-1", owner_label: "x".repeat(101) }],
    ["an upper-case node_id", { node_id: "Pi-1", owner_label: "o" }],
    ["a node_id starting with -", { node_id: "-pi", owner_label: "o" }],
    ["a node_id of 64 characters", { node_id: "a".repeat(64), owner_label: "o" }],
    ["an extra field", { node_id: "pi-1", owner_label: "o", state: "healthy" }],
    ["an array", []],
  ])("%s gives 400 invalid_request", async (_, body) => {
    await expectError(await call("/ops/nodes", { method: "POST", headers: OPS, body: JSON.stringify(body) }), 400, "invalid_request");
  });

  test("the limits of node_id and owner_label are accepted", async () => {
    for (const [node_id, owner_label] of [["a".repeat(63), "x".repeat(100)], ["0", "é"]]) {
      const response = await call("/ops/nodes", { method: "POST", headers: OPS, body: JSON.stringify({ node_id, owner_label }) });
      expect(response.status).toBe(200);
    }
  });

  test("needs the operator bearer before the body", async () => {
    await expectError(await call("/ops/nodes", { method: "POST", body: "{not json" }), 401, "unauthorized");
  });
});

describe("POST /ops/jobs and GET /ops/jobs/<video_id>", () => {
  test("enqueues new ids as queued jobs, in request order", async () => {
    const lines = captureLogs();
    expect(await enqueue(["bbbbbbbbbbb", "aaaaaaaaaaa"], 5)).toEqual({ enqueued: ["bbbbbbbbbbb", "aaaaaaaaaaa"], existing: [] });
    expect(lines()).toMatchObject([{ event: "job.enqueued", attrs: { count: 2, priority: 5 } }]);
    const shown = await job("aaaaaaaaaaa");
    expect(shown).toEqual({
      video_id: "aaaaaaaaaaa",
      kind: "primary",
      priority: 5,
      status: "queued",
      leased_by: null,
      lease_expires_at: null,
      attempts: 0,
      tried_nodes: [],
      last_outcome: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      done_at: null,
    });
  });

  test("the priority defaults to 0", async () => {
    await enqueue(["aaaaaaaaaaa"]);
    expect((await job("aaaaaaaaaaa")).priority).toBe(0);
  });

  test("an existing job is kept and its priority only goes up", async () => {
    await enqueue(["aaaaaaaaaaa"], 5);
    const before = await job("aaaaaaaaaaa");
    expect(await enqueue(["aaaaaaaaaaa", "bbbbbbbbbbb"], 2)).toEqual({ enqueued: ["bbbbbbbbbbb"], existing: ["aaaaaaaaaaa"] });
    expect(await job("aaaaaaaaaaa")).toEqual(before);
    expect(await enqueue(["aaaaaaaaaaa"], 9)).toEqual({ enqueued: [], existing: ["aaaaaaaaaaa"] });
    expect(await job("aaaaaaaaaaa")).toEqual({ ...before, priority: 9 });
  });

  test("an existing leased job keeps its lease and status", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa"]);
    await claim(token);
    const before = await job("aaaaaaaaaaa");
    await enqueue(["aaaaaaaaaaa"], 3);
    expect(await job("aaaaaaaaaaa")).toEqual({ ...before, priority: 3 });
  });

  test("an id repeated in one request is enqueued once", async () => {
    expect(await enqueue(["aaaaaaaaaaa", "aaaaaaaaaaa"])).toEqual({ enqueued: ["aaaaaaaaaaa"], existing: ["aaaaaaaaaaa"] });
  });

  test("100 ids are accepted", async () => {
    expect((await enqueue(videoIds("v", 100))).enqueued).toHaveLength(100);
  });

  test.each([
    ["no video_ids", {}],
    ["an empty list", { video_ids: [] }],
    ["101 ids", { video_ids: videoIds("v", 101) }],
    ["an id of 10 characters", { video_ids: ["aaaaaaaaaa"] }],
    ["an id with a dot", { video_ids: ["aaaaaaaaaa."] }],
    ["a negative priority", { video_ids: ["aaaaaaaaaaa"], priority: -1 }],
    ["a fractional priority", { video_ids: ["aaaaaaaaaaa"], priority: 1.5 }],
    ["a null priority", { video_ids: ["aaaaaaaaaaa"], priority: null }],
    ["an extra field", { video_ids: ["aaaaaaaaaaa"], kind: "primary" }],
  ])("%s gives 400 invalid_request and enqueues nothing", async (_, body) => {
    await expectError(await call("/ops/jobs", { method: "POST", headers: OPS, body: JSON.stringify(body) }), 400, "invalid_request");
    await expectError(await call("/ops/jobs/aaaaaaaaaaa", { headers: OPS }), 404, "not_found");
  });

  test("an unknown job gives 404 not_found", async () => {
    await expectError(await call("/ops/jobs/zzzzzzzzzzz", { headers: OPS }), 404, "not_found");
  });

  test("needs the operator bearer", async () => {
    await expectError(await call("/ops/jobs", { method: "POST", body: "{}" }), 401, "unauthorized");
    await expectError(await call("/ops/jobs/aaaaaaaaaaa"), 401, "unauthorized");
  });
});

describe("node authentication", () => {
  test.each([
    ["no bearer", () => ({})],
    ["an unknown token", () => ({ Authorization: "Bearer ytd_node_unknownunknownunknownunknownunknownunkno" })],
    ["the operator token", () => OPS],
  ])("%s gives 401 unauthorized on /node/claim and claims nothing", async (_, headers) => {
    await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa"]);
    const response = await call("/node/claim", { method: "POST", headers: headers(), body: "{}" });
    await expectError(response, 401, "unauthorized");
    expect((await job("aaaaaaaaaaa")).status).toBe("queued");
  });

  test("a revoked node's token gives 401", async () => {
    const token = await enroll("pi-1");
    await env.DB.prepare("UPDATE nodes SET state = 'disabled', revoked_at = '2026-10-16T07:00:00.000Z'").run();
    await expectError(await claimRequest(token), 401, "unauthorized");
  });

  test("authentication comes before the body", async () => {
    await expectError(await call("/node/heartbeat", { method: "POST", body: "{not json" }), 401, "unauthorized");
  });

  test("each rejection is logged with its reason, without the token", async () => {
    const token = await enroll("pi-1");
    await env.DB.prepare("UPDATE nodes SET state = 'disabled', revoked_at = '2026-10-16T07:00:00.000Z'").run();
    const lines = captureLogs();
    await call("/node/claim", { method: "POST", body: "{}" });
    await call("/node/claim", { method: "POST", headers: { Authorization: "Bearer guessed-secret" }, body: "{}" });
    await claimRequest(token);
    expect(lines()).toMatchObject([
      { event: "auth.bearer.rejected", level: "warn", attrs: { surface: "node", reason: "missing" } },
      { event: "auth.bearer.rejected", level: "warn", attrs: { surface: "node", reason: "unknown" } },
      { event: "auth.bearer.rejected", level: "warn", attrs: { surface: "node", reason: "revoked" } },
    ]);
    expect(JSON.stringify(lines())).not.toContain("guessed-secret");
    expect(JSON.stringify(lines())).not.toContain(token);
  });

  test.each([
    ["GET", "/node/claim"],
    ["POST", "/node/unknown"],
  ])("%s %s gives 404 not_found", async (method, path) => {
    await expectError(await call(path, { method }), 404, "not_found");
  });
});

describe("POST /node/heartbeat", () => {
  test("records the heartbeat and answers healthy, run, 60", async () => {
    const token = await enroll("pi-1");
    const lines = captureLogs();
    const response = await call("/node/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...HEARTBEAT, cpu_temp_c: 48.5, last_success_at: null }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = parseNodeHeartbeatResponse(await response.json());
    expect(body).toEqual({ node_id: "pi-1", state: "healthy", hourly_budget: 60, directive: "run" });

    const row = await env.DB.prepare("SELECT last_heartbeat_at, version FROM nodes WHERE node_id = 'pi-1'").first<Record<string, string>>();
    expect(row?.version).toBe("0.1.0");
    expect(Math.abs(Date.parse(row?.last_heartbeat_at ?? "") - Date.now())).toBeLessThan(5000);
    expect(lines()).toMatchObject([
      { event: "node.heartbeat", attrs: { node_id: "pi-1", version: "0.1.0", jobs_in_progress: 1 } },
    ]);
  });

  test("answers the node's hourly_budget", async () => {
    const token = await enroll("pi-1");
    await env.DB.prepare("UPDATE nodes SET hourly_budget = 7").run();
    const response = await call("/node/heartbeat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(HEARTBEAT) });
    expect(((await response.json()) as { hourly_budget: number }).hourly_budget).toBe(7);
  });

  test.each([
    ["a missing version", { uptime_s: 1, jobs_in_progress: 0 }],
    ["an extra field", { ...HEARTBEAT, node_id: "other" }],
    ["a disk_free_ratio above 1", { ...HEARTBEAT, disk_free_ratio: 1.5 }],
    ["a body that is not JSON", "{"],
  ])("%s gives 400 invalid_request and records nothing", async (_, body) => {
    const token = await enroll("pi-1");
    const response = await call("/node/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    await expectError(response, 400, "invalid_request");
    const row = await env.DB.prepare("SELECT last_heartbeat_at FROM nodes").first<{ last_heartbeat_at: string | null }>();
    expect(row?.last_heartbeat_at).toBeNull();
  });
});

describe("POST /node/claim", () => {
  test("an empty queue gives no job", async () => {
    const token = await enroll("pi-1");
    const response = await claimRequest(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ jobs: [] });
  });

  test("without max_jobs it takes 3", async () => {
    const token = await enroll("pi-1");
    await enqueue(videoIds("v", 5));
    expect(await claim(token)).toHaveLength(3);
  });

  test("it takes max_jobs jobs, or all eligible ones when fewer", async () => {
    const token = await enroll("pi-1");
    await enqueue(videoIds("v", 12));
    expect(await claim(token, { max_jobs: 1 })).toHaveLength(1);
    expect(await claim(token, { max_jobs: 10 })).toHaveLength(10);
    expect(await claim(token, { max_jobs: 10 })).toHaveLength(1);
    expect(await claim(token, { max_jobs: 10 })).toEqual([]);
  });

  test.each([[{ max_jobs: 0 }], [{ max_jobs: 11 }], [{ max_jobs: 2.5 }], [{ max_jobs: "3" }], [{ other: 1 }], [[]]])(
    "%j gives 400 invalid_request and leases nothing",
    async (body) => {
      const token = await enroll("pi-1");
      await enqueue(["aaaaaaaaaaa"]);
      await expectError(await claimRequest(token, body), 400, "invalid_request");
      expect((await job("aaaaaaaaaaa")).status).toBe("queued");
    },
  );

  test("orders by priority descending, then creation, then video id", async () => {
    const token = await enroll("pi-1");
    await enqueue(["ccccccccccc", "Bbbbbbbbbbb"], 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueue(["aaaaaaaaaaa"], 1);
    await enqueue(["zzzzzzzzzzz"], 4);
    await enqueue(["yyyyyyyyyyy"], 0);
    expect(await claim(token, { max_jobs: 10 })).toEqual(["zzzzzzzzzzz", "Bbbbbbbbbbb", "ccccccccccc", "aaaaaaaaaaa", "yyyyyyyyyyy"]);
  });

  test("the highest-priority jobs are the ones taken", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa", "bbbbbbbbbbb"], 0);
    await enqueue(["ccccccccccc"], 2);
    expect(await claim(token, { max_jobs: 1 })).toEqual(["ccccccccccc"]);
  });

  test("a claimed job is leased, with attempts 1, the node in tried_nodes and an active lease", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa"]);
    const lines = captureLogs();
    const before = Date.now();
    const response = await claimRequest(token);
    const [claimed] = parseNodeClaimResponse(await response.json()).jobs;
    expect(claimed.video_id).toBe("aaaaaaaaaaa");
    expect(claimed.lease_id.length).toBeGreaterThanOrEqual(16);
    const expires = Date.parse(claimed.lease_expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 600_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 600_000);

    expect(await job("aaaaaaaaaaa")).toMatchObject({
      status: "leased",
      leased_by: "pi-1",
      lease_expires_at: claimed.lease_expires_at,
      attempts: 1,
      tried_nodes: ["pi-1"],
    });
    const lease = await env.DB.prepare("SELECT * FROM leases").all<Record<string, unknown>>();
    expect(lease.results).toEqual([
      {
        lease_id: claimed.lease_id,
        video_id: "aaaaaaaaaaa",
        node_id: "pi-1",
        issued_at: expect.any(String),
        expires_at: claimed.lease_expires_at,
        state: "active",
        response_json: null,
      },
    ]);
    const row = await env.DB.prepare("SELECT lease_id FROM jobs").first<{ lease_id: string }>();
    expect(row?.lease_id).toBe(claimed.lease_id);
    expect(lines()).toMatchObject([
      { event: "job.claimed", video_id: "aaaaaaaaaaa", attrs: { node_id: "pi-1", attempt: 1, lease_seconds: 600 } },
    ]);
  });

  test("the lease lasts LEASE_SECONDS", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa"]);
    const before = Date.now();
    const response = await call(
      "/node/claim",
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" },
      { LEASE_SECONDS: "2" },
    );
    const [claimed] = parseNodeClaimResponse(await response.json()).jobs;
    const expires = Date.parse(claimed.lease_expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 2000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 2000);
  });

  test("each lease id is different", async () => {
    const token = await enroll("pi-1");
    await enqueue(videoIds("v", 10));
    const response = await claimRequest(token, { max_jobs: 10 });
    const leases = parseNodeClaimResponse(await response.json()).jobs.map((claimed) => claimed.lease_id);
    expect(new Set(leases).size).toBe(10);
  });

  test("a node already in tried_nodes is not given the job; another node is", async () => {
    const first = await enroll("pi-1");
    const second = await enroll("pi-2");
    await enqueue(["aaaaaaaaaaa"]);
    await env.DB.prepare(`UPDATE jobs SET attempts = 1, tried_nodes = '["pi-1"]'`).run();
    expect(await claim(first)).toEqual([]);
    expect(await claim(second)).toEqual(["aaaaaaaaaaa"]);
    expect(await job("aaaaaaaaaaa")).toMatchObject({ attempts: 2, tried_nodes: ["pi-1", "pi-2"], leased_by: "pi-2" });
  });

  test("leased, done and failed_video jobs are not handed out", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
    await env.DB.prepare("UPDATE jobs SET status = 'leased' WHERE video_id = 'aaaaaaaaaaa'").run();
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE video_id = 'bbbbbbbbbbb'").run();
    await env.DB.prepare("UPDATE jobs SET status = 'failed_video' WHERE video_id = 'ccccccccccc'").run();
    expect(await claim(token)).toEqual([]);
  });

  test("the response holds only video ids and leases", async () => {
    const token = await enroll("pi-1");
    await enqueue(["aaaaaaaaaaa"]);
    const body = (await (await claimRequest(token)).json()) as { jobs: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["jobs"]);
    expect(Object.keys(body.jobs[0]).sort()).toEqual(["lease_expires_at", "lease_id", "video_id"]);
  });
});

describe("concurrent claims on the local D1", () => {
  test("no job is handed out twice and each claim gets min(max_jobs, eligible jobs)", async () => {
    const nodes = ["n-1", "n-2", "n-3", "n-4", "n-5"];
    const tokens = await Promise.all(nodes.map((nodeId) => enroll(nodeId)));
    const ids = videoIds("c", 22);
    await enqueue(ids);

    // 5 nodes claim 3 jobs each at once, twice: 30 asked for 22 jobs.
    const handed: string[] = [];
    const sizes: number[] = [];
    for (let round = 0; round < 2; round += 1) {
      const claims = await Promise.all(tokens.map((token) => claim(token)));
      for (const claimed of claims) {
        handed.push(...claimed);
        sizes.push(claimed.length);
      }
    }
    expect(handed).toHaveLength(22);
    expect(new Set(handed).size).toBe(22);
    expect([...handed].sort()).toEqual([...ids].sort());
    // A claim never comes back short while eligible jobs remain: 7 full claims, one of 1, then empty ones.
    expect([...sizes].sort((a, b) => b - a)).toEqual([3, 3, 3, 3, 3, 3, 3, 1, 0, 0]);

    const leases = await env.DB.prepare("SELECT video_id, node_id FROM leases").all<{ video_id: string; node_id: string }>();
    expect(leases.results).toHaveLength(22);
    expect(new Set(leases.results.map((lease) => lease.video_id)).size).toBe(22);
    for (const lease of leases.results) {
      expect(await job(lease.video_id)).toMatchObject({ status: "leased", attempts: 1, leased_by: lease.node_id, tried_nodes: [lease.node_id] });
    }
  });

  test("many concurrent claims of one job hand it out once", async () => {
    const tokens = await Promise.all(["n-1", "n-2", "n-3", "n-4", "n-5", "n-6"].map((nodeId) => enroll(nodeId)));
    await enqueue(["aaaaaaaaaaa"]);
    const claims = await Promise.all(tokens.map((token) => claim(token, { max_jobs: 10 })));
    expect(claims.flat()).toEqual(["aaaaaaaaaaa"]);
    const leases = await env.DB.prepare("SELECT COUNT(*) AS n FROM leases").first<{ n: number }>();
    expect(leases?.n).toBe(1);
  });
});
