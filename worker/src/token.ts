import { randomBase64url, sha256Hex } from "./crypto";
import { accessTokenTtlSeconds, baseUrl, refreshTokenTtlSeconds, type Env } from "./env";
import { json } from "./http";
import { log } from "./log";
import { admittedRole, oauthError, SCOPE } from "./oauth";

// The second half of the OAuth flow for MCP clients (spec/lot-2.md sections 10.5 and 10.6): the token
// endpoint, and the check of an access token.

type GrantType = "authorization_code" | "refresh_token";

interface Code {
  client_id: string;
  user_sub: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  expires_at: string;
}

interface Token {
  kind: "access" | "refresh";
  client_id: string;
  user_sub: string;
  family_id: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

function invalidRequest(description: string): Response {
  return oauthError(400, "invalid_request", description);
}

function invalidGrant(description: string): Response {
  return oauthError(400, "invalid_grant", description);
}

/** True when the request's media type is `application/x-www-form-urlencoded`, parameters ignored. */
function formEncoded(request: Request): boolean {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === "application/x-www-form-urlencoded";
}

/** `BASE64URL(SHA-256(verifier))` without padding (RFC 7636 S256). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `POST /token` (10.5): the checks run in the order of the spec, grant type first. */
export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (!formEncoded(request)) return invalidRequest("the body must be form-encoded");
  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  // An empty parameter counts as missing.
  const param = (name: string): string | null => form.get(name) || null;

  const grantType = param("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
  const clientId = param("client_id");
  const client =
    clientId === null
      ? null
      : await env.DB.prepare("SELECT client_id FROM oauth_clients WHERE client_id = ?1").bind(clientId).first();
  if (clientId === null || client === null) return oauthError(401, "invalid_client", "unknown client");

  const required = grantType === "authorization_code" ? ["code", "redirect_uri", "code_verifier", "resource"] : ["refresh_token"];
  const missing = required.find((name) => param(name) === null);
  if (missing !== undefined) return invalidRequest(`${missing} is missing`);
  const resource = param("resource");
  if (resource !== null && resource !== `${baseUrl(env)}/mcp`) {
    return oauthError(400, "invalid_target", "resource must be the MCP endpoint");
  }

  const now = new Date().toISOString();
  if (grantType === "authorization_code") {
    return exchangeCode(env, clientId, param("code") ?? "", param("redirect_uri") ?? "", param("code_verifier") ?? "", now);
  }
  return refresh(env, clientId, param("refresh_token") ?? "", now);
}

/** The authorization code grant: the code is used up first, whatever the outcome of its other checks. */
async function exchangeCode(
  env: Env,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
  now: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    "UPDATE oauth_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL RETURNING *",
  )
    .bind(await sha256Hex(code), now)
    .first<Code>();
  if (row === null) return invalidGrant("the code is unknown or already used");
  if (row.expires_at <= now) return invalidGrant("the code is expired");
  if (row.client_id !== clientId) return invalidGrant("the code was issued to another client");
  if (row.redirect_uri !== redirectUri) return invalidGrant("the code was issued for another redirect_uri");
  if (row.code_challenge !== (await s256(verifier))) return invalidGrant("the code_verifier does not match the challenge");
  const issued = await issueTokens(env, "authorization_code", clientId, row.user_sub, randomBase64url(16), row.scope ?? SCOPE, now);
  return issued ?? invalidGrant("the code is no longer valid");
}

/**
 * The refresh token grant: a valid refresh token is marked used and a new pair of its family issued;
 * a used one revokes its whole family (reuse detection).
 */
