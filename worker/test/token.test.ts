import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { checkAccessToken } from "../src/token";
import { call, captureLogs, enroll, OPS } from "./helpers";

// The token endpoint and the access token check (spec/lot-2.md sections 10.5 and 10.6). Codes are
// written to D1 as the callback writes them (its tests are in oauth.test.ts).

const RESOURCE = "http://worker.test/mcp";
const REDIRECT = "https://client.example/cb";
const VERIFIER = "dBjftJeZ4CVP-mJ92K1qW7Cm4gYWvGw3x2a1kZ8xQcE";
const BOB = "g-bob";
const ALICE = "g-alice";

interface Tokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

let clientId: string;

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
  clientId = await registerClient();
  await call("/ops/invites", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES (?1, 'bob@test', 'member', ?2)").bind(
      BOB,
      new Date().toISOString(),
    ),
    env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES (?1, 'alice@test', 'admin', ?2)").bind(
      ALICE,
      new Date().toISOString(),
    ),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function registerClient(): Promise<string> {
  const response = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Stores an authorization code as the callback does, valid 60 s from now unless `expiresAt` is given. */
async function seedCode(options: { userSub?: string; client?: string; expiresAt?: string } = {}): Promise<string> {
  const code = `code-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'digest', ?6, ?7)`,
  )
    .bind(
      await sha256Hex(code),
      options.client ?? clientId,
      options.userSub ?? BOB,
      REDIRECT,
      await challengeOf(VERIFIER),
      RESOURCE,
      options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
  return code;
}

function postToken(form: Record<string, string | null>, contentType = "application/x-www-form-urlencoded"): Promise<Response> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(form)) if (value !== null) params.set(name, value);
  return call("/token", { method: "POST", headers: { "Content-Type": contentType }, body: params.toString() });
}

function codeForm(code: string, changes: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...changes,
  };
}

function refreshForm(refreshToken: string, changes: Record<string, string | null> = {}): Record<string, string | null> {
  return { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...changes };
}

async function expectOAuthError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(((await response.json()) as { error: string }).error).toBe(error);
}

async function expectTokens(response: Response): Promise<Tokens> {
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

/** A first token pair, from a fresh code of Bob's. */
async function tokens(): Promise<Tokens> {
  return expectTokens(await postToken(codeForm(await seedCode())));
}

async function tokenRows(): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare("SELECT * FROM oauth_tokens ORDER BY kind, expires_at").all()).results;
}

