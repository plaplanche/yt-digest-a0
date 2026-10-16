import { decodeBase64 } from "./crypto";
import type { Env } from "./env";

// The upstream OpenID Connect provider (the fake Google of spec/lot-2.md section 5.3).

/** The endpoints of the provider's discovery document that the Worker uses. */
interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** The claims of a verified ID token that access control reads. */
export interface IdentityClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/** What a successful login gives: the verified claims and Google's refresh token, when sent. */
export interface GoogleLogin {
  claims: IdentityClaims;
  refreshToken: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(input: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`${input} answered ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`${input} did not answer a JSON object`);
  return body;
}

/** Reads `GOOGLE_ISSUER`'s discovery document (on every use: nothing is cached). */
export async function discover(env: Env): Promise<Discovery> {
  const issuer = env.GOOGLE_ISSUER.replace(/\/+$/, "");
  const body = await fetchJson(`${issuer}/.well-known/openid-configuration`);
  const { authorization_endpoint, token_endpoint, jwks_uri } = body;
  if (typeof authorization_endpoint !== "string" || typeof token_endpoint !== "string" || typeof jwks_uri !== "string") {
    throw new Error("incomplete discovery document");
  }
  return { authorization_endpoint, token_endpoint, jwks_uri };
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64(part)));
  if (!isRecord(value)) throw new Error("a JWT part is not a JSON object");
  return value;
}

/**
 * Verifies an ID token (section 10.4 step 3): an RS256 signature by a key of the JWKS (the key of
 * the header's `kid`, or any key without one), `iss`, `aud`, `exp` in the future and `nonce`.
 * Throws on any failure.
 */
async function verifyIdToken(env: Env, idToken: string, jwksUri: string, nonce: string): Promise<IdentityClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const header = decodeJson(parts[0]);
  if (header.alg !== "RS256") throw new Error("not RS256");
  const jwks = await fetchJson(jwksUri);
  const keys = (Array.isArray(jwks.keys) ? jwks.keys : []).filter(
    (key): key is JsonWebKey & { kid?: unknown } =>
      isRecord(key) && key.kty === "RSA" && (header.kid === undefined || key.kid === header.kid),
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64(parts[2]);
  let valid = false;
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new Error("bad signature");
  const claims = decodeJson(parts[1]);
  if (claims.iss !== env.GOOGLE_ISSUER) throw new Error("wrong iss");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error("wrong aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("expired");
  if (claims.nonce !== nonce) throw new Error("wrong nonce");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new Error("no sub or email");
  return { sub: claims.sub, email: claims.email, emailVerified: claims.email_verified === true };
}

/**
 * Exchanges an authorization code at the token endpoint (client secret in the body) and verifies
 * the ID token. Throws on any failure.
 */
export async function exchangeCode(env: Env, code: string, redirectUri: string, nonce: string): Promise<GoogleLogin> {
  const { token_endpoint, jwks_uri } = await discover(env);
  const body = await fetchJson(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (typeof body.id_token !== "string") throw new Error("no id_token");
  const claims = await verifyIdToken(env, body.id_token, jwks_uri, nonce);
  return { claims, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null };
}
