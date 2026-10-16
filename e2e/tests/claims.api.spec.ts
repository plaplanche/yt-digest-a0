import { expect, test, type APIRequestContext } from "@playwright/test";

const opsToken = process.env.OPS_TOKEN ?? "ops-local";
const ops = { Authorization: `Bearer ${opsToken}` };

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/ops/reset", { headers: ops });
  expect(reset.status()).toBe(200);
});

async function enroll(request: APIRequestContext, nodeId: string): Promise<string> {
  const response = await request.post("/ops/nodes", { headers: ops, data: { node_id: nodeId, owner_label: nodeId } });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function claim(request: APIRequestContext, token: string, maxJobs: number): Promise<string[]> {
  const response = await request.post("/node/claim", {
    headers: { Authorization: `Bearer ${token}` },
    data: { max_jobs: maxJobs },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { jobs: { video_id: string }[] };
  return body.jobs.map((job) => job.video_id);
}

// E2E-13 (reduced): the results come with the next ticket.
test("2 nodes claim 6 jobs concurrently: each job is handed out once", async ({ request }) => {
  const tokens = await Promise.all([enroll(request, "node-a"), enroll(request, "node-b")]);
  const ids = ["e2eJob00001", "e2eJob00002", "e2eJob00003", "e2eJob00004", "e2eJob00005", "e2eJob00006"];
  const enqueued = await request.post("/ops/jobs", { headers: ops, data: { video_ids: ids } });
  expect(await enqueued.json()).toEqual({ enqueued: ids, existing: [] });

  // Both nodes claim 2 jobs at a time, at once, until neither gets any.
  const handed: Record<string, string[]> = { "node-a": [], "node-b": [] };
  for (;;) {
    const [a, b] = await Promise.all(tokens.map((token) => claim(request, token, 2)));
    handed["node-a"].push(...a);
    handed["node-b"].push(...b);
    if (a.length === 0 && b.length === 0) break;
  }
  const all = [...handed["node-a"], ...handed["node-b"]];
  expect(all).toHaveLength(6);
  expect([...all].sort()).toEqual(ids);

  for (const [nodeId, videoIds] of Object.entries(handed)) {
    for (const videoId of videoIds) {
      const job = await request.get(`/ops/jobs/${videoId}`, { headers: ops });
      expect(await job.json()).toMatchObject({ status: "leased", leased_by: nodeId, attempts: 1, tried_nodes: [nodeId] });
    }
  }
});