describe("10.5 grant_type=authorization_code", () => {
  test("a valid exchange issues an access and refresh token pair, stored hashed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const code = await seedCode();
    const logs = captureLogs();
    const response = await postToken(codeForm(code));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Tokens;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "digest" });
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.access_token).not.toBe(body.refresh_token);

    const rows = await tokenRows();
    expect(rows).toEqual([
      {
        token_hash: await sha256Hex(body.access_token),
        kind: "access",
        client_id: clientId,
        user_sub: BOB,
        family_id: expect.any(String),
        scope: "digest",
        resource: RESOURCE,
        expires_at: "2026-10-16T08:00:00.000Z",
        used_at: null,
        revoked_at: null,
      },
      {
        token_hash: await sha256Hex(body.refresh_token),
        kind: "refresh",
        client_id: clientId,
        user_sub: BOB,
        family_id: rows[0].family_id,
        scope: "digest",
        resource: RESOURCE,
        expires_at: "2026-11-15T07:00:00.000Z",
        used_at: null,
        revoked_at: null,
      },
    ]);
    expect(logs().filter((line) => line.event === "auth.token.issued")).toEqual([
      expect.objectContaining({ level: "info", attrs: { client_id: clientId, grant_type: "authorization_code" } }),
    ]);
    const text = JSON.stringify(logs());
    for (const secret of [code, body.access_token, body.refresh_token, BOB, "bob@test"]) expect(text).not.toContain(secret);
  });

  test("the token lifetimes follow ACCESS_TOKEN_TTL_SECONDS and REFRESH_TOKEN_TTL_SECONDS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const code = await seedCode();
    const response = await call(
      "/token",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(codeForm(code) as Record<string, string>).toString() },
      { ACCESS_TOKEN_TTL_SECONDS: "60", REFRESH_TOKEN_TTL_SECONDS: "120" },
    );
    expect(((await response.json()) as Tokens).expires_in).toBe(60);
    expect((await tokenRows()).map((row) => row.expires_at)).toEqual(["2026-10-16T07:01:00.000Z", "2026-10-16T07:02:00.000Z"]);
  });

  test("a form-encoded Content-Type with a charset is accepted", async () => {
    await expectTokens(await postToken(codeForm(await seedCode()), "application/x-www-form-urlencoded; charset=UTF-8"));
  });

  test.each([
    ["JSON", "application/json"],
    ["plain text", "text/plain"],
    ["multipart", "multipart/form-data; boundary=x"],
  ])("a %s body gives 400 invalid_request", async (_, contentType) => {
    const code = await seedCode();
    await expectOAuthError(await postToken(codeForm(code), contentType), 400, "invalid_request");
    await expectTokens(await postToken(codeForm(code)));
  });

  test("a JSON body of valid parameters gives 400 invalid_request", async () => {
    const response = await call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(codeForm(await seedCode())),
    });
    await expectOAuthError(response, 400, "invalid_request");
  });

  test("a body without Content-Type gives 400 invalid_request", async () => {
    const body = new URLSearchParams(codeForm(await seedCode()) as Record<string, string>).toString();
    const response = await call("/token", { method: "POST", body: new TextEncoder().encode(body) });
    await expectOAuthError(response, 400, "invalid_request");
  });

  test.each([
    ["another", "password"],
    ["a missing", null],
  ])("%s grant_type gives 400 unsupported_grant_type, before the client", async (_, grantType) => {
    await expectOAuthError(await postToken(codeForm("x", { grant_type: grantType })), 400, "unsupported_grant_type");
    await expectOAuthError(
      await postToken(codeForm("x", { grant_type: grantType, client_id: "unknown" })),
      400,
      "unsupported_grant_type",
    );
  });

  test.each([
    ["an unknown", "unknown-client"],
    ["a missing", null],
  ])("%s client_id gives 401 invalid_client, before the missing parameters", async (_, id) => {
    await expectOAuthError(await postToken(codeForm(await seedCode(), { client_id: id })), 401, "invalid_client");
    await expectOAuthError(await postToken({ grant_type: "authorization_code", client_id: id }), 401, "invalid_client");
  });

  test.each(["code", "redirect_uri", "code_verifier", "resource"])(
    "a missing or empty %s gives 400 invalid_request, before the resource, without using the code",
    async (name) => {
      const code = await seedCode();
      await expectOAuthError(await postToken(codeForm(code, { [name]: null })), 400, "invalid_request");
      await expectOAuthError(await postToken(codeForm(code, { [name]: "" })), 400, "invalid_request");
      if (name !== "resource") {
        const response = await postToken(codeForm(code, { [name]: null, resource: "https://evil.test/mcp" }));
        await expectOAuthError(response, 400, "invalid_request");
      }
      await expectTokens(await postToken(codeForm(code)));
    },
  );

  test.each([
    ["another origin", "https://evil.test/mcp"],
    ["a trailing slash", `${RESOURCE}/`],
    ["the base", "http://worker.test"],
  ])("a resource with %s gives 400 invalid_target, without using the code", async (_, resource) => {
    const code = await seedCode();
    await expectOAuthError(await postToken(codeForm(code, { resource })), 400, "invalid_target");
    await expectTokens(await postToken(codeForm(code)));
  });

  test("an unknown code gives 400 invalid_grant", async () => {
    await expectOAuthError(await postToken(codeForm("not-a-code")), 400, "invalid_grant");
  });

  test("a code already used gives 400 invalid_grant", async () => {
    const code = await seedCode();
    await expectTokens(await postToken(codeForm(code)));
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
    expect(await tokenRows()).toHaveLength(2);
  });

  test("a wrong code_verifier gives 400 invalid_grant and uses the code up", async () => {
    const code = await seedCode();
    await expectOAuthError(await postToken(codeForm(code, { code_verifier: `${VERIFIER}x` })), 400, "invalid_grant");
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
    expect(await tokenRows()).toEqual([]);
  });

  test("the challenge itself as verifier (plain) gives 400 invalid_grant", async () => {
    const code = await seedCode();
    await expectOAuthError(await postToken(codeForm(code, { code_verifier: await challengeOf(VERIFIER) })), 400, "invalid_grant");
  });

  test("a code expires at its expires_at, and is used up by the attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const code = await seedCode({ expiresAt: "2026-10-16T07:01:00.000Z" });
    const early = await seedCode({ expiresAt: "2026-10-16T07:01:00.000Z" });
    vi.setSystemTime(new Date("2026-10-16T07:00:59.999Z"));
    await expectTokens(await postToken(codeForm(early)));
    vi.setSystemTime(new Date("2026-10-16T07:01:00.000Z"));
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
    vi.setSystemTime(new Date("2026-10-16T07:00:30.000Z"));
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
  });

  test("a code issued to another client gives 400 invalid_grant and is used up", async () => {
    const other = await registerClient();
    const code = await seedCode({ client: other });
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
    await expectOAuthError(await postToken(codeForm(code, { client_id: other })), 400, "invalid_grant");
  });

  test("a code issued for another redirect_uri gives 400 invalid_grant and is used up", async () => {
    const code = await seedCode();
    await expectOAuthError(await postToken(codeForm(code, { redirect_uri: `${REDIRECT}/other` })), 400, "invalid_grant");
    await expectOAuthError(await postToken(codeForm(code)), 400, "invalid_grant");
  });

  test("each code starts its own family", async () => {
    await tokens();
    await tokens();
    const families = new Set((await tokenRows()).map((row) => row.family_id));
    expect(families.size).toBe(2);
  });

  test("another method on /token gives 404 not_found", async () => {
    const response = await call("/token");
    expect(response.status).toBe(404);
  });
});

