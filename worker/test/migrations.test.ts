import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { TABLES } from "../src/ops";

/** The tables and columns of spec/lot-2.md section 6.3. */
const SCHEMA: Record<string, string[]> = {
  nodes: [
    "node_id",
    "owner_label",
    "token_hash",
    "state",
    "state_since",
    "last_heartbeat_at",
    "version",
    "hourly_budget",
    "created_at",
    "revoked_at",
  ],
  jobs: [
    "video_id",
    "kind",
    "priority",
    "status",
    "leased_by",
    "lease_id",
    "lease_expires_at",
    "attempts",
    "tried_nodes",
    "last_outcome",
    "created_at",
    "done_at",
  ],
  leases: ["lease_id", "video_id", "node_id", "issued_at", "expires_at", "state", "response_json"],
  node_events: ["node_id", "ts", "kind", "video_id"],
  invites: ["email", "invited_at", "accepted_user_sub", "revoked"],
  users: ["user_sub", "email", "role", "google_refresh_token_enc", "created_at"],
  oauth_clients: ["client_id", "client_name", "redirect_uris", "created_at"],
  oauth_requests: [
    "request_id",
    "client_id",
    "redirect_uri",
    "client_state",
    "code_challenge",
    "scope",
    "resource",
    "google_state",
    "google_nonce",
    "expires_at",
    "used_at",
  ],
  oauth_codes: [
    "code_hash",
    "client_id",
    "user_sub",
    "redirect_uri",
    "code_challenge",
    "scope",
    "resource",
    "expires_at",
    "used_at",
  ],
  oauth_tokens: [
    "token_hash",
    "kind",
    "client_id",
    "user_sub",
    "family_id",
    "scope",
    "resource",
    "expires_at",
    "used_at",
    "revoked_at",
  ],
};

interface Column {
  name: string;
  pk: number;
}

async function columns(table: string): Promise<Column[]> {
  const { results } = await env.DB.prepare("SELECT name, pk FROM pragma_table_info(?)").bind(table).all<Column>();
  return results;
}

test("the migrations create the tables of 6.3", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  expect(results.map((row) => row.name).sort()).toEqual(Object.keys(SCHEMA).sort());
});

test("POST /ops/reset knows every table of 6.3", () => {
  expect([...TABLES].sort()).toEqual(Object.keys(SCHEMA).sort());
});

test.each(Object.entries(SCHEMA))("table %s has every column of 6.3", async (table, expected) => {
  const names = (await columns(table)).map((column) => column.name);
  expect(names).toEqual(expect.arrayContaining(expected));
});

test.each([
  ["nodes", ["node_id"]],
  ["jobs", ["video_id", "kind"]],
  ["leases", ["lease_id"]],
  ["invites", ["email"]],
  ["users", ["user_sub"]],
  ["oauth_clients", ["client_id"]],
  ["oauth_requests", ["request_id"]],
  ["oauth_codes", ["code_hash"]],
  ["oauth_tokens", ["token_hash"]],
])("table %s has the primary key of 6.3", async (table, key) => {
  const primary = (await columns(table)).filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  expect(primary.map((column) => column.name)).toEqual(key);
});

test("defaults: a node's hourly budget is 60", async () => {
  await env.DB.prepare(
    "INSERT INTO nodes (node_id, owner_label, token_hash, state, state_since, created_at) VALUES ('n1', 'o', 'h', 'healthy', 't', 't')",
  ).run();
  const row = await env.DB.prepare("SELECT hourly_budget FROM nodes WHERE node_id = 'n1'").first<{ hourly_budget: number }>();
  expect(row?.hourly_budget).toBe(60);
  await env.DB.prepare("DELETE FROM nodes").run();
});
