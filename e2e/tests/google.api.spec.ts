import { createHash, createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

// The fake Google OpenID Connect provider of the mocks server (spec/lot-2.md section 5.3).

const issuer = `http://127.0.0.1:${process.env.MOCKS_PORT ?? "8789"}/google`;
const clientId = process.env.GOOGLE_CLIENT_ID ?? "yt-digest-local";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "local-google-secret";
const redirectUri = "http://127.0.0.1:8787/callback";

const authorizeParams = {
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
  state: "state-<&\">",
  nonce: "nonce-1",
};

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token: string;
  refresh_token?: string;
}

function subjectOf(email: string): string {
  return `g-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
}

/** Signs in at `/google/authorize` with `login_hint` and returns the redirect's query. */
async function signIn(request: APIRequestContext, params: Record<string, string>): Promise<URLSearchParams> {
  const response = await request.get(`${issuer}/authorize`, { params, maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const location = new URL(response.headers()["location"]);
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  return location.searchParams;
}

async function exchange(request: APIRequestContext, form: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await request.post(`${issuer}/token`, { form });
  return { status: response.status(), body: await response.json() };
}

function codeForm(code: string): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  };
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("the discovery document", async ({ request }) => {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
});

test.describe("GET /google/authorize", () => {
  for (const [name, change] of [
    ["a wrong client_id", { client_id: "other" }],
    ["a scope without openid", { scope: "email" }],
    ["a response_type other than code", { response_type: "token" }],
  ] as const) {
    test(`${name} gives 400`, async ({ request }) => {
      const response = await request.get(`${issuer}/authorize`, {
        params: { ...authorizeParams, ...change, login_hint: "bob@test" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(400);
      expect(response.headers()["content-type"]).toContain("text/plain");
    });
  }

  test("a missing redirect_uri gives 400", async ({ request }) => {
    const params: Record<string, string> = { ...authorizeParams };
    delete params.redirect_uri;
    const response = await request.get(`${issuer}/authorize`, { params, maxRedirects: 0 });
    expect(response.status()).toBe(400);
  });

  test("without login_hint, a sign-in form repeats every parameter", async ({ request }) => {
    const params = { ...authorizeParams, access_type: "offline", prompt: "consent" };
    const response = await request.get(`${issuer}/authorize`, { params });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('<form method="get" action="/google/authorize">');
    expect(html).toContain('<input type="text" name="login_hint">');
    expect(html).toMatch(/<button type="submit">/);
    const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    for (const [name, value] of Object.entries(params)) {
      expect(html).toContain(`<input type="hidden" name="${name}" value="${escape(value)}">`);
    }
  });

  test("with login_hint, redirects with a code and the state", async ({ request }) => {
    const query = await signIn(request, { ...authorizeParams, login_hint: "bob@test" });
    expect(query.get("code")).toMatch(/.{16,}/);
    expect(query.get("state")).toBe(authorizeParams.state);
  });
});

test.describe("POST /google/token", () => {
  test("the code gives an ID token signed with the JWKS key, with the claims of 5.3", async ({ request }) => {
    const query = await signIn(request, { ...authorizeParams, login_hint: "Bob@Test" });
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await exchange(request, codeForm(query.get("code") ?? ""));
    expect(status).toBe(200);
    const tokens = body as TokenResponse;
    expect(tokens).toEqual({
      access_token: expect.any(String),
      token_type: "Bearer",
      expires_in: 3600,
      scope: authorizeParams.scope,
      id_token: expect.any(String),
    });

    const [header, payload, signature] = tokens.id_token.split(".");
    const jwks = (await (await request.get(`${issuer}/jwks`)).json()) as { keys: (JsonWebKey & { kid: string })[] };
    expect(jwks.keys).toHaveLength(1);
    const [jwk] = jwks.keys;
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: expect.any(String) });
    expect(decodePart(header)).toMatchObject({ alg: "RS256", kid: jwk.kid });
    const key = createPublicKey({ key: jwk, format: "jwk" });
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const verified = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(key, signature, "base64url");
    expect(verified).toBe(true);

    const claims = decodePart(payload);
    expect(claims).toEqual({
      iss: issuer,
      aud: clientId,
      sub: subjectOf("bob@test"),
      email: "bob@test",
      email_verified: true,
      iat: expect.any(Number),
      exp: expect.any(Number),
      nonce: "nonce-1",
    });
    expect(claims.iat as number).toBeGreaterThanOrEqual(before - 1);
    expect(claims.exp).toBe((claims.iat as number) + 3600);
  });

  test("without a nonce, the ID token has none", async ({ request }) => {
    const params: Record<string, string> = { ...authorizeParams, login_hint: "alice@test" };
    delete params.nonce;
    const query = await signIn(request, params);
    const { body } = await exchange(request, codeForm(query.get("code") ?? ""));
    const claims = decodePart((body as TokenResponse).id_token.split(".")[1]);
    expect(claims).not.toHaveProperty("nonce");
    expect(claims.sub).toBe(subjectOf("alice@test"));
  });

  test("the code is single use", async ({ request }) => {
    const code = (await signIn(request, { ...authorizeParams, login_hint: "bob@test" })).get("code") ?? "";
    expect((await exchange(request, codeForm(code))).status).toBe(200);
    expect(await exchange(request, codeForm(code))).toEqual({ status: 400, body: { error: "invalid_grant" } });
  });

  test("an unknown code or another redirect_uri gives invalid_grant", async ({ request }) => {
    expect(await exchange(request, codeForm("unknown"))).toEqual({ status: 400, body: { error: "invalid_grant" } });
    const code = (await signIn(request, { ...authorizeParams, login_hint: "bob@test" })).get("code") ?? "";
    const other = await exchange(request, { ...codeForm(code), redirect_uri: "http://127.0.0.1:8787/other" });
    expect(other).toEqual({ status: 400, body: { error: "invalid_grant" } });
  });

  test("a wrong client secret gives 401 invalid_client", async ({ request }) => {
    const code = (await signIn(request, { ...authorizeParams, login_hint: "bob@test" })).get("code") ?? "";
    expect(await exchange(request, { ...codeForm(code), client_secret: "wrong" })).toEqual({
      status: 401,
      body: { error: "invalid_client" },
    });
    const basic = Buffer.from(`${clientId}:wrong`).toString("base64");
    const response = await request.post(`${issuer}/token`, {
      form: { grant_type: "authorization_code", code, redirect_uri: redirectUri },
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client" });
  });

  test("HTTP Basic client authentication is accepted", async ({ request }) => {
    const code = (await signIn(request, { ...authorizeParams, login_hint: "bob@test" })).get("code") ?? "";
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await request.post(`${issuer}/token`, {
      form: { grant_type: "authorization_code", code, redirect_uri: redirectUri },
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(response.status()).toBe(200);
  });

  test("access_type=offline adds a refresh token, which gives new tokens", async ({ request }) => {
    const query = await signIn(request, { ...authorizeParams, access_type: "offline", login_hint: "bob@test" });
    const { body } = await exchange(request, codeForm(query.get("code") ?? ""));
    const tokens = body as TokenResponse;
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const refreshed = await exchange(request, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(refreshed.status).toBe(200);
    const next = refreshed.body as TokenResponse;
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(decodePart(next.id_token.split(".")[1]).sub).toBe(subjectOf("bob@test"));

    const unknown = await exchange(request, {
      grant_type: "refresh_token",
      refresh_token: "unknown",
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(unknown).toEqual({ status: 400, body: { error: "invalid_grant" } });
  });

  test("an unknown grant type gives invalid_grant", async ({ request }) => {
    const result = await exchange(request, { grant_type: "password", client_id: clientId, client_secret: clientSecret });
    expect(result).toEqual({ status: 400, body: { error: "invalid_grant" } });
  });
});

test("userinfo answers for its access token only", async ({ request }) => {
  const query = await signIn(request, { ...authorizeParams, login_hint: "bob@test" });
  const tokens = (await exchange(request, codeForm(query.get("code") ?? ""))).body as TokenResponse;
  const response = await request.get(`${issuer}/userinfo`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ sub: subjectOf("bob@test"), email: "bob@test", email_verified: true });

  const refused: Record<string, string>[] = [{}, { Authorization: "Bearer unknown" }, { Authorization: `Bearer ${tokens.id_token}` }];
  for (const headers of refused) {
    expect((await request.get(`${issuer}/userinfo`, { headers })).status()).toBe(401);
  }
});

test("revoke answers 200", async ({ request }) => {
  const response = await request.post(`${issuer}/revoke`, { form: { token: "anything" } });
  expect(response.status()).toBe(200);
});
