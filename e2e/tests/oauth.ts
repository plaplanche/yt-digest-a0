import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

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
