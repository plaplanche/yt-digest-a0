import { expect, test } from "@playwright/test";

const mocksUrl = `http://127.0.0.1:${process.env.MOCKS_PORT ?? "8789"}`;
const opsToken = process.env.OPS_TOKEN ?? "ops-local";

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/ops/reset", { headers: { Authorization: `Bearer ${opsToken}` } });
  expect(reset.status()).toBe(200);
});

test("the Worker answers /health", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(body).toEqual({ status: "ok", version: expect.any(String) });
});

test("the mocks server answers /health", async ({ request }) => {
  const response = await request.get(`${mocksUrl}/health`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("the mock SponsorBlock has no segment for any video", async ({ request }) => {
  const response = await request.get(`${mocksUrl}/sponsorblock/api/skipSegments?videoID=dQw4w9WgXcQ`);
  expect(response.status()).toBe(404);
  expect(await response.text()).toBe("Not Found");
});
