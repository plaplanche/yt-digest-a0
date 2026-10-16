import { expect, test } from "@playwright/test";
import { reset } from "./nodes";
import { authorizePath, clientRedirect, registerClient, resource, workerUrl } from "./oauth";

// E2E-29 of spec/lot-2.md section 13, and the discovery documents of section 10.1.

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("the discovery documents are served and consistent", async ({ request }) => {
  const protectedResource = (await (await request.get("/.well-known/oauth-protected-resource")).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(protectedResource.resource).toBe(resource);
  expect(await (await request.get("/.well-known/oauth-protected-resource/mcp")).json()).toEqual(protectedResource);
  const metadata = (await (await request.get("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  expect(protectedResource.authorization_servers).toEqual([metadata.issuer]);
  expect(metadata).toMatchObject({
    issuer: workerUrl,
    authorization_endpoint: `${workerUrl}/authorize`,
    registration_endpoint: `${workerUrl}/register`,
    code_challenge_methods_supported: ["S256"],
  });
});

test.describe("E2E-29: an authorization request without proper PKCE or an exact redirect_uri is refused", () => {
  for (const [name, changes] of [
    ["no PKCE", { code_challenge: null, code_challenge_method: null }],
    ["no code_challenge_method", { code_challenge_method: null }],
    ["plain PKCE", { code_challenge_method: "plain" }],
  ] as const) {
    test(`${name}: redirect with invalid_request`, async ({ request }) => {
      const clientId = await registerClient(request);
      const response = await request.get(authorizePath(clientId, changes), { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const location = new URL(response.headers()["location"]);
      expect(`${location.origin}${location.pathname}`).toBe(clientRedirect);
      expect(Object.fromEntries(location.searchParams)).toEqual({ error: "invalid_request", state: "e2e-state" });
    });
  }

  for (const [name, redirectUri] of [
    ["another path", `${clientRedirect}/other`],
    ["an extra query", `${clientRedirect}?x=1`],
    ["a trailing slash", `${clientRedirect}/`],
  ]) {
    test(`a redirect_uri with ${name}: 400 HTML, no redirect`, async ({ request }) => {
      const clientId = await registerClient(request);
      const response = await request.get(authorizePath(clientId, { redirect_uri: redirectUri }), { maxRedirects: 0 });
      expect(response.status()).toBe(400);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["location"]).toBeUndefined();
    });
  }

  test("the same request with S256 PKCE and the exact redirect_uri gets the consent page", async ({ request }) => {
    const clientId = await registerClient(request);
    const response = await request.get(authorizePath(clientId), { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('<form method="post" action="/authorize/consent">');
  });
});