describe("10.5 grant_type=refresh_token", () => {
  test("a refresh rotates both tokens; earlier access tokens stay valid", async () => {
    const first = await tokens();
    const logs = captureLogs();
    const response = await postToken(refreshForm(first.refresh_token));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const second = await expectTokens(response);
    expect(second).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "digest" });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const third = await expectTokens(await postToken(refreshForm(second.refresh_token, { resource: RESOURCE })));

    const rows = await tokenRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.family_id)).size).toBe(1);
    const usedHashes = rows.filter((row) => row.used_at !== null).map((row) => row.token_hash);
    expect(usedHashes.sort()).toEqual([await sha256Hex(first.refresh_token), await sha256Hex(second.refresh_token)].sort());
    for (const pair of [first, second, third]) {
      expect(await checkAccessToken(env, pair.access_token)).toMatchObject({ valid: true });
    }
    expect(logs().filter((line) => line.event === "auth.token.issued")).toEqual([
      expect.objectContaining({ attrs: { client_id: clientId, grant_type: "refresh_token" } }),
      expect.objectContaining({ attrs: { client_id: clientId, grant_type: "refresh_token" } }),
    ]);
  });

  test("a refreshed refresh token gets a new lifetime from its own issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const first = await tokens();
    vi.setSystemTime(new Date("2026-10-17T07:00:00.000Z"));
    const second = await expectTokens(await postToken(refreshForm(first.refresh_token)));
    const row = await env.DB.prepare("SELECT expires_at FROM oauth_tokens WHERE token_hash = ?1")
      .bind(await sha256Hex(second.refresh_token))
      .first();
    expect(row).toEqual({ expires_at: "2026-11-16T07:00:00.000Z" });
  });

  test("the reuse of a used refresh token gives invalid_grant and revokes its family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const first = await tokens();
    const second = await expectTokens(await postToken(refreshForm(first.refresh_token)));
    const otherFamily = await tokens();
    vi.setSystemTime(new Date("2026-10-16T07:05:00.000Z"));
    const logs = captureLogs();

    await expectOAuthError(await postToken(refreshForm(first.refresh_token)), 400, "invalid_grant");
    const familyId = (await tokenRows()).find((row) => row.used_at !== null)?.family_id;
    const rows = await tokenRows();
    expect(rows.filter((row) => row.family_id === familyId).map((row) => row.revoked_at)).toEqual(
      Array(4).fill("2026-10-16T07:05:00.000Z"),
    );
    expect(rows.filter((row) => row.family_id !== familyId).map((row) => row.revoked_at)).toEqual([null, null]);
    expect(logs().filter((line) => line.event === "auth.refresh.reuse_detected")).toEqual([
      expect.objectContaining({ attrs: { client_id: clientId, revoked: 4 } }),
    ]);

    for (const pair of [first, second]) {
      expect(await checkAccessToken(env, pair.access_token)).toEqual({ valid: false, reason: "revoked" });
    }
    await expectOAuthError(await postToken(refreshForm(second.refresh_token)), 400, "invalid_grant");
    expect(await checkAccessToken(env, otherFamily.access_token)).toMatchObject({ valid: true });
    await expectTokens(await postToken(refreshForm(otherFamily.refresh_token)));
  });

  test("presenting a token of a revoked family again does not log a second reuse", async () => {
    const first = await tokens();
    await expectTokens(await postToken(refreshForm(first.refresh_token)));
    await expectOAuthError(await postToken(refreshForm(first.refresh_token)), 400, "invalid_grant");
    const logs = captureLogs();
    await expectOAuthError(await postToken(refreshForm(first.refresh_token)), 400, "invalid_grant");
    expect(logs().filter((line) => line.event === "auth.refresh.reuse_detected")).toEqual([]);
  });

  test("an unknown refresh token gives 400 invalid_grant", async () => {
    await expectOAuthError(await postToken(refreshForm("not-a-token")), 400, "invalid_grant");
  });

  test("an access token used as refresh token gives 400 invalid_grant", async () => {
    const pair = await tokens();
    await expectOAuthError(await postToken(refreshForm(pair.access_token)), 400, "invalid_grant");
  });

  test("a refresh token expires at its expires_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const pair = await tokens();
    const other = await tokens();
    vi.setSystemTime(new Date("2026-11-15T07:00:00.000Z"));
    await expectOAuthError(await postToken(refreshForm(pair.refresh_token)), 400, "invalid_grant");
    vi.setSystemTime(new Date("2026-11-15T06:59:59.999Z"));
    await expectTokens(await postToken(refreshForm(other.refresh_token)));
  });

  test("a refresh token issued to another client gives 400 invalid_grant and stays usable", async () => {
    const pair = await tokens();
    const other = await registerClient();
    await expectOAuthError(await postToken(refreshForm(pair.refresh_token, { client_id: other })), 400, "invalid_grant");
    await expectTokens(await postToken(refreshForm(pair.refresh_token)));
  });

  test("an unknown client gives 401 invalid_client", async () => {
    const pair = await tokens();
    await expectOAuthError(await postToken(refreshForm(pair.refresh_token, { client_id: "unknown" })), 401, "invalid_client");
  });

  test("a missing refresh_token gives 400 invalid_request", async () => {
    await expectOAuthError(await postToken(refreshForm("", { refresh_token: null })), 400, "invalid_request");
  });

  test("a resource other than BASE/mcp gives 400 invalid_target and keeps the token", async () => {
    const pair = await tokens();
    await expectOAuthError(
      await postToken(refreshForm(pair.refresh_token, { resource: "https://evil.test/mcp" })),
      400,
      "invalid_target",
    );
    await expectTokens(await postToken(refreshForm(pair.refresh_token)));
  });
});

