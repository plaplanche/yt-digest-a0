import { expect, test } from "@playwright/test";
import { enroll, nodeHeaders, ops, reset } from "./nodes";
import { exchangeCode, expectInvalidToken, logIn, postMcp, registerClient, resource } from "./oauth";

// E2E-27, E2E-33 and E2E-37 of spec/lot-2.md section 13: the MCP endpoint refuses every bearer but a
// valid access token (sections 10.6 and 11).

const ping = { id: 1, method: "ping" };
const heartbeatBody = { version: "0.1.0", uptime_s: 1, jobs_in_progress: 0 };

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("E2E-27: /mcp without a token gets 401 and WWW-Authenticate pointing to consistent discovery documents", async ({ request }) => {
  const response = await postMcp(request, null, ping);
  await expectInvalidToken(response);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(response.headers()["www-authenticate"])?.[1] ?? "";
  const metadata = (await (await request.get(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
  expect(metadata.resource).toBe(resource);
  const [issuer] = metadata.authorization_servers;
  const server = (await (await request.get(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(server).toMatchObject({ issuer, registration_endpoint: `${issuer}/register`, token_endpoint: `${issuer}/token` });
});

test("a foreign Origin gets 403 origin_rejected, even with a valid token", async ({ request }) => {
  const clientId = await registerClient(request);
  const { code, verifier } = await logIn(request, clientId, "alice@test");
  const { access_token } = await exchangeCode(request, clientId, code, verifier);
  const response = await postMcp(request, access_token, ping, { Origin: "https://evil.test" });
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
  expect((await postMcp(request, access_token, ping)).status()).toBe(200);
});

test("E2E-33: revoking the invite refuses the user's valid access token at once", async ({ request }) => {
  expect((await request.post("/ops/invites", { headers: ops, data: { email: "bob@test" } })).status()).toBe(200);
  const clientId = await registerClient(request);
  const { code, verifier } = await logIn(request, clientId, "bob@test");
  const { access_token } = await exchangeCode(request, clientId, code, verifier);
  const before = await postMcp(request, access_token, ping);
  expect(await before.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect((await request.post("/ops/invites/revoke", { headers: ops, data: { email: "bob@test" } })).status()).toBe(200);
  await expectInvalidToken(await postMcp(request, access_token, ping));
});

test("E2E-37: a node token on /mcp and an access token on /node/* are refused", async ({ request }) => {
  const nodeToken = await enroll(request, "node-1");
  await expectInvalidToken(await postMcp(request, nodeToken, ping));
  await expectInvalidToken(await postMcp(request, ops.Authorization.slice("Bearer ".length), ping));

  const clientId = await registerClient(request);
  const { code, verifier } = await logIn(request, clientId, "alice@test");
  const { access_token } = await exchangeCode(request, clientId, code, verifier);
  const heartbeat = await request.post("/node/heartbeat", { headers: nodeHeaders(access_token), data: heartbeatBody });
  expect(heartbeat.status()).toBe(401);
  expect(await heartbeat.json()).toMatchObject({ error: { code: "unauthorized" } });
  expect((await request.post("/node/heartbeat", { headers: nodeHeaders(nodeToken), data: heartbeatBody })).status()).toBe(200);
});
