import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { call, captureLogs, enroll, expectError, OPS } from "./helpers";

// The MCP endpoint (spec/lot-2.md section 11). Access tokens are written to D1 as POST /token writes
// them (its tests are in token.test.ts).

const RESOURCE = "http://worker.test/mcp";
const BOB = "g-bob";
const ACCEPT = "application/json, text/event-stream";

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
  await call("/ops/invites", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
  await env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES (?1, 'bob@test', 'member', ?2)")
    .bind(BOB, new Date().toISOString())
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Stores an access token of bob's, valid one hour from now unless `expiresAt` is given. */
async function seedAccessToken(options: { expiresAt?: string } = {}): Promise<string> {
  const token = `access-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, scope, resource, expires_at)
     VALUES (?1, 'access', 'client-1', ?2, 'family-1', 'digest', ?3, ?4)`,
  )
    .bind(await sha256Hex(token), BOB, RESOURCE, options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return token;
}

function postMcp(body: unknown, headers: Record<string, string> = {}, overrides = {}): Promise<Response> {
  return call(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    overrides,
  );
}

async function rpc(token: string, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await postMcp({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }, {
    Authorization: `Bearer ${token}`,
    ...headers,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  return (await response.json()) as Record<string, unknown>;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

async function expectInvalidToken(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("WWW-Authenticate")).toBe(
    'Bearer resource_metadata="http://worker.test/.well-known/oauth-protected-resource"',
  );
  expect(await response.json()).toMatchObject({ error: "invalid_token" });
}

describe("11.1 authentication", () => {
  test("a valid access token is accepted", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("no token gets 401 with WWW-Authenticate and logs auth.bearer.rejected", async () => {
    const logs = captureLogs();
    await expectInvalidToken(await postMcp(INITIALIZE));
    expect(logs()).toEqual([
      expect.objectContaining({ event: "auth.bearer.rejected", level: "warn", attrs: { surface: "mcp", reason: "missing" } }),
    ]);
  });

  test("an expired access token gets 401", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const token = await seedAccessToken({ expiresAt: "2026-10-16T08:00:00.000Z" });
    expect(await rpc(token, "ping")).toMatchObject({ result: {} });
    vi.setSystemTime(new Date("2026-10-16T08:00:00.000Z"));
    const logs = captureLogs();
    await expectInvalidToken(await postMcp(INITIALIZE, { Authorization: `Bearer ${token}` }));
    expect(logs()).toEqual([expect.objectContaining({ attrs: { surface: "mcp", reason: "expired" } })]);
  });

  test("a node token gets 401", async () => {
    const nodeToken = await enroll("node-1");
    await expectInvalidToken(await postMcp(INITIALIZE, { Authorization: `Bearer ${nodeToken}` }));
  });

  test("the operator token gets 401", async () => {
    const logs = captureLogs();
    await expectInvalidToken(await postMcp(INITIALIZE, OPS));
    expect(logs()).toEqual([expect.objectContaining({ attrs: { surface: "mcp", reason: "unknown" } })]);
  });

  test("the token of a user whose invite was revoked gets 401", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "ping")).toMatchObject({ result: {} });
    await call("/ops/invites/revoke", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
    const logs = captureLogs();
    await expectInvalidToken(await postMcp(INITIALIZE, { Authorization: `Bearer ${token}` }));
    expect(logs()).toEqual([expect.objectContaining({ attrs: { surface: "mcp", reason: "revoked" } })]);
  });

  test("a request without a valid token gets 401 before its method or body is looked at", async () => {
    await expectInvalidToken(await call("/mcp"));
    await expectInvalidToken(await postMcp("not json"));
  });

  test("an access token gets 401 on /node/*", async () => {
    const token = await seedAccessToken();
    const logs = captureLogs();
    const response = await call("/node/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: "1.0.0", jobs_in_progress: 0 }),
    });
    await expectError(response, 401, "unauthorized");
    expect(logs()).toEqual([expect.objectContaining({ attrs: { surface: "node", reason: "unknown" } })]);
  });
});

