export type Migration = {
  version: number;
  name: string;
  sql: string;
};

const INIT = `

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  parent_id INTEGER,
  fork_entry_id INTEGER,
  archived_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model JSONB,
  data JSONB,
  by_task_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_conv ON entries(conversation_id, id);
CREATE TABLE IF NOT EXISTS docs (
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (conversation_id, kind)
);
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  when_busy TEXT NOT NULL DEFAULT 'steer',
  answer_entry_id INTEGER,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS submissions_conv ON submissions(conversation_id, status);
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run',
  fence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  owner TEXT,
  lease_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, lease_until);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancels (
  conversation_id INTEGER PRIMARY KEY,
  requested_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_tasks (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args JSONB NOT NULL,
  replay_safe BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_tasks_status ON tool_tasks(status);

`;

const SEARCH = `
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(model::text, ''))) STORED;
CREATE INDEX IF NOT EXISTS entries_search_idx ON entries USING GIN(search);
CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON conversations(id);
`;

const TENANCY = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
INSERT INTO tenants(id, name, created_at)
VALUES('default', 'Default tenant', 0)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  label TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entries ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE docs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE tool_tasks ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS conversations_tenant ON conversations(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS entries_tenant ON entries(tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS submissions_tenant ON submissions(tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS jobs_tenant ON jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS tool_tasks_tenant ON tool_tasks(tenant_id, status);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversations;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON entries;
CREATE POLICY tenant_isolation ON entries
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON docs;
CREATE POLICY tenant_isolation ON docs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON submissions;
CREATE POLICY tenant_isolation ON submissions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jobs;
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE tool_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tool_tasks;
CREATE POLICY tenant_isolation ON tool_tasks
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`;

const TENANT_CONTROL = `
ALTER TABLE settings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (tenant_id, key);
ALTER TABLE cancels ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settings;
CREATE POLICY tenant_isolation ON settings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE cancels ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cancels;
CREATE POLICY tenant_isolation ON cancels
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`;

const TOKEN_LIFECYCLE = `
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS id BIGSERIAL;
`;

const QUEUE_UNIQUENESS = `
DELETE FROM jobs a USING jobs b
 WHERE a.id < b.id
   AND a.conversation_id = b.conversation_id
   AND a.kind = b.kind
   AND a.status IN ('pending','running')
   AND b.status IN ('pending','running');

CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_run
  ON jobs(conversation_id) WHERE kind = 'run' AND status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_compact
  ON jobs(conversation_id) WHERE kind = 'compact' AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS jobs_active_conversation
  ON jobs(conversation_id) WHERE status IN ('pending','running');
`;

const QUOTA_RESERVATIONS = `
CREATE TABLE IF NOT EXISTS quota_state (
  tenant_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  day_tokens BIGINT NOT NULL DEFAULT 0,
  day_reserved_tokens BIGINT NOT NULL DEFAULT 0,
  month_tokens BIGINT NOT NULL DEFAULT 0,
  month_cost_micros BIGINT NOT NULL DEFAULT 0,
  month_reserved_cost_micros BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quota_reservations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  conversation_id INTEGER NOT NULL,
  submission_id INTEGER,
  tokens BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_reservations_submission
  ON quota_reservations(tenant_id, submission_id);
CREATE INDEX IF NOT EXISTS quota_reservations_status
  ON quota_reservations(tenant_id, status);

ALTER TABLE quota_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON quota_state;
CREATE POLICY tenant_isolation ON quota_state
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON quota_reservations;
CREATE POLICY tenant_isolation ON quota_reservations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`;

const SAAS_CONTROL_PLANE = `
CREATE TABLE IF NOT EXISTS usage_events (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  conversation_id INTEGER,
  submission_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_time ON usage_events(tenant_id, created_at);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usage_events;
CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS audit_events (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  data JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time ON audit_events(tenant_id, created_at);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`;

const ADMIN_TOKENS = `
CREATE TABLE IF NOT EXISTS admin_tokens (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS admin_tokens_hash ON admin_tokens(token_hash);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", sql: INIT },
  { version: 2, name: "postgres-fts", sql: SEARCH },
  { version: 3, name: "tenancy-rls", sql: TENANCY },
  { version: 4, name: "tenant-control-plane", sql: TENANT_CONTROL },
  { version: 5, name: "token-lifecycle", sql: TOKEN_LIFECYCLE },
  { version: 6, name: "saas-control-plane", sql: SAAS_CONTROL_PLANE },
  { version: 7, name: "queue-uniqueness", sql: QUEUE_UNIQUENESS },
  { version: 8, name: "quota-reservations", sql: QUOTA_RESERVATIONS },
  { version: 9, name: "admin-tokens", sql: ADMIN_TOKENS },
];

/** Highest schema version this build understands. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
