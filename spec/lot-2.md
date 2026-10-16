# yt-digest, lot 2: the local Worker, the node protocol and MCP authentication

This is the frozen specification of lot 2. It is derived from `DESIGN.md` (v5.1, sections 4.2, 4.3, 4.7, 11.2, 12, 18.2, 18.3, 18.5, 18.9, 19.1 to 19.3 and milestones M2 and M3) and fixes every choice the design leaves open, so that every attempt builds the same thing. When this file and the design disagree, this file wins. `spec/lot-1.md` still applies, except where this file changes it (its sections 2, 3, 4.2, 4.3 and 6). Anything this file does not cover is out of scope for lot 2.

## 1. Goal and scope

A Cloudflare Worker in TypeScript, run locally with `wrangler dev` on a local D1 and a local R2 (Miniflare), that:

- hands out transcript jobs to nodes over the node protocol (`/node/*`), with leases, attempts, reassignment to other nodes and stale-lease rejection, and stores the transcripts the nodes send back;
- is an OAuth 2.1 authorization server for MCP clients, delegating the login to a fake Google OpenID Connect provider, and protects a minimal MCP endpoint (`/mcp`) with one tool.

The node gains a daemon that works for the Worker. A mocks server inside the repository plays Google (OIDC) and SponsorBlock. One command starts and stops the whole local stack, and the first Playwright end-to-end tests run against it, locally and in CI.

Out of scope for lot 2: any Cloudflare account, deployment, OpenTofu, remote D1 or R2, staging and prod; real Google or YouTube; the `ClusterCoordinator` Durable Object (section 8.9 replaces it); node health states and their transitions, quarantine, probes, the global guard, hourly budgets, IP groups, cross-checks, purge, version guard and the `intermittent` profile (design 18.4 to 18.6, 19.4); plausibility checks of results beyond section 8.4; the `admin` scope and every `admin_*` tool; PATs and `/token/issue`; web sessions, cookies, `/settings`, CSRF, `/digest`, `/about`; consent memory and revocation; rate limiting and lockout; client purging; Client ID Metadata Documents; `X-Request-Id` propagation; every MCP tool other than `list_subscriptions`; subscriptions, videos, runs, rubrics, verdicts, the cron, ntfy and Slack.

## 2. Repository layout (additions to lot 1)

| Path | Content |
| --- | --- |
| `worker/wrangler.toml` | The Worker's configuration: `main`, a `compatibility_date`, the D1 binding `DB` (database name `yt-digest`, `migrations_dir = "migrations"`) and the R2 binding `TRANSCRIPTS` (bucket `yt-digest-transcripts`). No account id, no route |
| `worker/migrations/` | D1 migrations (`NNNN_<name>.sql`), section 6.3 |
| `worker/src/` | The Worker; generated contracts stay in `worker/src/contracts/` |
| `e2e/` | npm package (Node 22, `e2e/package.json`, `e2e/package-lock.json`, TypeScript strict) holding the Playwright tests (`e2e/playwright.config.ts`, `e2e/tests/`) and the mocks server (`e2e/mocks/server.ts`, run with `tsx`) |
| `scripts/stack.sh` | Starts and stops the local stack (section 5.1) |
| `scripts/checks/e2e.sh` | The `e2e` check (section 3.1) |
| `.stack/` | Runtime state, PIDs and logs of the local stack; git-ignored |

## 3. Checks and CI

### 3.1 Checks

At the start of lot 2, `scripts/check.sh` is replaced by a version that knows a fifth check, `e2e`, run last by `all`. It is still provided and not edited. The rules of lot 1 section 3.1 stay, with these changes:

| Name | What it runs |
| --- | --- |
| `lint` | As lot 1, and also `tsc --noEmit` and ESLint on `e2e/` |
| `contracts` | Unchanged |
| `test-node` | Unchanged (it now covers the daemon of section 9 too) |
| `test-worker` | Vitest on `worker/`. Tests that touch D1 or R2 use Miniflare's real D1 and R2 with the migrations applied (for example through `@cloudflare/vitest-pool-workers`), never a hand-written fake of them |
| `e2e` | `scripts/checks/e2e.sh`: installs the dependencies of `e2e/` (`npm ci`); installs Chromium with `npx playwright install --with-deps chromium` when the variable `CI` is set, or tries `timeout 120 npx playwright install chromium` otherwise (an attempt bounded to 120 seconds); starts the stack with `LEASE_SECONDS=2` (section 5.1); runs `npx playwright test`; always stops the stack. Without `CI`, if Chromium cannot be installed, it runs only the `api` project and prints `e2e: chromium unavailable, browser project skipped`. With `CI` set, both projects run. On failure it copies `.stack/logs/` and the Playwright report into `ci-artifacts/` |

### 3.2 CI

The workflow is unchanged. `ci/jobs.json` gains one job, `{"name": "e2e", "run": "./scripts/check.sh e2e"}` (Ubuntu, the default).

## 4. Contracts

### 4.1 Node protocol: new schemas in `contracts/`

Each schema is JSON Schema 2020-12 with `additionalProperties: false` on every object, and is generated like lot 1's (section 4.4). Timestamps are strings in ISO 8601 UTC with milliseconds and `Z` (`2026-10-16T07:00:01.123Z`), everywhere in lot 2. A video id matches `^[A-Za-z0-9_-]{11}$` everywhere.

