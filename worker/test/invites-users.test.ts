import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { call, expectError, OPS } from "./helpers";

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
});

async function post(path: string, body: unknown): Promise<Response> {
  return call(path, { method: "POST", headers: OPS, body: JSON.stringify(body) });
}

async function inviteRow(email: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM invites WHERE email = ?1").bind(email).first();
}

describe("POST /ops/invites", () => {
  test("stores the invite lowercased", async () => {
    const response = await post("/ops/invites", { email: "Bob@Test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ email: "bob@test", revoked: false });
    expect(await inviteRow("bob@test")).toMatchObject({ email: "bob@test", revoked: 0, accepted_user_sub: null });
    expect(await inviteRow("Bob@Test")).toBeNull();
  });

  test("inviting again re-activates a revoked invite and keeps its invited_at", async () => {
    await post("/ops/invites", { email: "bob@test" });
    const first = await inviteRow("bob@test");
    expect(await (await post("/ops/invites/revoke", { email: "bob@test" })).json()).toEqual({
      email: "bob@test",
      revoked: true,
    });
    expect(await inviteRow("bob@test")).toMatchObject({ revoked: 1 });
    const again = await post("/ops/invites", { email: "BOB@test" });
    expect(await again.json()).toEqual({ email: "bob@test", revoked: false });
    expect(await inviteRow("bob@test")).toEqual(first);
  });

  test.each([
    ["not JSON", "{nope"],
    ["no email", "{}"],
    ["an email without @", '{"email": "bob"}'],
    ["an email that is not a string", '{"email": 1}'],
    ["an unknown field", '{"email": "bob@test", "role": "admin"}'],
  ])("%s gives 400 invalid_request", async (_, body) => {
    await expectError(await call("/ops/invites", { method: "POST", headers: OPS, body }), 400, "invalid_request");
  });

  test("needs the operator bearer", async () => {
    await expectError(await call("/ops/invites", { method: "POST", body: '{"email": "bob@test"}' }), 401, "unauthorized");
    expect(await inviteRow("bob@test")).toBeNull();
  });
});

describe("POST /ops/invites/revoke", () => {
  test("revokes an invite, whatever the case of the e-mail", async () => {
    await post("/ops/invites", { email: "bob@test" });
    const response = await post("/ops/invites/revoke", { email: "Bob@TEST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "bob@test", revoked: true });
    expect(await inviteRow("bob@test")).toMatchObject({ revoked: 1 });
  });

  test("revoking again answers the same", async () => {
    await post("/ops/invites", { email: "bob@test" });
    await post("/ops/invites/revoke", { email: "bob@test" });
    const response = await post("/ops/invites/revoke", { email: "bob@test" });
    expect(await response.json()).toEqual({ email: "bob@test", revoked: true });
  });

  test("an unknown invite gives 404 not_found", async () => {
    await expectError(await post("/ops/invites/revoke", { email: "mallory@test" }), 404, "not_found");
    expect(await inviteRow("mallory@test")).toBeNull();
  });

  test("a body without email gives 400 invalid_request", async () => {
    await expectError(await post("/ops/invites/revoke", {}), 400, "invalid_request");
  });
});

describe("GET /ops/users", () => {
  test("no user gives an empty list", async () => {
    const response = await call("/ops/users", { headers: OPS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: [] });
  });

  test("lists the users sorted by e-mail", async () => {
    const t = "2026-10-16T07:00:00.000Z";
    await env.DB.batch(
      [
        ["g-3", "carol@test", "member"],
        ["g-1", "alice@test", "admin"],
        ["g-2", "bob@test", "member"],
      ].map(([sub, email, role]) =>
        env.DB.prepare(
          "INSERT INTO users (user_sub, email, role, google_refresh_token_enc, created_at) VALUES (?1, ?2, ?3, 'v1:x', ?4)",
        ).bind(sub, email, role, t),
      ),
    );
    const response = await call("/ops/users", { headers: OPS });
    expect(await response.json()).toEqual({
      users: [
        { user_sub: "g-1", email: "alice@test", role: "admin" },
        { user_sub: "g-2", email: "bob@test", role: "member" },
        { user_sub: "g-3", email: "carol@test", role: "member" },
      ],
    });
  });

  test("needs the operator bearer, and only GET", async () => {
    await expectError(await call("/ops/users"), 401, "unauthorized");
    await expectError(await call("/ops/users", { method: "POST", headers: OPS }), 404, "not_found");
  });
});
