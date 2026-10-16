import { expect, test } from "@playwright/test";
import { ops, reset } from "./nodes";
import { authorizePath, clientRedirect, exchangeCode, pkce, postMcp, registerClient } from "./oauth";

// E2E-28 of spec/lot-2.md section 13: an MCP client registers, logs a user in through the consent page
// and the fake Google sign-in page with PKCE and `resource`, then lists and calls `list_subscriptions`.

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("E2E-28: registration, PKCE, resource, consent and Google login give a token that lists and calls list_subscriptions", async ({ page }) => {
  expect((await page.request.post("/ops/invites", { headers: ops, data: { email: "bob@test" } })).status()).toBe(200);
  const clientId = await registerClient(page.request);
  const { verifier, challenge } = pkce();
  await page.goto(authorizePath(clientId, { code_challenge: challenge }));
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator('input[name="login_hint"]').fill("bob@test");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.href.startsWith(clientRedirect));
  const url = new URL(page.url());
  expect(url.searchParams.get("state")).toBe("e2e-state");
  const { access_token } = await exchangeCode(page.request, clientId, url.searchParams.get("code") ?? "", verifier);

  const initialize = await postMcp(page.request, access_token, {
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0.1.0" } },
  });
  expect(initialize.status()).toBe(200);
  expect(await initialize.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
  const session = initialize.headers()["mcp-session-id"];
  const headers: Record<string, string> = session === undefined ? {} : { "Mcp-Session-Id": session };
  headers["MCP-Protocol-Version"] = "2025-06-18";

  const initialized = await postMcp(page.request, access_token, { method: "notifications/initialized" }, headers);
  expect(initialized.status()).toBe(202);

  const list = await postMcp(page.request, access_token, { id: 2, method: "tools/list" }, headers);
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual(["list_subscriptions"]);

  const callResult = await postMcp(page.request, access_token, { id: 3, method: "tools/call", params: { name: "list_subscriptions", arguments: {} } }, headers);
  expect(await callResult.json()).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: '{"subscriptions":[]}' }], isError: false },
  });
});