**`node-heartbeat-request.schema.json`**

| Field | Type | Rule |
| --- | --- | --- |
| `version` | string | required, 1 to 64 characters |
| `uptime_s` | integer ≥ 0 | required |
| `jobs_in_progress` | integer ≥ 0 | required |
| `last_success_at` | timestamp or null | optional |
| `last_blocked_at` | timestamp or null | optional |
| `disk_free_ratio` | number in [0, 1] | optional |
| `cpu_temp_c` | number | optional (absent on a PC) |

**`node-heartbeat-response.schema.json`**: `node_id` (string), `state` (enum `healthy`, `degraded`, `quarantined`, `offline`, `disabled`), `hourly_budget` (integer ≥ 0), `directive` (enum `run`, `pause`, `drain`), all required.

**`node-claim-request.schema.json`**: `max_jobs` (integer, 1 to 10), optional; absent means 3.

**`node-claim-response.schema.json`**: `jobs`, required, an array of objects with `video_id`, `lease_id` (string, at least 16 characters) and `lease_expires_at` (timestamp), all required.

**`node-result-request.schema.json`**

| Field | Type | Rule |
| --- | --- | --- |
| `lease_id` | string | required, at least 1 character |
| `outcome` | enum | required: `ok`, `no_transcript`, `unavailable`, `blocked`, `error` |
| `transcript` | transcript result or null | required key; the object is a `$ref` to `transcript-result.schema.json` (lot 1 section 4.1), not a copy |

**`node-release-request.schema.json`**: `lease_id` (string, at least 1 character), required.

**`node-job-ack.schema.json`** (the response of `/node/result` and `/node/release`): `video_id` and `status` (enum `queued`, `leased`, `done`, `failed_video`), both required.

### 4.2 Error body: `contracts/error.schema.json`

`{"error": {"code": "<code>", "message": "<text>"}}`, both strings and required, with `additionalProperties: false` on both objects. Every error response of `/node/*`, `/ops/*` and the Origin check of `/mcp` uses it, with `Content-Type: application/json`. The codes are fixed by the sections that use them; the message is free text. The OAuth endpoints and the authentication of `/mcp` use the OAuth error format instead (section 10).

### 4.3 Log catalogue

`contracts/log-event.schema.json` keeps its shape (lot 1 section 4.2); the enum of `event` becomes lot 1's three events plus the events of section 12. `service` stays `node` or `worker`.

### 4.4 Generation

Unchanged from lot 1 section 4.3, extended to every new schema: one TypeScript file and one Pydantic module per schema, and the `$ref` of `node-result-request` resolved to the generated transcript-result type in both languages (no duplicated type). The Worker validates every `/node/*` request body against the schema at runtime, and the node validates every response it reads.

## 5. Local stack

### 5.1 `./scripts/stack.sh up|down`

