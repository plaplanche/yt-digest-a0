import { expect, test } from "@playwright/test";
import { claim, enqueue, enroll, job, leaseMs, nodeHeaders, okResult, ops, reset, transcript } from "./nodes";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

// E2E-14.
test("a lease expires: the job goes to another node, the first node's late result gets 409", async ({ request }) => {
  const [first, second] = [await enroll(request, "node-a"), await enroll(request, "node-b")];
  await enqueue(request, ["e2eExpire01"]);
  const [lease] = await claim(request, first, 1);
  expect(await claim(request, second, 1)).toEqual([]);

  await new Promise((resolve) => setTimeout(resolve, leaseMs + 500));
  const [next] = await claim(request, second, 1);
  expect(next.video_id).toBe("e2eExpire01");
  expect(await job(request, "e2eExpire01")).toMatchObject({ status: "leased", leased_by: "node-b", attempts: 2, tried_nodes: ["node-a", "node-b"] });

  const late = await request.post("/node/result", { headers: nodeHeaders(first), data: okResult(lease) });
  expect(late.status()).toBe(409);
  expect(await late.json()).toMatchObject({ error: { code: "stale_lease" } });
  expect((await request.get("/ops/transcripts/e2eExpire01", { headers: ops })).status()).toBe(404);

  const result = await request.post("/node/result", { headers: nodeHeaders(second), data: okResult(next) });
  expect(await result.json()).toEqual({ video_id: "e2eExpire01", status: "done" });
  expect(await (await request.get("/ops/transcripts/e2eExpire01", { headers: ops })).json()).toMatchObject({ node_id: "node-b" });
});

// E2E-16 (reduced).
test("unavailable on 3 nodes: failed_video, a 4th node gets nothing", async ({ request }) => {
  const tokens = await Promise.all(["node-a", "node-b", "node-c", "node-d"].map((nodeId) => enroll(request, nodeId)));
  await enqueue(request, ["e2eFailed01"]);
  for (const [index, token] of tokens.slice(0, 3).entries()) {
    const [lease] = await claim(request, token, 1);
    const result = await request.post("/node/result", {
      headers: nodeHeaders(token),
      data: { lease_id: lease.lease_id, outcome: "unavailable", transcript: null },
    });
    expect(await result.json()).toEqual({ video_id: "e2eFailed01", status: index === 2 ? "failed_video" : "queued" });
  }
  expect(await job(request, "e2eFailed01")).toMatchObject({
    status: "failed_video",
    attempts: 3,
    tried_nodes: ["node-a", "node-b", "node-c"],
    last_outcome: "unavailable",
  });
  expect(await claim(request, tokens[3], 10)).toEqual([]);
});

// E2E-20.
test("a revoked node: claim and result refused, its job reassigned", async ({ request }) => {
  const [first, second] = [await enroll(request, "node-a"), await enroll(request, "node-b")];
  await enqueue(request, ["e2eRevoke01"]);
  const [lease] = await claim(request, first, 1);

  const revoked = await request.delete("/ops/nodes/node-a", { headers: ops });
  expect(await revoked.json()).toEqual({ node_id: "node-a", state: "disabled" });
  expect(await job(request, "e2eRevoke01")).toMatchObject({ status: "queued", leased_by: null, last_outcome: "lease_revoked" });

  const refusedClaim = await request.post("/node/claim", { headers: nodeHeaders(first), data: {} });
  expect(refusedClaim.status()).toBe(401);
  expect(await refusedClaim.json()).toMatchObject({ error: { code: "unauthorized" } });
  const refusedResult = await request.post("/node/result", { headers: nodeHeaders(first), data: okResult(lease) });
  expect(refusedResult.status()).toBe(401);
  expect((await request.get("/ops/transcripts/e2eRevoke01", { headers: ops })).status()).toBe(404);

  const [next] = await claim(request, second, 1);
  expect(next.video_id).toBe("e2eRevoke01");
  expect(await job(request, "e2eRevoke01")).toMatchObject({ status: "leased", leased_by: "node-b", tried_nodes: ["node-a", "node-b"] });
});

// E2E-21.
test("/node/* responses hold no user data", async ({ request }) => {
  const token = await enroll(request, "node-a");
  await enqueue(request, ["e2eNoData01", "e2eNoData02"]);
  const bodies: unknown[] = [];
  const send = async (path: string, data: unknown): Promise<Record<string, unknown>> => {
    const response = await request.post(path, { headers: nodeHeaders(token), data });
    const body = (await response.json()) as Record<string, unknown>;
    bodies.push(body);
    return body;
  };

  expect(Object.keys(await send("/node/heartbeat", { version: "0.1.0", uptime_s: 1, jobs_in_progress: 0 })).sort()).toEqual([
    "directive",
    "hourly_budget",
    "node_id",
    "state",
  ]);
  const claimed = (await send("/node/claim", { max_jobs: 2 })) as unknown as { jobs: { video_id: string; lease_id: string }[] };
  expect(Object.keys(claimed)).toEqual(["jobs"]);
  for (const leased of claimed.jobs) expect(Object.keys(leased).sort()).toEqual(["lease_expires_at", "lease_id", "video_id"]);
  const [done, released] = claimed.jobs;
  const result = { lease_id: done.lease_id, outcome: "ok", transcript: transcript(done.video_id) };
  expect(Object.keys(await send("/node/result", result)).sort()).toEqual(["status", "video_id"]);
  expect(Object.keys(await send("/node/result", result)).sort()).toEqual(["status", "video_id"]);
  expect(Object.keys(await send("/node/release", { lease_id: released.lease_id })).sort()).toEqual(["status", "video_id"]);
  expect(Object.keys(await send("/node/release", { lease_id: done.lease_id }))).toEqual(["error"]);

  // No transcript text, user e-mail or token comes back.
  const text = JSON.stringify(bodies);
  expect(text).not.toContain("Words of");
  expect(text).not.toContain("@");
  expect(text).not.toContain(token);
});
