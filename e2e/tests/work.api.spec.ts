import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { enqueue, enroll, job, ops, reset } from "./nodes";

// The node daemon of spec/lot-2.md section 9 against the stack.

const run = promisify(execFile);
const nodeProject = fileURLToPath(new URL("../../node", import.meta.url));
const workerUrl = `http://127.0.0.1:${process.env.WORKER_PORT ?? "8787"}`;
const mocksUrl = `http://127.0.0.1:${process.env.MOCKS_PORT ?? "8789"}`;

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("yt-digest-node work --once processes a queued fixture video", async ({ request }) => {
  // The first run may install the node's environment.
  test.setTimeout(300_000);
  const token = await enroll(request, "node-a");
  await enqueue(request, ["sponsorVid1"]);

  const { stderr } = await run("uv", ["run", "--locked", "--project", nodeProject, "yt-digest-node", "work", "--once"], {
    env: {
      ...process.env,
      WORKER_URL: workerUrl,
      NODE_TOKEN: token,
      FETCHER_FAKE_YTDLP: "1",
      FAKE_YTDLP_DIR: `${nodeProject}/tests/fixtures/fake_ytdlp`,
      SPONSORBLOCK_URL: `${mocksUrl}/sponsorblock`,
      TRANSCRIPT_LANGS: "fr,en",
    },
  });
  expect(stderr).not.toContain(token);

  const stored = await request.get("/ops/transcripts/sponsorVid1", { headers: ops });
  expect(stored.status()).toBe(200);
  expect(await stored.json()).toMatchObject({
    video_id: "sponsorVid1",
    node_id: "node-a",
    transcript: { video_id: "sponsorVid1", status: "ok", lang: "fr", source: "manual", sponsor_ratio: 0, truncated: false },
  });
  expect(await job(request, "sponsorVid1")).toMatchObject({ status: "done", last_outcome: "ok", attempts: 1 });
});