- `up` stops a running stack first (as `down` does), installs the npm dependencies of `worker/` and `e2e/` when their `node_modules` directory is missing, deletes `.stack/state/`, applies the D1 migrations to a fresh local database under `.stack/state/` (`wrangler d1 migrations apply DB --local --persist-to .stack/state`), then starts in the background the mocks server and `wrangler dev` (local mode, listening on `127.0.0.1:$WORKER_PORT`, persisting to `.stack/state/`), with the settings of section 5.2 passed to the Worker. Every `wrangler` command it runs has `WRANGLER_SEND_METRICS=false` in its environment. Every `up` therefore starts from an empty D1 and an empty R2.
- **Readiness**: `up` returns 0 only when `GET $WORKER_URL/health` and `GET $MOCKS_URL/health` both answer 200; it prints `stack: ready $WORKER_URL` as its last line. If both do not answer within `STACK_READY_TIMEOUT` seconds, or a port is already taken, it stops what it started, prints the reason on standard error and exits 1.
- **Logs**: everything the Worker process writes (standard output and error, `wrangler`'s own lines included) goes to `.stack/logs/worker.log`, and the mocks server's to `.stack/logs/mocks.log`; both files are truncated by `up`.
- `down` stops every process `up` started (their whole process groups) and exits 0, also when nothing runs. After `down`, nothing listens on the two ports.

### 5.2 Configuration

`stack.sh` reads these variables from its environment, applies the defaults, and passes them to the Worker (for example with `--var`) and the mocks server. `WORKER_URL` is `http://127.0.0.1:$WORKER_PORT` and `MOCKS_URL` is `http://127.0.0.1:$MOCKS_PORT`; the Worker receives `WORKER_URL` as `PUBLIC_URL` and uses it, without a trailing slash, as its issuer and the base of its URLs.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_PORT` | `8787` | Worker port |
| `MOCKS_PORT` | `8789` | mocks server port |
| `STACK_READY_TIMEOUT` | `180` | readiness limit of `up`, in seconds |
| `OPS_TOKEN` | `ops-local` | bearer of the operator endpoints (section 7) |
| `LEASE_SECONDS` | `600` | lease duration (section 8.3) |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | OAuth access token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | OAuth refresh token lifetime (30 days, from its issue) |
| `AUTH_CODE_TTL_SECONDS` | `60` | authorization code lifetime |
| `AUTH_REQUEST_TTL_SECONDS` | `600` | lifetime of a pending authorization (consent and Google login) |
| `GOOGLE_ISSUER` | `$MOCKS_URL/google` | the OIDC issuer the Worker logs users in with |
| `GOOGLE_CLIENT_ID` | `yt-digest-local` | the Worker's client at the OIDC provider |
| `GOOGLE_CLIENT_SECRET` | `local-google-secret` | its secret |
| `ADMIN_EMAIL` | `alice@test` | the admin's e-mail (section 10.4) |
| `TOKEN_ENC_KEY` | `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` | base64 of the 32-byte AES-GCM key that encrypts Google refresh tokens |
| `ALLOWED_ORIGINS` | empty | comma-separated extra origins accepted on `/mcp` (section 11.2) |

### 5.3 Mocks server

`e2e/mocks/server.ts`, Node 22, listening on `127.0.0.1:$MOCKS_PORT`, holding its state in memory. It reads `MOCKS_PORT`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Its Google issuer is `$MOCKS_URL/google`.

| Route | Behaviour |
| --- | --- |
| `GET /health` | 200 `{"status": "ok"}` |
| `GET /google/.well-known/openid-configuration` | 200 JSON: `issuer`, `authorization_endpoint` (`<issuer>/authorize`), `token_endpoint` (`<issuer>/token`), `userinfo_endpoint` (`<issuer>/userinfo`), `jwks_uri` (`<issuer>/jwks`), `revocation_endpoint` (`<issuer>/revoke`), `response_types_supported` `["code"]`, `subject_types_supported` `["public"]`, `id_token_signing_alg_values_supported` `["RS256"]` |
| `GET /google/authorize` | Requires `client_id` equal to `GOOGLE_CLIENT_ID`, `redirect_uri`, `response_type=code` and a `scope` containing `openid`; otherwise 400 plain text. Without `login_hint`: 200 HTML sign-in page holding a `<form method="get" action="/google/authorize">` that repeats every received parameter as a hidden input, plus a text input `name="login_hint"` and a submit button. With `login_hint=<email>`: 302 to `redirect_uri` with `code` (single use, valid 60 s) and the received `state` |
| `POST /google/token` | Form-encoded. Client authentication by `client_id`/`client_secret` in the body or HTTP Basic; a wrong pair gives 401 `{"error": "invalid_client"}`. `grant_type=authorization_code` with a valid `code` and the same `redirect_uri`: 200 `{"access_token", "token_type": "Bearer", "expires_in": 3600, "scope", "id_token"}`, plus `refresh_token` when the authorize request had `access_type=offline`. `grant_type=refresh_token` with a refresh token it issued: 200 with a new `access_token` and `id_token`. Anything else: 400 `{"error": "invalid_grant"}` |
| `GET /google/userinfo` | Bearer access token it issued: 200 `{"sub", "email", "email_verified": true}`; otherwise 401 |
| `GET /google/jwks` | 200 `{"keys": [<RSA public JWK with kid, alg RS256, use sig>]}`; the RSA key pair (2048 bits) is generated at start |
| `POST /google/revoke` | 200 |
| `GET /sponsorblock/api/skipSegments` | 404 `Not Found` (no sponsor segment for any video) |

The ID token is a JWT signed with RS256 and the `kid` of the JWKS, with the claims `iss` (the issuer), `aud` (`GOOGLE_CLIENT_ID`), `sub`, `email` (the `login_hint`, lowercased), `email_verified` (`true`), `iat`, `exp` (`iat` + 3600) and `nonce` when the authorize request had one. **Subject rule**: `sub` is `g-` followed by the first 16 hexadecimal characters of the SHA-256 of the lowercased e-mail. Any e-mail is accepted; the test users are `alice@test` (admin), `bob@test` (invited) and `mallory@test` (not invited).

## 6. Worker: common rules

### 6.1 HTTP conventions

- Every JSON response has `Content-Type: application/json`. A request body the endpoint cannot parse as JSON, or that breaks its schema, gives 400 `invalid_request`.
- A route or method not listed in this file gives 404 `not_found` (error body of 4.2).
- The Worker is the only clock (design 18.9, principle 2): every time is the Worker's, never a node's.

### 6.2 `GET /health`

Public. 200 `{"status": "ok", "version": "<version of worker/package.json>"}`.

### 6.3 D1

The migrations create at least these tables and columns (more columns are allowed). Times are timestamps (section 4.1) stored as text.

| Table | Columns |
| --- | --- |
| `nodes` | `node_id` (primary key), `owner_label`, `token_hash` (hexadecimal SHA-256 of the token), `state` (`healthy` or `disabled` in lot 2), `state_since`, `last_heartbeat_at`, `version`, `hourly_budget` (default 60), `created_at`, `revoked_at` |
| `jobs` | `video_id`, `kind` (`primary` only in lot 2), primary key (`video_id`, `kind`), `priority`, `status` (`queued`, `leased`, `done`, `failed_video`), `leased_by`, `lease_id`, `lease_expires_at`, `attempts`, `tried_nodes` (JSON array of node ids, in claim order), `last_outcome`, `created_at`, `done_at` |
| `leases` | `lease_id` (primary key), `video_id`, `node_id`, `issued_at`, `expires_at`, `state` (`active`, `completed`, `released`, `expired`, `revoked`, `rejected`), `response_json` (the body answered when it was completed or released) |
| `node_events` | `node_id`, `ts`, `kind` (`job_ok`, `job_no_transcript`, `job_unavailable`, `job_blocked`, `job_error`, `lease_expired`, `validation_failed`), `video_id` |
| `invites` | `email` (primary key, lowercased), `invited_at`, `accepted_user_sub`, `revoked` (0 or 1) |
| `users` | `user_sub` (primary key, the Google `sub`), `email`, `role` (`admin` or `member`), `google_refresh_token_enc`, `created_at` |
| `oauth_clients` | `client_id` (primary key), `client_name`, `redirect_uris` (JSON array), `created_at` |
| `oauth_requests` | pending authorizations: `request_id` (primary key), `client_id`, `redirect_uri`, `client_state`, `code_challenge`, `scope`, `resource`, `google_state`, `google_nonce`, `expires_at`, `used_at` |
| `oauth_codes` | `code_hash` (primary key), `client_id`, `user_sub`, `redirect_uri`, `code_challenge`, `scope`, `resource`, `expires_at`, `used_at` |
| `oauth_tokens` | `token_hash` (primary key), `kind` (`access` or `refresh`), `client_id`, `user_sub`, `family_id`, `scope`, `resource`, `expires_at`, `used_at`, `revoked_at` |

Secrets are never stored in clear: node tokens, authorization codes, access and refresh tokens are stored as their hexadecimal SHA-256; the Google refresh token is encrypted with AES-GCM (key `TOKEN_ENC_KEY`, a random 12-byte IV per value, stored as `v1:` followed by the base64 of IV and ciphertext).

### 6.4 R2

The local R2 binding `TRANSCRIPTS` (Miniflare, persisted under `.stack/state/`). One object per transcript, key `transcripts/<video_id>.json`, body the transcript result JSON as the node sent it (UTF-8, not compressed), `contentType` `application/json`, custom metadata `node_id`, `lease_id` and `produced_at` (timestamp). An existing object is never overwritten (design 18.9, C5).

## 7. Operator endpoints (`/ops/*`)

A local stand-in for the admin tools of later lots, used by the tests. They exist only when `OPS_TOKEN` is set and not empty; otherwise every `/ops/*` request gives 404 `not_found`. Each request needs `Authorization: Bearer $OPS_TOKEN` (compared in constant time); a missing or wrong bearer gives 401 `unauthorized`. Authentication is checked before the body. Successes are 200.

| Route | Body | Response |
| --- | --- | --- |
| `POST /ops/reset` | none | `{"ok": true}`. Deletes every row of every table of 6.3 and every R2 object under `transcripts/` |
| `POST /ops/nodes` | `{"node_id": "^[a-z0-9][a-z0-9-]{0,62}$", "owner_label": <1 to 100 characters>}` | `{"node_id", "owner_label", "token"}`, the token shown once: `ytd_node_` followed by 43 characters of `[A-Za-z0-9_-]` (32 random bytes, base64url). Node `state` `healthy`. A `node_id` that exists (revoked or not): 409 `conflict` |
| `DELETE /ops/nodes/<node_id>` | none | `{"node_id", "state": "disabled"}`, section 8.8; again on a revoked node: the same 200; unknown node: 404 `not_found` |
| `POST /ops/jobs` | `{"video_ids": [1 to 100 video ids], "priority"?: integer ≥ 0, default 0}` | `{"enqueued": [...], "existing": [...]}` in request order: a new id becomes a `queued` job with this priority; an existing job is left as it is, except that its priority becomes the larger of the two (design 18.9, C8) |
| `GET /ops/jobs/<video_id>` | none | `{"video_id", "kind", "priority", "status", "leased_by", "lease_expires_at", "attempts", "tried_nodes", "last_outcome", "created_at", "done_at"}` (nulls where empty), after the expiry sweep of 8.6; unknown: 404 `not_found` |
| `GET /ops/transcripts/<video_id>` | none | `{"video_id", "transcript": <the stored transcript result>, "node_id", "lease_id", "produced_at"}` read from R2; no object: 404 `not_found` |
| `POST /ops/invites` | `{"email": <string containing @>}` | `{"email": <lowercased>, "revoked": false}`; inviting again re-activates a revoked invite |
| `POST /ops/invites/revoke` | `{"email"}` | `{"email", "revoked": true}`; unknown: 404 `not_found` |
| `GET /ops/users` | none | `{"users": [{"user_sub", "email", "role"}]}`, sorted by e-mail |

`last_outcome` is null or one of `ok`, `no_transcript`, `unavailable`, `blocked`, `error`, `validation_failed`, `lease_expired`, `lease_revoked`, `released`.

## 8. Node protocol (`/node/*`)

### 8.1 Authentication

Every `/node/*` request needs `Authorization: Bearer <node token>`. A missing bearer, a token whose hash is unknown, or the token of a revoked node gives 401 `unauthorized`, and nothing else happens. The node is the one the token belongs to: no request names its own node id. A node token is accepted nowhere else (section 11.1), and no other bearer (operator, OAuth) is accepted on `/node/*`. All four endpoints are `POST` with a JSON body, validated against section 4.1 (400 `invalid_request`). After authentication and validation, every `/node/*` request first runs the expiry sweep (8.6).

### 8.2 `POST /node/heartbeat`

Records `last_heartbeat_at` (now) and `version`, and answers 200 `{"node_id", "state": "healthy", "hourly_budget": <nodes.hourly_budget>, "directive": "run"}`. Health states and directives other than these are out of scope.

### 8.3 `POST /node/claim`

A job is **eligible** for the calling node when its `status` is `queued` and the node is not in its `tried_nodes`. The claim takes, atomically, up to `max_jobs` eligible jobs ordered by `priority` descending, then `created_at` ascending, then `video_id` ascending, and for each: `status` `leased`, `leased_by` the node, a new random `lease_id` (unique, at least 16 characters), `lease_expires_at` = now + `LEASE_SECONDS`, `attempts` + 1, the node appended to `tried_nodes`, and a new `leases` row in state `active`. It answers 200 `{"jobs": [...]}` in that order, with as many jobs as `min(max_jobs, eligible jobs)`, possibly none. Concurrent claims each still answer `min(max_jobs, eligible jobs at that moment)`: a claim never comes back short because another one runs at the same time. Hourly budgets are not enforced in lot 2.

### 8.4 `POST /node/result`

Steps, in order:

1. Authentication (8.1), then the body schema (400 `invalid_request`, nothing changes), then the expiry sweep.
2. **Lease check**: if no lease has this `lease_id`, or it belongs to another node, or its state is `released`, `expired`, `revoked` or `rejected`: 409 `stale_lease`; nothing is written (no R2 write, no counter), the event `job.stale_result` is logged (design 18.9, C2). If its state is `completed`: 200 with its stored `response_json`, and nothing changes, whatever the new body holds (C3).
3. **Validation** (design 18.5, reduced): with `outcome` `ok`, `transcript` must not be null, its `status` must be `ok`, its `video_id` the job's, its `pages` not empty, and its `word_count` equal to the number of whitespace-separated tokens of all pages other than `[…]`; with any other outcome, `transcript` must be null. The transcript-result schema holds no cross-field rule: consistency between `outcome`, the transcript's `status` and its other fields is checked here only. A failure gives 422 `validation_failed`: the lease becomes `rejected`, a `validation_failed` node event is recorded, and the job goes through the failure handling of 8.7 with `last_outcome` `validation_failed`.
4. **Outcome**, the lease becoming `completed` (except on the 503 below), a node event `job_<outcome>` being recorded and `last_outcome` set to the outcome:
   - `ok`: the transcript is written to R2 (6.4) unless an object exists; then the job becomes `done` with `done_at`. If the R2 write fails: 503 `storage_error`, the lease stays `active` and the job `leased` (C4).
   - `no_transcript`: terminal at once (design 18.3): the job becomes `done`, nothing is written to R2.
   - `unavailable`, `blocked`, `error`: failure handling (8.7).
5. The answer is 200 `{"video_id", "status": <the job's status now>}`, also stored as the lease's `response_json`.

### 8.5 `POST /node/release`

Gives back a job the node will not process (clean stop). After step 1 of 8.4: an unknown lease, another node's lease, or a lease in state `completed`, `expired`, `revoked` or `rejected` gives 409 `stale_lease`; a lease already `released` gives 200 with its stored `response_json`. Otherwise the release undoes the claim: `status` `queued`, `leased_by`, `lease_id` and `lease_expires_at` null, `attempts` − 1, the node removed from `tried_nodes`, `last_outcome` `released`, the lease `released`; the answer is 200 `{"video_id", "status": "queued"}`, stored as the lease's `response_json`.

### 8.6 Lease expiry

The expiry sweep runs at the start of every `/node/*` request (after authentication and validation) and of every `GET /ops/jobs/<video_id>`. Every `leased` job whose `lease_expires_at` is at or before now: its lease becomes `expired`, a `lease_expired` node event is recorded against the holder, `last_outcome` becomes `lease_expired`, and the job goes through the failure handling of 8.7. The node stays in `tried_nodes`, so the job goes to another node.

### 8.7 Failure handling and attempts

A job that fails (`unavailable`, `blocked`, `error`, a validation failure, an expired or revoked lease) gets `leased_by`, `lease_id` and `lease_expires_at` null, then: `status` `failed_video` with `done_at` when `attempts` ≥ 3, otherwise `queued`. Since a node in `tried_nodes` is never eligible, the at most 3 attempts are on 3 distinct nodes. A `failed_video` or `done` job is never handed out again.

| From | Event | To |
| --- | --- | --- |
| `queued` | claim | `leased` (attempts + 1) |
| `leased` | result `ok` or `no_transcript` | `done` |
| `leased` | result `unavailable`, `blocked`, `error`; 422; lease expired; node revoked | `queued`, or `failed_video` when attempts ≥ 3 |
| `leased` | release | `queued` (attempts − 1) |

### 8.8 Node revocation

`DELETE /ops/nodes/<node_id>` sets the node's `state` to `disabled` and `revoked_at`; its token is refused from then on (401). Each `active` lease of the node becomes `revoked`, and its job goes through the failure handling of 8.7 with `last_outcome` `lease_revoked` (design 18.9, C10).

### 8.9 Concurrency and idempotence

There is no `ClusterCoordinator` Durable Object in lot 2. Every write that decides who holds a job is a single conditional SQL statement (for example `UPDATE … WHERE status = 'queued' AND … RETURNING`) or a D1 batch, so that concurrent claims never hand out the same job (C1) and a result is accepted only for the current lease (C2). Retrying any `/node/*` request after a network failure has no side effect beyond the first (principle 3). No `/node/*` response holds user data (design 18.3): only node ids, video ids, leases and job states.

## 9. Node daemon

`uv run --project node yt-digest-node work [--once]`, in the package of lot 1.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_URL` | required | the Worker's base URL |
| `NODE_TOKEN` | required | the node's bearer |
| `CLAIM_BATCH` | `3` | `max_jobs` of each claim (1 to 10) |
| `POLL_SECONDS` | `10` | wait after a claim that returned no job |
| `HEARTBEAT_SECONDS` | `60` | heartbeat interval |

The variables of lot 1 section 5.1 apply to the pipeline. A missing `WORKER_URL` or `NODE_TOKEN` exits 2 without any request.

- **Cycle**: a heartbeat at start and then every `HEARTBEAT_SECONDS` (`version` = the package version, `uptime_s`, `jobs_in_progress`; optional fields omitted); a claim of `CLAIM_BATCH` jobs; for each claimed job, in order, the pipeline of lot 1 (in process, languages from `TRANSCRIPT_LANGS`), then `POST /node/result` with `outcome` = the result's `status` and `transcript` = the result when `ok`, null otherwise. A pipeline exception gives `outcome` `error` and `transcript` null.
- **Retries**: a network error or a 5xx on `/node/result` or `/node/release` is retried 3 times, after 1, 2 and 4 seconds; a 4xx is not retried.
- **`--once`**: one heartbeat, one claim, the claimed jobs, then exit 0. A heartbeat or claim that fails (network error or non-2xx) exits 1.
- **Loop** (without `--once`): runs until SIGTERM or SIGINT, which finish the job in progress (its result is posted), release the other claimed jobs and exit 0. A 401 on any call exits 1.
- **Logs** on standard error (lot 1 section 4.4), which holds only log lines (one JSON object per line): `service.started` first, one `worker.call` per request (section 12), one `fetch.transcript` per job as in lot 1. The token is never logged.

## 10. OAuth for MCP clients

The Worker is the authorization server and the resource server (design 4.7.1); the fake Google is only the upstream identity provider. It may be built on `@cloudflare/workers-oauth-provider` or by hand; either way the behaviour below is required. Below, `BASE` is `PUBLIC_URL` and the resource is `BASE/mcp`. The only scope is `digest`. OAuth errors are JSON `{"error": "<code>", "error_description"?: "<text>"}` (RFC 6749), or redirect parameters `error` and `state` where stated.

### 10.1 Discovery

- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728): 200 `{"resource": "BASE/mcp", "authorization_servers": ["BASE"], "scopes_supported": ["digest"], "bearer_methods_supported": ["header"]}`.
- `GET /.well-known/oauth-authorization-server` (RFC 8414): 200 with `issuer` `BASE`, `authorization_endpoint` `BASE/authorize`, `token_endpoint` `BASE/token`, `registration_endpoint` `BASE/register`, `response_types_supported` `["code"]`, `grant_types_supported` `["authorization_code", "refresh_token"]`, `code_challenge_methods_supported` `["S256"]`, `token_endpoint_auth_methods_supported` `["none"]`, `scopes_supported` `["digest"]`.

### 10.2 Dynamic client registration: `POST /register`

JSON body (RFC 7591): `redirect_uris` (required, 1 to 10 strings), `client_name` (optional, up to 200 characters), `token_endpoint_auth_method` (optional, only `none`), `grant_types` (optional, a subset of `authorization_code`, `refresh_token`), `response_types` (optional, only `code`). A redirect URI is valid when it is an absolute `https://` URL, or an `http://` URL whose host is `127.0.0.1` or `localhost`, without a fragment. Answers: 201 `{"client_id", "client_id_issued_at" (Unix seconds), "client_name" (when given), "redirect_uris", "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]}`, the `client_id` random and at least 16 characters; 400 `invalid_redirect_uri` when `redirect_uris` is missing, empty or holds an invalid URI; 400 `invalid_client_metadata` for any other invalid field. Every client is public (no secret).

### 10.3 `GET /authorize` and the consent page

Parameters: `response_type`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `resource`, `scope` (optional, default `digest`), `state` (optional, returned unchanged).

1. An unknown `client_id`, or a `redirect_uri` missing or not exactly one of the client's registered URIs: 400 HTML error page, **never a redirect**.
2. Otherwise each error redirects (302) to `redirect_uri` with `error` and `state`: `response_type` not `code` → `unsupported_response_type`; `code_challenge` missing, or `code_challenge_method` other than `S256` (absent or `plain` included) → `invalid_request`; `resource` missing or not exactly `BASE/mcp` → `invalid_target`; a scope other than `digest` → `invalid_scope`. Checked in this order.
3. Otherwise a pending authorization is stored (valid `AUTH_REQUEST_TTL_SECONDS`) and the Worker answers 200 with **its own consent page** (`text/html`, design 4.7.1): it shows the client name (or the `client_id` when the client has no name), the `redirect_uri` and the requested scope, all HTML-escaped, and holds a `<form method="post" action="/authorize/consent">` with a hidden input `name="request"` (the pending authorization's id, random, at least 16 characters) and two submit buttons `<button type="submit" name="decision">`, with `value="approve"` and `value="deny"`.

`POST /authorize/consent` (form-encoded `request`, `decision`): an unknown, expired or already used `request` gives 400 HTML. `deny`: the pending authorization is used up, and the answer is 302 to the client's `redirect_uri` with `error=access_denied` and its `state`. `approve`: 302 to the `authorization_endpoint` of `GOOGLE_ISSUER`'s discovery document with `client_id` (`GOOGLE_CLIENT_ID`), `redirect_uri` (`BASE/callback`), `response_type=code`, `scope` (`openid email https://www.googleapis.com/auth/youtube.readonly`), `state` (a new random value bound to the pending authorization), `nonce` (a new random value), `access_type=offline` and `prompt=consent`.

### 10.4 `GET /callback` and access control

1. A `state` that matches no unexpired, unused pending authorization: 400 HTML. The pending authorization is used up by this request.
2. An `error` parameter from Google: 302 to the client with `error=access_denied` and the client's `state`.
3. The Worker exchanges the `code` at Google's token endpoint (client secret in the body), then verifies the ID token: RS256 signature with a key of the JWKS, `iss` = `GOOGLE_ISSUER`, `aud` = `GOOGLE_CLIENT_ID`, `exp` in the future, `nonce` = the one it sent. Any failure: 302 to the client with `error=server_error`.
4. **Access control** (design 10.1): the e-mail (lowercased) is admitted when it equals `ADMIN_EMAIL` (role `admin`, no invite needed) or has an invite that is not revoked (role `member`). Otherwise, or when `email_verified` is not true: **403 HTML refusal page** whose `<title>` is `Access refused` and whose text holds the sentence `This account is not invited.`, and no row is written to `users`.
5. Admitted: the `users` row is created or updated (`user_sub` = the ID token's `sub`, `email`, `role`, the Google refresh token encrypted, 6.3), the invite's `accepted_user_sub` is set, a single-use authorization code (random, valid `AUTH_CODE_TTL_SECONDS`) is bound to the client, the user, the `redirect_uri`, the `code_challenge`, the scope and the resource, and the answer is 302 to the client's `redirect_uri` with `code` and the client's `state`.

### 10.5 `POST /token`

Form-encoded only (anything else: 400 `invalid_request`). Answers 200 carry `Cache-Control: no-store` and `{"access_token", "token_type": "Bearer", "expires_in": ACCESS_TOKEN_TTL_SECONDS, "refresh_token", "scope": "digest"}`; both tokens are opaque random strings of at least 32 characters. An unknown `client_id` gives 401 `invalid_client`; a `grant_type` other than the two below, 400 `unsupported_grant_type`.

- `grant_type=authorization_code` with `code`, `redirect_uri`, `client_id`, `code_verifier` and `resource`: a missing parameter gives 400 `invalid_request`; a `resource` other than `BASE/mcp`, 400 `invalid_target`; a code that is unknown, expired, already used, issued to another client or for another `redirect_uri`, or whose challenge is not `BASE64URL(SHA-256(code_verifier))` without padding, 400 `invalid_grant`. The checks run in this order: grant type, client, missing parameters, `resource`, then the code; a code is used up by the first exchange that reaches the code check, successful or not.
- `grant_type=refresh_token` with `refresh_token`, `client_id` and optionally `resource` (if present, it must be `BASE/mcp`, else `invalid_target`): **rotation** (design 4.7.3): a valid refresh token is marked used and a new access and refresh token pair of the same family is issued; earlier access tokens stay valid until they expire. **Reuse detection**: a refresh token that was already used gives 400 `invalid_grant`, revokes every token of its family (access tokens included) and logs `auth.refresh.reuse_detected`. An unknown, expired or revoked refresh token, or one issued to another client: 400 `invalid_grant`.

A family is every token descended from one authorization code.

### 10.6 Accepting an access token

A bearer is a valid access token when its hash is a known `access` token that is not expired or revoked, whose resource is `BASE/mcp`, and whose user is still admitted under 10.4 step 4, **read again on every request** (design 4.7.2): revoking an invite (`POST /ops/invites/revoke`) refuses that user's tokens at once.

## 11. MCP endpoint

### 11.1 Transport and authentication

`POST /mcp`, MCP Streamable HTTP, JSON-RPC 2.0, protocol version `2025-06-18` (the server must accept it in `initialize`, and the `protocolVersion` of the `initialize` result is `2025-06-18`). The client sends `Accept: application/json, text/event-stream`; the server may answer a request with `application/json` or with a `text/event-stream` holding the response. If the `initialize` response carries an `Mcp-Session-Id` header, the client sends it back on every later request; the server may also be stateless. A notification (for example `notifications/initialized`) is answered 202 without a body. `ping`, `tools/list` and `tools/call` are supported.

Every `/mcp` request without a valid access token (10.6), node and operator tokens included, gets 401 with `{"error": "invalid_token", "error_description"?}` and the header `WWW-Authenticate: Bearer resource_metadata="BASE/.well-known/oauth-protected-resource"` (more parameters are allowed).

### 11.2 Origin check

When a `/mcp` request has an `Origin` header that is neither the origin of `BASE` nor one of `ALLOWED_ORIGINS`, it gets 403 `origin_rejected` (error body of 4.2) before authentication, and `auth.origin.rejected` is logged. A request without `Origin` passes.

### 11.3 The tool

`tools/list` returns exactly one tool, `list_subscriptions`, whose input schema is an object without properties. `tools/call` of `list_subscriptions` returns a result with `isError` false and one text content whose text is the compact JSON `{"subscriptions":[]}` (there are no subscriptions in lot 2). Each call logs `mcp.tool.call`.

## 12. Logs

New events of the catalogue (lot 1 section 4.2 for the common fields). `video_id` is the top-level field whenever a job is concerned.

| Event | Service | `attrs` |
| --- | --- | --- |
| `node.enrolled` | worker | `node_id` |
| `node.revoked` | worker | `node_id`, `leases_revoked` |
| `node.heartbeat` | worker | `node_id`, `version`, `jobs_in_progress` |
| `job.enqueued` | worker | `count`, `priority` |
| `job.claimed` | worker | `node_id`, `attempt`, `lease_seconds` |
| `job.completed` | worker | `node_id`, `outcome`, `status` (the job's status after) |
| `job.released` | worker | `node_id` |
| `job.lease_expired` | worker | `node_id`, `attempts`, `status` |
| `job.stale_result` | worker | `node_id` |
| `job.validation_failed` | worker | `node_id`, `reason` |
| `auth.bearer.rejected` | worker | `surface` (`node`, `mcp`, `ops`), `reason` (`missing`, `unknown`, `expired`, `revoked`) |
| `auth.client.registered` | worker | `client_id` |
| `auth.oauth.completed` | worker | `client_id`, `role` |
| `auth.oauth.denied` | worker | `client_id`, `reason` (`access_denied`, `not_invited`, `email_unverified`, `google_error`) |
| `auth.token.issued` | worker | `client_id`, `grant_type` |
| `auth.refresh.reuse_detected` | worker | `client_id`, `revoked` (tokens revoked) |
| `auth.origin.rejected` | worker | `origin` |
| `mcp.tool.call` | worker | `tool`, `outcome` (`ok`, `error`), `duration_ms` |
| `worker.call` | node | `endpoint` (`heartbeat`, `claim`, `result`, `release`), `status` (HTTP status, 0 on a network error), `duration_ms` |

The Worker writes one JSON line per event to its console, so that each event is a line of `.stack/logs/worker.log`. **Never in a log line**: a node token, the operator token, an authorization code, an access or refresh token (Google's included), an ID token, an e-mail address, a Google `sub`, transcript text.

## 13. End-to-end tests of the attempt

Playwright Test in `e2e/`, run by the `e2e` check against the stack of section 5, with two projects: `api` (HTTP only, no browser) and `browser` (Chromium). They cover at least:

| Design id | Scenario | Project |
| --- | --- | --- |
| E2E-13 (reduced) | 2 nodes claim 6 jobs concurrently: each job handed out once, all 6 done | api |
| E2E-14 | A lease expires: the job goes to another node, the first node's late result gets 409 | api |
| E2E-16 (reduced) | `unavailable` on 3 nodes: `failed_video`, a 4th node gets nothing | api |
| E2E-20 | A revoked node: claim and result refused, its job reassigned | api |
| E2E-21 | `/node/*` responses hold no user data | api |
| E2E-27 | `/mcp` without token: 401 and `WWW-Authenticate`; discovery documents served and consistent | api |
| E2E-28 | Registration, PKCE, `resource`, consent, fake Google login: the token lists and calls `list_subscriptions` | browser |
| E2E-29 | No PKCE, `plain` PKCE, a non-exact `redirect_uri`: refused | api |
| E2E-31 | Refresh rotation; reuse of an old refresh token revokes the family | api |
| E2E-02 | A non-invited user gets the 403 page and no `users` row | browser |
| E2E-33 | A revoked invite: the user's valid access token is refused | api |
| E2E-37 | A node token on `/mcp`, an access token on `/node/*`: refused | api |

Each test starts from `POST /ops/reset`. The browser login goes through the mocks server's sign-in page.

## 14. Quality bar

- Lot 1's bar, extended to `worker/` and `e2e/`: TypeScript `strict`, no `any`; Python `mypy --strict`.
- Every rule of sections 7 to 11 is covered by a Worker or node test that fails without it; the transitions of 8.7 and the lease checks of 8.4 and 8.5 at their edges (expiry exactly at `lease_expires_at`, the third attempt).
- Choices left open are written in `docs/decisions.md`, one dated line each, as in lot 1.
