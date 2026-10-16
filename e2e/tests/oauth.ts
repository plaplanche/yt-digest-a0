import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

// Helpers of the OAuth tests (spec/lot-2.md section 10).

export const workerUrl = `http://127.0.0.1:${process.env.WORKER_PORT ?? "8787"}`;
export const mocksUrl = `http://127.0.0.1:${process.env.MOCKS_PORT ?? "8789"}`;
export const resource = `${workerUrl}/mcp`;
/** The test client's redirect URI: a page of the mocks server (a 404), reached at the end of the flow. */
export const clientRedirect = `${mocksUrl}/client/callback`;

export async function registerClient(request: APIRequestContext, redirectUris = [clientRedirect]): Promise<string> {
  const response = await request.post("/register", { data: { redirect_uris: redirectUris, client_name: "E2E client" } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The path of an authorization request; a parameter set to null is left out. */
export function authorizePath(clientId: string, changes: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: clientRedirect,
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource,
    scope: "digest",
    state: "e2e-state",
    ...changes,
  };
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== null) search.set(name, value);
  return `/authorize?${search.toString()}`;
}

/** The `Location` of a 302 answer. */
function redirectOf(response: APIResponse): URL {
  expect(response.status()).toBe(302);
  return new URL(response.headers()["location"]);
}

/**
 * Logs `email` in over HTTP: the consent form approved, then the fake Google's sign-in skipped with
 * `login_hint`. Returns the client's authorization code and its PKCE verifier.
 */
export async function logIn(
  request: APIRequestContext,
  clientId: string,
  email: string,
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const consentPage = await request.get(authorizePath(clientId, { code_challenge: challenge }), { maxRedirects: 0 });
  expect(consentPage.status()).toBe(200);
  const requestId = /<input type="hidden" name="request" value="([^"]+)">/.exec(await consentPage.text())?.[1];
  expect(requestId).toBeDefined();
  const approved = await request.post("/authorize/consent", {
    form: { request: requestId ?? "", decision: "approve" },
    maxRedirects: 0,
  });
  const google = redirectOf(approved);
  google.searchParams.set("login_hint", email);
  const callback = redirectOf(await request.get(google.href, { maxRedirects: 0 }));
  expect(`${callback.origin}${callback.pathname}`).toBe(`${workerUrl}/callback`);
  const client = redirectOf(await request.get(callback.href, { maxRedirects: 0 }));
  expect(`${client.origin}${client.pathname}`).toBe(clientRedirect);
  expect(client.searchParams.get("state")).toBe("e2e-state");
  return { code: client.searchParams.get("code") ?? "", verifier };
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** Exchanges an authorization code at `POST /token`. */
export async function exchangeCode(request: APIRequestContext, clientId: string, code: string, verifier: string): Promise<Tokens> {
  const response = await request.post("/token", {
    form: { grant_type: "authorization_code", code, redirect_uri: clientRedirect, client_id: clientId, code_verifier: verifier, resource },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as Tokens;
}

/** Posts one JSON-RPC message to `/mcp` (section 11), with `token` as the bearer when given. */
export function postMcp(
  request: APIRequestContext,
  token: string | null,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  return request.post("/mcp", {
    headers: {
      Accept: "application/json, text/event-stream",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    data: { jsonrpc: "2.0", ...message },
  });
}

/** Checks the 401 `invalid_token` answer of `/mcp`, whose `WWW-Authenticate` points to the protected resource metadata. */
export async function expectInvalidToken(response: APIResponse): Promise<void> {
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain(`resource_metadata="${workerUrl}/.well-known/oauth-protected-resource"`);
  expect(await response.json()).toMatchObject({ error: "invalid_token" });
}
