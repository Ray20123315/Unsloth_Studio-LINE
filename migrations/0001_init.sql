PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_settings (
  line_user_id TEXT PRIMARY KEY,
  model TEXT,
  temperature REAL NOT NULL DEFAULT 0.7,
  top_p REAL NOT NULL DEFAULT 0.95,
  top_k INTEGER NOT NULL DEFAULT 20,
  max_tokens INTEGER NOT NULL DEFAULT 2048,
  repetition_penalty REAL NOT NULL DEFAULT 1.0,
  enable_thinking INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  event_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages(conversation_key, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_event_role
ON messages(event_id, role)
WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('received', 'queued', 'done', 'failed')),
  retry_key TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
ON webhook_events(status, updated_at);
