import { expect, test } from "@playwright/test";
import { claim, enqueue, enroll, job, nodeHeaders, okResult, ops, reset, type Lease } from "./nodes";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

// E2E-13 (reduced).
test("2 nodes claim 6 jobs concurrently: each job is handed out once, and all 6 end done", async ({ request }) => {
  const nodes = ["node-a", "node-b"];
  const tokens = await Promise.all(nodes.map((nodeId) => enroll(request, nodeId)));
  const ids = ["e2eJob00001", "e2eJob00002", "e2eJob00003", "e2eJob00004", "e2eJob00005", "e2eJob00006"];
  await enqueue(request, ids);

  // Both nodes claim 2 jobs at a time, at once, and send their results, until neither gets any.
  const handed: Record<string, Lease[]> = { "node-a": [], "node-b": [] };
  for (;;) {
    const claims = await Promise.all(tokens.map((token) => claim(request, token, 2)));
    if (claims.every((leases) => leases.length === 0)) break;
    await Promise.all(
      claims.map(async (leases, index) => {
        handed[nodes[index]].push(...leases);
        for (const lease of leases) {
          const result = await request.post("/node/result", { headers: nodeHeaders(tokens[index]), data: okResult(lease) });
          expect(result.status()).toBe(200);
          expect(await result.json()).toEqual({ video_id: lease.video_id, status: "done" });
        }
      }),
    );
  }
  const all = [...handed["node-a"], ...handed["node-b"]].map((lease) => lease.video_id);
  expect(all).toHaveLength(6);
  expect([...all].sort()).toEqual(ids);

  for (const [nodeId, leases] of Object.entries(handed)) {
    for (const lease of leases) {
      expect(await job(request, lease.video_id)).toMatchObject({ status: "done", attempts: 1, tried_nodes: [nodeId], last_outcome: "ok" });
      const stored = await request.get(`/ops/transcripts/${lease.video_id}`, { headers: ops });
      expect(await stored.json()).toMatchObject({ video_id: lease.video_id, node_id: nodeId, lease_id: lease.lease_id });
    }
  }
});
