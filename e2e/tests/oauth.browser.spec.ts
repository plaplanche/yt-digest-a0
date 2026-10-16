import { expect, test, type Page } from "@playwright/test";
import { ops, reset } from "./nodes";
import { authorizePath, clientRedirect, registerClient } from "./oauth";

// The consent page and the fake Google sign-in page (spec/lot-2.md sections 10.3 and 10.4), and E2E-02.

test.beforeEach(async ({ request }) => {
  await reset(request);
});

/** Opens the consent page, approves, and signs in at the fake Google as `email`. */
async function signIn(page: Page, clientId: string, email: string): Promise<void> {
  await page.goto(authorizePath(clientId));
  await expect(page.getByText("E2E client")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page).toHaveTitle("Sign in - fake Google");
  await page.locator('input[name="login_hint"]').fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function users(page: Page): Promise<unknown[]> {
  const response = await page.request.get("/ops/users", { headers: ops });
  return ((await response.json()) as { users: unknown[] }).users;
}

test("an invited user goes through consent and the Google sign-in back to the client with a code", async ({ page }) => {
  expect((await page.request.post("/ops/invites", { headers: ops, data: { email: "bob@test" } })).status()).toBe(200);
  const clientId = await registerClient(page.request);
  await signIn(page, clientId, "bob@test");
  await page.waitForURL((url) => url.href.startsWith(clientRedirect));
  const url = new URL(page.url());
  expect(url.searchParams.get("state")).toBe("e2e-state");
  expect(url.searchParams.get("code")?.length).toBeGreaterThanOrEqual(32);
  expect(await users(page)).toEqual([{ user_sub: expect.stringMatching(/^g-/), email: "bob@test", role: "member" }]);
});

test("E2E-02: a non-invited user gets the 403 page and no users row", async ({ page }) => {
  const clientId = await registerClient(page.request);
  const answer = page.waitForResponse((response) => response.url().includes("/callback?"));
  await signIn(page, clientId, "mallory@test");
  expect((await answer).status()).toBe(403);
  await expect(page).toHaveTitle("Access refused");
  await expect(page.getByText("This account is not invited.")).toBeVisible();
  expect(await users(page)).toEqual([]);
});
