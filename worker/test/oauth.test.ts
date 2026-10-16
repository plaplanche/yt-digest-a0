import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { call, captureLogs, OPS } from "./helpers";

// The first half of the OAuth flow (spec/lot-2.md sections 10.1 to 10.4), Google's endpoints answered
// by a stub of `fetch`.

const BASE = "http://worker.test";
const RESOURCE = `${BASE}/mcp`;
const GOOGLE = "https://google.test";
const CLIENT_REDIRECT = "https://client.example/cb";
const GOOGLE_REFRESH_TOKEN = "google-refresh-token-in-clear";

// The stub's signing keys: `key` is published in the JWKS, `otherKey` is not.
let key: CryptoKeyPair;
let otherKey: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  key = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKey = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey;
});

/** What the stub's token endpoint signs into the next ID token, beyond the defaults. */
interface Login {
  email: string;
  claims?: Record<string, unknown>;
  signWith?: CryptoKey;
  refreshToken?: string | null;
  tokenStatus?: number;
}

let login: Login;
let tokenRequests: URLSearchParams[];
/** The nonce of the last approve redirect; the stub's ID token carries it by default. */
let sentNonce: string;

function b64url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function subjectOf(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase()));
  return `g-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)}`;
}

async function idToken(): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: GOOGLE,
    aud: "worker-client",
    sub: await subjectOf(login.email),
    email: login.email,
    email_verified: true,
    iat,
    exp: iat + 3600,
    nonce: sentNonce,
    ...login.claims,
  };
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", login.signWith ?? key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function googleStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== GOOGLE) throw new Error(`unexpected fetch of ${request.url}`);
  switch (`${request.method} ${url.pathname}`) {
    case "GET /.well-known/openid-configuration":
      return jsonResponse({
        issuer: GOOGLE,
        authorization_endpoint: `${GOOGLE}/o/authorize`,
        token_endpoint: `${GOOGLE}/o/token`,
        jwks_uri: `${GOOGLE}/o/jwks`,
      });
    case "GET /o/jwks":
      return jsonResponse({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    case "POST /o/token": {
      tokenRequests.push(new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())));
      if (login.tokenStatus !== undefined) return jsonResponse({ error: "invalid_grant" }, login.tokenStatus);
      const refreshToken = login.refreshToken === undefined ? GOOGLE_REFRESH_TOKEN : login.refreshToken;
      return jsonResponse({
        access_token: "google-access",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email",
        id_token: await idToken(),
        ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
      });
    }
  }
  return new Response("Not Found", { status: 404 });
}

beforeEach(async () => {
  await call("/ops/reset", { method: "POST", headers: OPS });
  login = { email: "bob@test" };
  tokenRequests = [];
  sentNonce = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(googleStub);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function register(body: unknown): Promise<Response> {
  return call("/register", { method: "POST", body: JSON.stringify(body) });
}

async function registerClient(metadata: Record<string, unknown> = {}): Promise<string> {
  const response = await register({ redirect_uris: [CLIENT_REDIRECT], client_name: "Test client", ...metadata });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, changes: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "digest",
    state: "client-state",
    ...changes,
  };
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== null) search.set(name, value);
  return `/authorize?${search.toString()}`;
}

/** The pending authorization id of a consent page. */
function requestIdOf(html: string): string {
  const match = /<input type="hidden" name="request" value="([^"]+)">/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

async function startAuthorization(clientId: string): Promise<string> {
  const response = await call(authorizeQuery(clientId));
  expect(response.status).toBe(200);
  return requestIdOf(await response.text());
}

async function decide(requestId: string, decision: string): Promise<Response> {
  return call("/authorize/consent", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestId, decision }).toString(),
  });
}

/** Approves a pending authorization and returns the Google `state` of the redirect. */
async function approve(requestId: string): Promise<string> {
  const response = await decide(requestId, "approve");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  sentNonce = location.searchParams.get("nonce") ?? "";
  return location.searchParams.get("state") ?? "";
}

async function callback(state: string, extra: Record<string, string> = { code: "google-code" }): Promise<Response> {
  return call(`/callback?${new URLSearchParams({ state, ...extra }).toString()}`);
}

function location(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "");
}

function clientRedirect(response: Response): URLSearchParams {
  const url = location(response);
  expect(`${url.origin}${url.pathname}`).toBe(CLIENT_REDIRECT);
  return url.searchParams;
}