async function refresh(env: Env, clientId: string, refreshToken: string, now: string): Promise<Response> {
  const hash = await sha256Hex(refreshToken);
  const rotated = await env.DB.prepare(
    `UPDATE oauth_tokens SET used_at = ?3
     WHERE token_hash = ?1 AND kind = 'refresh' AND client_id = ?2
       AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?3
     RETURNING *`,
  )
    .bind(hash, clientId, now)
    .first<Token>();
  if (rotated !== null) {
    const issued = await issueTokens(env, "refresh_token", clientId, rotated.user_sub, rotated.family_id, rotated.scope ?? SCOPE, now);
    return issued ?? invalidGrant("the refresh token was revoked");
  }

  const token = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?1 AND kind = 'refresh'")
    .bind(hash)
    .first<Token>();
  if (token === null) return invalidGrant("the refresh token is unknown");
  if (token.revoked_at !== null) return invalidGrant("the refresh token is revoked");
  if (token.client_id !== clientId) return invalidGrant("the refresh token was issued to another client");
  if (token.used_at !== null) {
    const result = await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ?2 WHERE family_id = ?1 AND revoked_at IS NULL")
      .bind(token.family_id, now)
      .run();
    log("auth.refresh.reuse_detected", { level: "warn", attrs: { client_id: clientId, revoked: result.meta.changes } });
    return invalidGrant("the refresh token was already used");
  }
  return invalidGrant("the refresh token is expired");
}

/**
 * Issues an access and refresh token pair of `familyId` and answers it, or returns null when the family
 * was revoked meanwhile: the pair is written in one batch only while no token of the family is revoked,
 * so a pair racing a reuse detection is either not written or revoked with the rest.
 */
async function issueTokens(
  env: Env,
  grantType: GrantType,
  clientId: string,
  userSub: string,
  familyId: string,
  scope: string,
  now: string,
): Promise<Response | null> {
  const accessToken = randomBase64url(32);
  const refreshToken = randomBase64url(32);
  const accessTtl = accessTokenTtlSeconds(env);
  const insert = async (token: string, kind: Token["kind"], ttlSeconds: number): Promise<D1PreparedStatement> =>
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, scope, resource, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE family_id = ?5 AND revoked_at IS NOT NULL)`,
    ).bind(
      await sha256Hex(token),
      kind,
      clientId,
      userSub,
      familyId,
      scope,
      `${baseUrl(env)}/mcp`,
      new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(),
    );
  const [result] = await env.DB.batch([
    await insert(accessToken, "access", accessTtl),
    await insert(refreshToken, "refresh", refreshTokenTtlSeconds(env)),
  ]);
  if (result.meta.changes !== 1) return null;
  log("auth.token.issued", { attrs: { client_id: clientId, grant_type: grantType } });
  const response = json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// 10.6 Accepting an access token

/** The outcome of an access token check: its user and client, or why it is refused. */
export type AccessCheck =
  | { valid: true; userSub: string; clientId: string; role: "admin" | "member" }
  | { valid: false; reason: "unknown" | "expired" | "revoked" };

/**
 * Checks a bearer as an access token (10.6): a known, unexpired, unrevoked `access` token for `BASE/mcp`
 * whose user is still admitted, read again on every call. A token of another kind, or for another
 * resource, is `unknown`; a user no longer admitted counts as `revoked`.
 */
export async function checkAccessToken(env: Env, token: string): Promise<AccessCheck> {
  const row = await env.DB.prepare(
    `SELECT t.client_id, t.user_sub, t.resource, t.expires_at, t.revoked_at, u.email
     FROM oauth_tokens t LEFT JOIN users u ON u.user_sub = t.user_sub
     WHERE t.token_hash = ?1 AND t.kind = 'access'`,
  )
    .bind(await sha256Hex(token))
    .first<Pick<Token, "client_id" | "user_sub" | "resource" | "expires_at" | "revoked_at"> & { email: string | null }>();
  if (row === null || row.resource !== `${baseUrl(env)}/mcp`) return { valid: false, reason: "unknown" };
  if (row.revoked_at !== null) return { valid: false, reason: "revoked" };
  if (row.expires_at <= new Date().toISOString()) return { valid: false, reason: "expired" };
  const role = row.email === null ? null : await admittedRole(env, row.email);
  if (role === null) return { valid: false, reason: "revoked" };
  return { valid: true, userSub: row.user_sub, clientId: row.client_id, role };
}
