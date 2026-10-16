import { expect, test, type APIRequestContext } from "@playwright/test";
import { reset } from "./nodes";
import { clientRedirect, expectInvalidToken, logIn, postMcp, registerClient, resource } from "./oauth";

// E2E-31 of spec/lot-2.md section 13: refresh rotation, and the reuse of an old refresh token revoking
// the family (shown at /token and /mcp).

interface Tokens {
  access_token: string;
  refresh_token: string;
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

async function refresh(request: APIRequestContext, clientId: string, refreshToken: string): Promise<{ status: number; body: unknown }> {
  const response = await request.post("/token", {
    form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource },
  });
  return { status: response.status(), body: await response.json() };
}

test("E2E-31: refresh rotates the tokens; reusing an old refresh token revokes the family", async ({ request }) => {
  const clientId = await registerClient(request);
  const { code, verifier } = await logIn(request, clientId, "alice@test");
  const exchange = await request.post("/token", {
    form: { grant_type: "authorization_code", code, redirect_uri: clientRedirect, client_id: clientId, code_verifier: verifier, resource },
  });
  expect(exchange.status()).toBe(200);
  expect(exchange.headers()["cache-control"]).toBe("no-store");
  const first = (await exchange.json()) as Tokens;
  expect(first).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "digest" });

  const rotated = await refresh(request, clientId, first.refresh_token);
  expect(rotated.status).toBe(200);
  const second = rotated.body as Tokens;
  expect(second.access_token).not.toBe(first.access_token);
  expect(second.refresh_token).not.toBe(first.refresh_token);
  expect((await postMcp(request, first.access_token, { id: 1, method: "ping" })).status()).toBe(200);

  expect(await refresh(request, clientId, first.refresh_token)).toEqual({
    status: 400,
    body: expect.objectContaining({ error: "invalid_grant" }),
  });
  expect(await refresh(request, clientId, second.refresh_token)).toEqual({
    status: 400,
    body: expect.objectContaining({ error: "invalid_grant" }),
  });
  await expectInvalidToken(await postMcp(request, first.access_token, { id: 1, method: "ping" }));
  await expectInvalidToken(await postMcp(request, second.access_token, { id: 1, method: "ping" }));
});
