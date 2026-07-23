-- AGENT OS — single SQLite database at /var/lib/agent-os/data.db.
-- Every domain table carries tenant_id so one HQ serves many businesses.
-- CREATE TABLE IF NOT EXISTS everywhere: safe to run on every boot.

-- ── Tenants (the businesses AGENT OS serves) ────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  brand_colour TEXT NOT NULL DEFAULT '#19C3E6',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ── Users + sessions (shared creds with maxgleam, copied on first boot) ──
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',   -- owner | member
  password_hash TEXT,                            -- pbkdf2$iters$salt$hash
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER NOT NULL
);

-- ── Agents ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
  slug             TEXT NOT NULL,               -- unique per tenant (index below)
  name             TEXT NOT NULL,
  real_name        TEXT,                        -- human name shown on the avatar
  role             TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  certificate_json TEXT,                        -- structured DNA (JSON)
  soul_text        TEXT,                        -- personality prompt
  brand            TEXT,
  last_run_at      INTEGER,
  last_status      TEXT NOT NULL DEFAULT 'idle',
  last_summary     TEXT,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_tenant_slug ON agents(tenant_id, slug);

-- ── Agent activity log (with token/cost side-channel) ───────────────────
CREATE TABLE IF NOT EXISTS agent_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  agent_id     INTEGER NOT NULL REFERENCES agents(id),
  action       TEXT,
  summary      TEXT,
  details_json TEXT,
  token_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_logs_tenant ON agent_logs(tenant_id, created_at);

-- ── Inter-agent inbox ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  to_agent_id   INTEGER NOT NULL REFERENCES agents(id),
  from_agent_id INTEGER REFERENCES agents(id),      -- NULL = human operator
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending|read|replied|resolved
  thread_id     INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_to ON agent_inbox(to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_thread ON agent_inbox(thread_id);

-- ── Agent memory (mirrored into the Obsidian vault by vault.py) ─────────
CREATE TABLE IF NOT EXISTS agent_memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  agent_id     INTEGER,                          -- NULL = collective (shared)
  memory_type  TEXT NOT NULL,                    -- collective | personal
  topic        TEXT NOT NULL,
  fact         TEXT NOT NULL,
  confidence   REAL DEFAULT 1.0,
  source       TEXT,
  vault_path   TEXT,                             -- the .md file backing this row
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_used_at INTEGER,
  usage_count  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_topic ON agent_memory(tenant_id, topic);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);

-- ── External platform connections (bridges) ─────────────────────────────
CREATE TABLE IF NOT EXISTS connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  platform    TEXT NOT NULL,   -- hermes|chatgpt|fal|claude_sdk|kimi
  label       TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'unknown',   -- connected|disconnected|error|unknown
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_tenant ON connections(tenant_id);

-- ══════════════════════════════════════════════════════════════════════════
-- FEATURE MODULES (workflow pipelines, kanban, group chat, gallery, leads,
-- email, voice). Every table carries tenant_id for HQ-wide multi-business use.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Workflow pipelines ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipelines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',   -- [{type, config, position}]
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant ON pipelines(tenant_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  status      TEXT NOT NULL DEFAULT 'running',   -- running|success|error|partial
  started_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  finished_at INTEGER,
  result_json TEXT NOT NULL DEFAULT '{}',        -- {steps:[{position,type,status,output,ms}]}
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, started_at);

-- ── 2. Kanban board ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id),
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'backlog',  -- backlog|todo|in_progress|review|done
  priority          TEXT NOT NULL DEFAULT 'medium',   -- low|medium|high|urgent
  assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  labels_json       TEXT NOT NULL DEFAULT '[]',
  due_date          INTEGER,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_kanban_tenant_status ON kanban_tasks(tenant_id, status);

-- ── 3. Group chat (war room) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_tenant ON chat_rooms(tenant_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  from_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,  -- NULL = human operator
  from_name     TEXT NOT NULL DEFAULT 'Operator',
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, created_at);

-- ── 4. Workspace gallery ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  type          TEXT NOT NULL DEFAULT 'document',  -- image|document|post|code|video|design
  title         TEXT NOT NULL,
  description   TEXT,
  url           TEXT,
  thumbnail_url TEXT,
  model         TEXT,
  project_tag   TEXT,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_tenant ON workspace_items(tenant_id, type);

-- ── 5. Lead generation ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',   -- draft|active|paused|complete
  sent_count      INTEGER NOT NULL DEFAULT 0,
  reply_count     INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);

CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  company      TEXT NOT NULL,
  contact_name TEXT,
  email        TEXT,
  phone        TEXT,
  source       TEXT,
  status       TEXT NOT NULL DEFAULT 'new',   -- new|contacted|qualified|converted|lost
  campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  notes        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);

-- ── 6. Email agent ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  to_agent_id  INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  from_address TEXT,
  to_address   TEXT,
  subject      TEXT,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'unread',  -- unread|read|replied|archived|sent|bounced
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_emails_tenant ON agent_emails(tenant_id, status);

-- ── 7. Voice agent ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  transcript TEXT,
  response   TEXT,
  duration   INTEGER NOT NULL DEFAULT 0,   -- seconds
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_tenant ON voice_sessions(tenant_id, created_at);

-- ── Apollo voice-butler commands ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apollo_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  text        TEXT NOT NULL,               -- what the operator said
  response    TEXT,                         -- what Apollo replied
  intent      TEXT,                         -- chat|open|build|search|joke|teach
  action      TEXT,                         -- open|build|search|NULL (executed action)
  result_json TEXT,                         -- JSON payload of the action result
  status      TEXT NOT NULL DEFAULT 'done', -- done|failed
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_apollo_commands_tenant ON apollo_commands(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS oracle_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  keywords TEXT NOT NULL,
  results_json TEXT,
  ideas_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Custom Oracle sources: user-defined JSON APIs the scan aggregates alongside
-- the built-in feeds. url_template uses {kw} as the keyword placeholder;
-- response_path is a dot path to the results array (e.g. "hits", "data.children").
CREATE TABLE IF NOT EXISTS oracle_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  url_template TEXT NOT NULL,
  response_path TEXT NOT NULL DEFAULT 'hits',
  title_field TEXT NOT NULL DEFAULT 'title',
  url_field TEXT NOT NULL DEFAULT 'url',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  agent_id INTEGER,
  query TEXT NOT NULL,
  results_json TEXT,
  bookmarked INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