describe("11.2 origin check", () => {
  test("a foreign Origin gets 403 origin_rejected before authentication, and is logged", async () => {
    const logs = captureLogs();
    await expectError(await postMcp(INITIALIZE, { Origin: "https://evil.test" }), 403, "origin_rejected");
    expect(logs()).toEqual([
      expect.objectContaining({ event: "auth.origin.rejected", level: "warn", attrs: { origin: "https://evil.test" } }),
    ]);
    const token = await seedAccessToken();
    await expectError(await postMcp(INITIALIZE, { Origin: "https://evil.test", Authorization: `Bearer ${token}` }), 403, "origin_rejected");
  });

  test("the origin of BASE passes", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "ping", undefined, { Origin: "http://worker.test" })).toMatchObject({ result: {} });
    await expectInvalidToken(await postMcp(INITIALIZE, { Origin: "http://worker.test" }));
  });

  test("an origin of ALLOWED_ORIGINS passes, others do not", async () => {
    const overrides = { ALLOWED_ORIGINS: "https://a.test, https://b.test:8443," };
    for (const origin of ["https://a.test", "https://b.test:8443"]) {
      await expectInvalidToken(await postMcp(INITIALIZE, { Origin: origin }, overrides));
    }
    for (const origin of ["https://c.test", "https://b.test", "null", ""]) {
      await expectError(await postMcp(INITIALIZE, { Origin: origin }, overrides), 403, "origin_rejected");
    }
  });

  test("a request without Origin passes", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "ping")).toMatchObject({ result: {} });
  });
});

describe("11.1 transport", () => {
  test("initialize answers protocolVersion 2025-06-18, without a session", async () => {
    const token = await seedAccessToken();
    const response = await postMcp(INITIALIZE, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "yt-digest", version: expect.any(String) },
      },
    });
  });

  test("notifications/initialized gets 202 without a body", async () => {
    const token = await seedAccessToken();
    const response = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("a client's JSON-RPC response gets 202 without a body", async () => {
    const token = await seedAccessToken();
    const response = await postMcp({ jsonrpc: "2.0", id: 7, result: {} }, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("ping answers an empty result, with the request's id", async () => {
    const token = await seedAccessToken();
    const response = await postMcp({ jsonrpc: "2.0", id: "abc", method: "ping" }, { Authorization: `Bearer ${token}` });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  test("an unknown method gets the JSON-RPC error -32601", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "resources/list")).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
  });

  test("a body that is not one JSON-RPC 2.0 message gets 400 invalid_request", async () => {
    const token = await seedAccessToken();
    const auth = { Authorization: `Bearer ${token}` };
    for (const body of [
      "not json",
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      { id: 1, method: "ping" },
      { jsonrpc: "2.0", id: true, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: 3 },
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
      { jsonrpc: "2.0", id: 1 },
    ]) {
      await expectError(await postMcp(body, auth), 400, "invalid_request");
    }
  });

  test("a method other than POST gets 404 not_found once authenticated", async () => {
    const token = await seedAccessToken();
    await expectError(await call("/mcp", { headers: { Authorization: `Bearer ${token}` } }), 404, "not_found");
    await expectError(await call("/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }), 404, "not_found");
  });
});

describe("11.3 the tool", () => {
  test("tools/list returns exactly list_subscriptions, with an input schema without properties", async () => {
    const token = await seedAccessToken();
    const body = (await rpc(token, "tools/list")) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["list_subscriptions"]);
    expect(body.result.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("tools/call of list_subscriptions returns {\"subscriptions\":[]} and logs mcp.tool.call", async () => {
    const token = await seedAccessToken();
    const logs = captureLogs();
    expect(await rpc(token, "tools/call", { name: "list_subscriptions", arguments: {} })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: '{"subscriptions":[]}' }], isError: false },
    });
    expect(logs()).toEqual([
      expect.objectContaining({
        event: "mcp.tool.call",
        level: "info",
        attrs: { tool: "list_subscriptions", outcome: "ok", duration_ms: expect.any(Number) },
      }),
    ]);
  });

  test("tools/call of an unknown tool gets the JSON-RPC error -32602 and logs outcome error", async () => {
    const token = await seedAccessToken();
    const logs = captureLogs();
    expect(await rpc(token, "tools/call", { name: "admin_reset" })).toMatchObject({ error: { code: -32602 } });
    expect(logs()).toEqual([expect.objectContaining({ event: "mcp.tool.call", attrs: expect.objectContaining({ outcome: "error" }) })]);
  });

  test("tools/call without a tool name gets the JSON-RPC error -32602", async () => {
    const token = await seedAccessToken();
    expect(await rpc(token, "tools/call", {})).toMatchObject({ error: { code: -32602 } });
  });
});