describe("10.6 accepting an access token", () => {
  test("a valid access token is accepted, with its user, client and role", async () => {
    const pair = await tokens();
    expect(await checkAccessToken(env, pair.access_token)).toEqual({
      valid: true,
      userSub: BOB,
      clientId,
      role: "member",
    });
  });

  test("the admin's token is accepted without an invite", async () => {
    const pair = await expectTokens(await postToken(codeForm(await seedCode({ userSub: ALICE }))));
    expect(await checkAccessToken(env, pair.access_token)).toMatchObject({ valid: true, userSub: ALICE, role: "admin" });
  });

  test("an access token expires at its expires_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const pair = await tokens();
    vi.setSystemTime(new Date("2026-10-16T07:59:59.999Z"));
    expect(await checkAccessToken(env, pair.access_token)).toMatchObject({ valid: true });
    vi.setSystemTime(new Date("2026-10-16T08:00:00.000Z"));
    expect(await checkAccessToken(env, pair.access_token)).toEqual({ valid: false, reason: "expired" });
  });

  test("a revoked access token is refused", async () => {
    const pair = await tokens();
    await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ?1").bind(new Date().toISOString()).run();
    expect(await checkAccessToken(env, pair.access_token)).toEqual({ valid: false, reason: "revoked" });
  });

  test("a refresh token is refused", async () => {
    const pair = await tokens();
    expect(await checkAccessToken(env, pair.refresh_token)).toEqual({ valid: false, reason: "unknown" });
  });

  test("a node token and the operator token are refused", async () => {
    const nodeToken = await enroll("node-1");
    expect(await checkAccessToken(env, nodeToken)).toEqual({ valid: false, reason: "unknown" });
    expect(await checkAccessToken(env, env.OPS_TOKEN ?? "")).toEqual({ valid: false, reason: "unknown" });
  });

  test("an unknown token is refused", async () => {
    expect(await checkAccessToken(env, "not-a-token")).toEqual({ valid: false, reason: "unknown" });
  });

  test("a token for another resource is refused", async () => {
    const pair = await tokens();
    await env.DB.prepare("UPDATE oauth_tokens SET resource = 'https://other.test/mcp'").run();
    expect(await checkAccessToken(env, pair.access_token)).toEqual({ valid: false, reason: "unknown" });
  });

  test("revoking the user's invite refuses the token at once; re-inviting accepts it again", async () => {
    const pair = await tokens();
    expect(await checkAccessToken(env, pair.access_token)).toMatchObject({ valid: true });
    const revoke = await call("/ops/invites/revoke", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
    expect(revoke.status).toBe(200);
    expect(await checkAccessToken(env, pair.access_token)).toEqual({ valid: false, reason: "revoked" });
    await call("/ops/invites", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
    expect(await checkAccessToken(env, pair.access_token)).toMatchObject({ valid: true });
  });
});
