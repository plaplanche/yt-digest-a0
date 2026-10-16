import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TABLES } from "../src/ops";
import { call, expectError } from "./helpers";

const OPS = { Authorization: `Bearer ${env.OPS_TOKEN ?? ""}` };

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLogs(): () => Record<string, unknown>[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

/** One row in every table of 6.3. */
async function fill(): Promise<void> {
  const t = "2026-10-16T07:00:00.000Z";
  await env.DB.batch(
    [
      `INSERT INTO nodes (node_id, owner_label, token_hash, state, state_since, created_at) VALUES ('n1', 'o', 'h', 'healthy', '${t}', '${t}')`,
      `INSERT INTO jobs (video_id, kind, status, created_at) VALUES ('dQw4w9WgXcQ', 'primary', 'queued', '${t}')`,
      `INSERT INTO leases (lease_id, video_id, node_id, issued_at, expires_at, state) VALUES ('l1', 'dQw4w9WgXcQ', 'n1', '${t}', '${t}', 'active')`,
      `INSERT INTO node_events (node_id, ts, kind, video_id) VALUES ('n1', '${t}', 'job_ok', 'dQw4w9WgXcQ')`,
      `INSERT INTO invites (email, invited_at) VALUES ('bob@test', '${t}')`,
      `INSERT INTO users (user_sub, email, role, created_at) VALUES ('g-1', 'alice@test', 'admin', '${t}')`,
      `INSERT INTO oauth_clients (client_id, redirect_uris, created_at) VALUES ('c1', '[]', '${t}')`,
      `INSERT INTO oauth_requests (request_id, client_id, redirect_uri, code_challenge, google_state, google_nonce, expires_at) VALUES ('r1', 'c1', 'u', 'c', 's', 'n', '${t}')`,
      `INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, expires_at) VALUES ('h1', 'c1', 'g-1', 'u', 'c', '${t}')`,
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, expires_at) VALUES ('h1', 'access', 'c1', 'g-1', 'f1', '${t}')`,
    ].map((sql) => env.DB.prepare(sql)),
  );
}

describe("operator authentication", () => {
  const cases: [string, Record<string, string>][] = [
    ["no Authorization header", {}],
    ["a wrong bearer", { Authorization: "Bearer wrong-token" }],
    ["a bearer one character longer", { Authorization: `Bearer ${env.OPS_TOKEN ?? ""}x` }],
    ["the token without the Bearer scheme", { Authorization: env.OPS_TOKEN ?? "" }],
    ["another scheme", { Authorization: `Basic ${env.OPS_TOKEN ?? ""}` }],
    ["an empty bearer", { Authorization: "Bearer " }],
  ];

  test.each(cases)("%s gives 401 unauthorized and resets nothing", async (_, headers) => {
    await fill();
    await expectError(await call("/ops/reset", { method: "POST", headers }), 401, "unauthorized");
    expect(await count("nodes")).toBe(1);
    await call("/ops/reset", { method: "POST", headers: OPS });
  });

  test.each([
    ["no body", undefined],
    ["a JSON body", '{"ok": true}'],
    ["a body that is not JSON", "{not json"],
  ])("authentication comes before the body: %s gives 401", async (_, body) => {
    const response = await call("/ops/reset", { method: "POST", body, headers: { Authorization: "Bearer wrong" } });
    await expectError(response, 401, "unauthorized");
  });

  test("an unknown /ops route gives 401 without the bearer, 404 with it", async () => {
    await expectError(await call("/ops/nope"), 401, "unauthorized");
    await expectError(await call("/ops/nope", { headers: OPS }), 404, "not_found");
    await expectError(await call("/ops/reset", { headers: OPS }), 404, "not_found");
  });

  test.each([[""], [undefined]])("OPS_TOKEN %j: every /ops/* request gives 404 not_found", async (token) => {
    await fill();
    for (const headers of [{}, OPS, { Authorization: "Bearer " }]) {
      const response = await call("/ops/reset", { method: "POST", headers }, { OPS_TOKEN: token });
      await expectError(response, 404, "not_found");
    }
    expect(await count("nodes")).toBe(1);
    await call("/ops/reset", { method: "POST", headers: OPS });
  });

  test("a rejection is logged without the token", async () => {
    const lines = captureLogs();
    await call("/ops/reset", { method: "POST" });
    await call("/ops/reset", { method: "POST", headers: { Authorization: "Bearer secret-guess" } });
    expect(lines()).toMatchObject([
      { event: "auth.bearer.rejected", service: "worker", attrs: { surface: "ops", reason: "missing" } },
      { event: "auth.bearer.rejected", service: "worker", attrs: { surface: "ops", reason: "unknown" } },
    ]);
    expect(JSON.stringify(lines())).not.toContain("secret-guess");
  });
});

describe("POST /ops/reset", () => {
  test("empties every table and every R2 object under transcripts/", async () => {
    await fill();
    for (const table of TABLES) expect(await count(table)).toBe(1);
    await env.TRANSCRIPTS.put("transcripts/dQw4w9WgXcQ.json", "{}");
    await env.TRANSCRIPTS.put("transcripts/aaaaaaaaaaa.json", "{}");
    await env.TRANSCRIPTS.put("other/kept.json", "{}");

    const response = await call("/ops/reset", { method: "POST", headers: OPS });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });

    for (const table of TABLES) expect(await count(table)).toBe(0);
    expect((await env.TRANSCRIPTS.list({ prefix: "transcripts/" })).objects).toEqual([]);
    expect(await env.TRANSCRIPTS.head("other/kept.json")).not.toBeNull();
    await env.TRANSCRIPTS.delete("other/kept.json");
  });

  test("on an empty database and bucket, and with a body", async () => {
    const response = await call("/ops/reset", { method: "POST", headers: OPS, body: "ignored" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
