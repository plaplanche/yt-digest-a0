-- The tables of spec/lot-2.md section 6.3. Times are timestamps stored as text
-- (ISO 8601 UTC with milliseconds and Z); secrets are stored as their SHA-256 in hex.

CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  owner_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'disabled')),
  state_since TEXT NOT NULL,
  last_heartbeat_at TEXT,
  version TEXT,
  hourly_budget INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE jobs (
  video_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('primary')),
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed_video')),
  leased_by TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  tried_nodes TEXT NOT NULL DEFAULT '[]',
  last_outcome TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (video_id, kind)
);

CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'released', 'expired', 'revoked', 'rejected')),
  response_json TEXT
);

CREATE TABLE node_events (
  node_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('job_ok', 'job_no_transcript', 'job_unavailable', 'job_blocked', 'job_error', 'lease_expired', 'validation_failed')
  ),
  video_id TEXT
);

CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  invited_at TEXT NOT NULL,
  accepted_user_sub TEXT,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);

CREATE TABLE users (
  user_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  google_refresh_token_enc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_requests (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  google_state TEXT NOT NULL,
  google_nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  family_id TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