async function expectHtml(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Location")).toBeNull();
  return response.text();
}

async function expectOAuthError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(((await response.json()) as { error: string }).error).toBe(error);
}

async function users(): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare("SELECT * FROM users ORDER BY email").all()).results;
}

async function invite(email: string): Promise<void> {
  const response = await call("/ops/invites", { method: "POST", headers: OPS, body: JSON.stringify({ email }) });
  expect(response.status).toBe(200);
}

/** Runs the flow up to the callback for `email` and returns the callback's answer. */
async function signIn(email: string, clientId?: string): Promise<Response> {
  login.email = email;
  const id = clientId ?? (await registerClient());
  return callback(await approve(await startAuthorization(id)));
}

describe("10.1 discovery", () => {
  test.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "%s",
    async (path) => {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [BASE],
        scopes_supported: ["digest"],
        bearer_methods_supported: ["header"],
      });
    },
  );

  test("/.well-known/oauth-authorization-server", async () => {
    const response = await call("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["digest"],
    });
  });

  test("another method gives 404 not_found", async () => {
    const response = await call("/.well-known/oauth-authorization-server", { method: "POST" });
    expect(response.status).toBe(404);
  });
});

describe("10.2 POST /register", () => {
  test("registers a public client", async () => {
    const logs = captureLogs();
    const before = Math.floor(Date.now() / 1000);
    const response = await register({
      redirect_uris: [CLIENT_REDIRECT, "http://127.0.0.1:3000/cb", "http://localhost/cb"],
      client_name: "My client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      logo_uri: "https://client.example/logo.png",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      client_id: expect.any(String),
      client_id_issued_at: expect.any(Number),
      client_name: "My client",
      redirect_uris: [CLIENT_REDIRECT, "http://127.0.0.1:3000/cb", "http://localhost/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(String(body.client_id).length).toBeGreaterThanOrEqual(16);
    expect(body.client_id_issued_at).toBeGreaterThanOrEqual(before);
    const row = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?1").bind(body.client_id).first();
    expect(row).toMatchObject({ client_name: "My client", redirect_uris: JSON.stringify(body.redirect_uris) });
    const events = logs().filter((line) => line.event === "auth.client.registered");
    expect(events).toEqual([expect.objectContaining({ attrs: { client_id: body.client_id } })]);
  });

  test("without client_name, the answer has none", async () => {
    const response = await register({ redirect_uris: [CLIENT_REDIRECT] });
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("client_name");
  });

  test("two clients get different ids", async () => {
    expect(await registerClient()).not.toBe(await registerClient());
  });

  test.each([
    ["missing", {}],
    ["empty", { redirect_uris: [] }],
    ["not an array", { redirect_uris: CLIENT_REDIRECT }],
    ["more than 10", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example/${i}`) }],
    ["not a string", { redirect_uris: [1] }],
    ["relative", { redirect_uris: ["/cb"] }],
    ["http on another host", { redirect_uris: ["http://client.example/cb"] }],
    ["with a fragment", { redirect_uris: ["https://client.example/cb#x"] }],
    ["with an empty fragment", { redirect_uris: ["https://client.example/cb#"] }],
    ["another scheme", { redirect_uris: ["myapp://cb"] }],
    ["one invalid among valid ones", { redirect_uris: [CLIENT_REDIRECT, "http://evil.example/cb"] }],
    ["invalid, with another invalid field", { redirect_uris: [], client_name: 1 }],
  ])("redirect_uris %s gives 400 invalid_redirect_uri", async (_, body) => {
    await expectOAuthError(await register(body), 400, "invalid_redirect_uri");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM oauth_clients").first())?.n).toBe(0);
  });

  test.each([
    ["client_name not a string", { client_name: 1 }],
    ["client_name over 200 characters", { client_name: "x".repeat(201) }],
    ["token_endpoint_auth_method not none", { token_endpoint_auth_method: "client_secret_basic" }],
    ["grant_types with another grant", { grant_types: ["authorization_code", "client_credentials"] }],
    ["grant_types not an array", { grant_types: "authorization_code" }],
    ["response_types with token", { response_types: ["code", "token"] }],
  ])("%s gives 400 invalid_client_metadata", async (_, metadata) => {
    await expectOAuthError(await register({ redirect_uris: [CLIENT_REDIRECT], ...metadata }), 400, "invalid_client_metadata");
  });

  test("a client_name of 200 characters is accepted", async () => {
    expect((await register({ redirect_uris: [CLIENT_REDIRECT], client_name: "é".repeat(200) })).status).toBe(201);
  });

  test.each([
    ["not JSON", "{nope"],
    ["not an object", "[]"],
  ])("a body %s gives 400 invalid_client_metadata", async (_, body) => {
    await expectOAuthError(await call("/register", { method: "POST", body }), 400, "invalid_client_metadata");
  });

  test("GET gives 404", async () => {
    expect((await call("/register")).status).toBe(404);
  });
});

describe("10.3 GET /authorize", () => {
  test("an unknown client_id gives a 400 HTML page, never a redirect", async () => {
    await expectHtml(await call(authorizeQuery("unknown-client-id")), 400);
    await expectHtml(await call(authorizeQuery("x", { client_id: null })), 400);
  });

  test.each([
    ["missing", null],
    ["not registered", "https://client.example/other"],
    ["not exact (prefix)", "https://client.example/cb/more"],
    ["not exact (query)", `${CLIENT_REDIRECT}?a=1`],
  ])("a redirect_uri %s gives a 400 HTML page, never a redirect", async (_, redirectUri) => {
    const clientId = await registerClient();
    await expectHtml(await call(authorizeQuery(clientId, { redirect_uri: redirectUri, response_type: "token" })), 400);
  });

  test.each([
    ["response_type not code", { response_type: "token" }, "unsupported_response_type"],
    ["response_type missing", { response_type: null }, "unsupported_response_type"],
    ["code_challenge missing", { code_challenge: null }, "invalid_request"],
    ["code_challenge_method missing", { code_challenge_method: null }, "invalid_request"],
    ["code_challenge_method plain", { code_challenge_method: "plain" }, "invalid_request"],
    ["resource missing", { resource: null }, "invalid_target"],
    ["resource not exact", { resource: `${RESOURCE}/` }, "invalid_target"],
    ["another scope", { scope: "admin" }, "invalid_scope"],
    ["two scopes", { scope: "digest admin" }, "invalid_scope"],
    // The order of 10.3 step 2: each error wins over the ones after it.
    ["bad response_type and no PKCE", { response_type: "token", code_challenge: null }, "unsupported_response_type"],
    ["plain PKCE and a bad resource", { code_challenge_method: "plain", resource: "x" }, "invalid_request"],
    ["a bad resource and a bad scope", { resource: "x", scope: "admin" }, "invalid_target"],
  ])("%s redirects with %s", async (_, changes, error) => {
    const clientId = await registerClient();
    const params = clientRedirect(await call(authorizeQuery(clientId, changes)));
    expect(Object.fromEntries(params)).toEqual({ error, state: "client-state" });
  });

  test("an error redirect without state carries no state", async () => {
    const clientId = await registerClient();
    const params = clientRedirect(await call(authorizeQuery(clientId, { state: null, scope: "admin" })));
    expect(Object.fromEntries(params)).toEqual({ error: "invalid_scope" });
  });

  test("an error redirect keeps the redirect URI's own query", async () => {
    const redirectUri = "https://client.example/cb?app=1";
    const clientId = await registerClient({ redirect_uris: [redirectUri] });
    const url = location(await call(authorizeQuery(clientId, { redirect_uri: redirectUri, scope: "admin" })));
    expect(Object.fromEntries(url.searchParams)).toEqual({ app: "1", error: "invalid_scope", state: "client-state" });
  });

  test("the consent page shows the escaped client name, redirect URI and scope", async () => {
    const clientId = await registerClient({ client_name: '<script>alert("x")</script>' });
    const response = await call(authorizeQuery(clientId, { scope: null }));
    const html = await expectHtml(response, 200);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;");
    expect(html).toContain(CLIENT_REDIRECT);
    expect(html).toContain("<code>digest</code>");
    expect(html).toContain('<form method="post" action="/authorize/consent">');
    expect(html.match(/<button type="submit" name="decision"/g)).toHaveLength(2);
    expect(html).toContain('<button type="submit" name="decision" value="approve">');
    expect(html).toContain('<button type="submit" name="decision" value="deny">');
    expect(requestIdOf(html).length).toBeGreaterThanOrEqual(16);
  });

  test("a client without a name is shown by its client_id", async () => {
    const response = await register({ redirect_uris: [CLIENT_REDIRECT] });
    const { client_id } = (await response.json()) as { client_id: string };
    expect(await (await call(authorizeQuery(client_id))).text()).toContain(`<strong>${client_id}</strong>`);
  });

  test("stores the pending authorization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const clientId = await registerClient();
    const requestId = await startAuthorization(clientId);
    const row = await env.DB.prepare("SELECT * FROM oauth_requests WHERE request_id = ?1").bind(requestId).first();
    expect(row).toMatchObject({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      client_state: "client-state",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      scope: "digest",
      resource: RESOURCE,
      expires_at: "2026-10-16T07:10:00.000Z",
      used_at: null,
    });
  });
});

describe("10.3 POST /authorize/consent", () => {
  test("deny redirects with access_denied and the client's state, and uses the request up", async () => {
    const logs = captureLogs();
    const clientId = await registerClient();
    const requestId = await startAuthorization(clientId);
    const params = clientRedirect(await decide(requestId, "deny"));
    expect(Object.fromEntries(params)).toEqual({ error: "access_denied", state: "client-state" });
    expect(logs().filter((line) => line.event === "auth.oauth.denied")).toEqual([
      expect.objectContaining({ attrs: { client_id: clientId, reason: "access_denied" } }),
    ]);
    await expectHtml(await decide(requestId, "deny"), 400);
    await expectHtml(await decide(requestId, "approve"), 400);
  });

  test("approve redirects to Google with every parameter", async () => {
    const clientId = await registerClient();
    const requestId = await startAuthorization(clientId);
    const url = location(await decide(requestId, "approve"));
    expect(`${url.origin}${url.pathname}`).toBe(`${GOOGLE}/o/authorize`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      client_id: "worker-client",
      redirect_uri: `${BASE}/callback`,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
      state: expect.any(String),
      nonce: expect.any(String),
      access_type: "offline",
      prompt: "consent",
    });
    const row = await env.DB.prepare("SELECT * FROM oauth_requests WHERE request_id = ?1").bind(requestId).first();
    expect(row).toMatchObject({ google_state: params.state, google_nonce: params.nonce, used_at: null });
    expect(params.state).not.toBe("client-state");
    expect(params.state).not.toBe(requestId);
    expect(params.nonce).not.toBe(params.state);
  });

  test("two pending authorizations get different Google state and nonce", async () => {
    const clientId = await registerClient();
    const first = location(await decide(await startAuthorization(clientId), "approve")).searchParams;
    const second = location(await decide(await startAuthorization(clientId), "approve")).searchParams;
    expect(first.get("state")).not.toBe(second.get("state"));
    expect(first.get("nonce")).not.toBe(second.get("nonce"));
  });

  test("an unknown request gives 400 HTML", async () => {
    await expectHtml(await decide("unknown-request-id", "approve"), 400);
    await expectHtml(await decide("", "deny"), 400);
  });

  test("an expired request gives 400 HTML", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const requestId = await startAuthorization(await registerClient());
    vi.setSystemTime(new Date("2026-10-16T07:10:00.000Z"));
    await expectHtml(await decide(requestId, "approve"), 400);
    await expectHtml(await decide(requestId, "deny"), 400);
    vi.setSystemTime(new Date("2026-10-16T07:09:59.999Z"));
    expect((await decide(requestId, "approve")).status).toBe(302);
  });

  test("a request used by the callback gives 400 HTML", async () => {
    await invite("bob@test");
    const requestId = await startAuthorization(await registerClient());
    expect((await callback(await approve(requestId))).status).toBe(302);
    await expectHtml(await decide(requestId, "approve"), 400);
  });

  test("another decision gives 400 HTML", async () => {
    const requestId = await startAuthorization(await registerClient());
    await expectHtml(await decide(requestId, "maybe"), 400);
  });
});

describe("10.4 GET /callback", () => {
  test("an invited user gets a code bound to the authorization, and a member row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    await invite("bob@test");
    const logs = captureLogs();
    const clientId = await registerClient();
    const response = await signIn("Bob@Test", clientId);
    const params = clientRedirect(response);
    expect([...params.keys()]).toEqual(["code", "state"]);
    expect(params.get("state")).toBe("client-state");
    const code = params.get("code") ?? "";
    expect(code.length).toBeGreaterThanOrEqual(32);

    const sub = await subjectOf("bob@test");
    expect(await users()).toEqual([
      {
        user_sub: sub,
        email: "bob@test",
        role: "member",
        google_refresh_token_enc: expect.stringMatching(/^v1:/),
        created_at: "2026-10-16T07:00:00.000Z",
      },
    ]);
    expect(await env.DB.prepare("SELECT accepted_user_sub FROM invites WHERE email = 'bob@test'").first()).toEqual({
      accepted_user_sub: sub,
    });
    const codeHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await env.DB.prepare("SELECT * FROM oauth_codes").all()).toMatchObject({
      results: [
        {
          code_hash: codeHash,
          client_id: clientId,
          user_sub: sub,
          redirect_uri: CLIENT_REDIRECT,
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          scope: "digest",
          resource: RESOURCE,
          expires_at: "2026-10-16T07:01:00.000Z",
          used_at: null,
        },
      ],
    });
    expect(tokenRequests.map((form) => Object.fromEntries(form))).toEqual([
      {
        grant_type: "authorization_code",
        code: "google-code",
        redirect_uri: `${BASE}/callback`,
        client_id: "worker-client",
        client_secret: "worker-secret",
      },
    ]);
    const completed = logs().filter((line) => line.event === "auth.oauth.completed");
    expect(completed).toEqual([expect.objectContaining({ attrs: { client_id: clientId, role: "member" } })]);
    const text = JSON.stringify(logs());
    for (const secret of [code, "bob@test", sub, GOOGLE_REFRESH_TOKEN]) expect(text).not.toContain(secret);
  });

  test("the admin gets a code and an admin row without an invite", async () => {
    const logs = captureLogs();
    const params = clientRedirect(await signIn("alice@test"));
    expect(params.get("code")).not.toBeNull();
    expect(await users()).toMatchObject([{ user_sub: await subjectOf("alice@test"), email: "alice@test", role: "admin" }]);
    expect(logs().find((line) => line.event === "auth.oauth.completed")).toMatchObject({ attrs: { role: "admin" } });
  });

  test("the admin's e-mail is compared lowercased", async () => {
    clientRedirect(await signIn("ALICE@test"));
    expect(await users()).toMatchObject([{ email: "alice@test", role: "admin" }]);
  });

  test("a non-invited user gets the 403 page and no row", async () => {
    const logs = captureLogs();
    const clientId = await registerClient();
    const html = await expectHtml(await signIn("mallory@test", clientId), 403);
    expect(html).toContain("<title>Access refused</title>");
    expect(html).toContain("This account is not invited.");
    expect(await users()).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM oauth_codes").first()).toEqual({ n: 0 });
    expect(logs().filter((line) => line.event === "auth.oauth.denied")).toEqual([
      expect.objectContaining({ attrs: { client_id: clientId, reason: "not_invited" } }),
    ]);
  });

  test("a user whose invite is revoked gets the 403 page", async () => {
    await invite("bob@test");
    await call("/ops/invites/revoke", { method: "POST", headers: OPS, body: JSON.stringify({ email: "bob@test" }) });
    await expectHtml(await signIn("bob@test"), 403);
    expect(await users()).toEqual([]);
  });

  test("an unverified e-mail gets the 403 page, even for the admin", async () => {
    const logs = captureLogs();
    login.claims = { email_verified: false };
    await expectHtml(await signIn("alice@test"), 403);
    expect(await users()).toEqual([]);
    expect(logs().find((line) => line.event === "auth.oauth.denied")).toMatchObject({
      attrs: { reason: "email_unverified" },
    });
  });

  test("signing in again updates the row and keeps created_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    await invite("bob@test");
    const clientId = await registerClient();
    clientRedirect(await signIn("bob@test", clientId));
    const [first] = await users();
    vi.setSystemTime(new Date("2026-10-16T08:00:00.000Z"));
    login.refreshToken = null;
    clientRedirect(await signIn("bob@test", clientId));
    expect(await users()).toEqual([first]);
    login.refreshToken = "another-refresh-token";
    clientRedirect(await signIn("bob@test", clientId));
    const [third] = await users();
    expect(third.created_at).toBe("2026-10-16T07:00:00.000Z");
    expect(third.google_refresh_token_enc).not.toBe(first.google_refresh_token_enc);
  });

  test("no stored value holds the Google refresh token in clear; it decrypts with TOKEN_ENC_KEY", async () => {
    await invite("bob@test");
    clientRedirect(await signIn("bob@test"));
    const tables = ["users", "invites", "oauth_clients", "oauth_requests", "oauth_codes", "oauth_tokens"];
    for (const table of tables) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(GOOGLE_REFRESH_TOKEN);
    }
    const [user] = await users();
    const sealed = String(user.google_refresh_token_enc);
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    const bytes = Uint8Array.from(atob(sealed.slice(3)), (c) => c.charCodeAt(0));
    const keyBytes = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
    const aes = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, aes, bytes.slice(12));
    expect(new TextDecoder().decode(clear)).toBe(GOOGLE_REFRESH_TOKEN);
  });

  test("two encryptions of the same token differ (a random IV per value)", async () => {
    await invite("bob@test");
    await invite("carol@test");
    clientRedirect(await signIn("bob@test"));
    clientRedirect(await signIn("carol@test"));
    const [bob, carol] = await users();
    expect(bob.google_refresh_token_enc).not.toBe(carol.google_refresh_token_enc);
  });

  test.each([
    ["unknown", "not-a-state"],
    ["empty", ""],
  ])("an %s state gives 400 HTML", async (_, state) => {
    await expectHtml(await callback(state), 400);
    expect(tokenRequests).toEqual([]);
  });

  test("the client's state or the request id are not accepted as state", async () => {
    const requestId = await startAuthorization(await registerClient());
    await approve(requestId);
    await expectHtml(await callback("client-state"), 400);
    await expectHtml(await callback(requestId), 400);
  });

  test("a state already used gives 400 HTML", async () => {
    await invite("bob@test");
    const state = await approve(await startAuthorization(await registerClient()));
    clientRedirect(await callback(state));
    await expectHtml(await callback(state), 400);
  });

  test("a state used by a failed callback is used up too", async () => {
    const state = await approve(await startAuthorization(await registerClient()));
    clientRedirect(await callback(state, { error: "access_denied" }));
    await expectHtml(await callback(state), 400);
  });

  test("an expired pending authorization gives 400 HTML", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    await invite("bob@test");
    const state = await approve(await startAuthorization(await registerClient()));
    vi.setSystemTime(new Date("2026-10-16T07:10:00.000Z"));
    await expectHtml(await callback(state), 400);
  });

  test("an error from Google redirects with access_denied", async () => {
    const logs = captureLogs();
    const clientId = await registerClient();
    const state = await approve(await startAuthorization(clientId));
    const params = clientRedirect(await callback(state, { error: "access_denied" }));
    expect(Object.fromEntries(params)).toEqual({ error: "access_denied", state: "client-state" });
    expect(tokenRequests).toEqual([]);
    expect(logs().find((line) => line.event === "auth.oauth.denied")).toMatchObject({
      attrs: { client_id: clientId, reason: "google_error" },
    });
  });

  const otherIssuer = { iss: "https://evil.test" };
  test.each([
    ["a bad signature", { signWith: "other" }],
    ["a wrong aud", { claims: { aud: "another-client" } }],
    ["a wrong iss", { claims: otherIssuer }],
    ["a wrong nonce", { claims: { nonce: "another-nonce" } }],
    ["no nonce", { claims: { nonce: undefined } }],
    ["an expired ID token", { claims: { exp: Math.floor(Date.now() / 1000) - 1 } }],
    ["a failed code exchange", { tokenStatus: 400 }],
  ])("%s redirects with server_error and writes no row", async (_, change) => {
    await invite("bob@test");
    const { signWith, ...rest } = change as { signWith?: string } & Partial<Login>;
    Object.assign(login, rest, signWith === undefined ? {} : { signWith: otherKey.privateKey });
    const params = clientRedirect(await signIn("bob@test"));
    expect(Object.fromEntries(params)).toEqual({ error: "server_error", state: "client-state" });
    expect(await users()).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM oauth_codes").first()).toEqual({ n: 0 });
  });

  test("a tampered payload fails the signature check", async () => {
    await invite("bob@test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await googleStub(input, init);
      if (!new Request(input, init).url.endsWith("/o/token")) return response;
      const body = (await response.json()) as { id_token: string };
      const [header, , signature] = body.id_token.split(".");
      const payload = b64url(JSON.stringify({ iss: GOOGLE, aud: "worker-client", sub: "x", email: "alice@test", exp: 2e9, nonce: sentNonce }));
      return jsonResponse({ ...body, id_token: `${header}.${payload}.${signature}` });
    });
    const params = clientRedirect(await signIn("bob@test"));
    expect(params.get("error")).toBe("server_error");
  });
});
