import type { ConversationMessage, UserSettings } from "./types";

export async function ensureUserSettings(db: D1Database, userId: string): Promise<UserSettings> {
  await db
    .prepare("INSERT OR IGNORE INTO user_settings (line_user_id) VALUES (?)")
    .bind(userId)
    .run();

  const row = await db
    .prepare("SELECT * FROM user_settings WHERE line_user_id = ?")
    .bind(userId)
    .first<UserSettings>();

  if (!row) throw new Error("無法建立使用者設定");
  return row;
}

export async function getUserSettings(db: D1Database, userId: string): Promise<UserSettings | null> {
  return db
    .prepare("SELECT * FROM user_settings WHERE line_user_id = ?")
    .bind(userId)
    .first<UserSettings>();
}

export async function updateSetting(
  db: D1Database,
  userId: string,
  column:
    | "model"
    | "temperature"
    | "top_p"
    | "top_k"
    | "max_tokens"
    | "repetition_penalty"
    | "enable_thinking"
    | "system_prompt",
  value: string | number | null,
): Promise<void> {
  const allowed = new Set([
    "model",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "repetition_penalty",
    "enable_thinking",
    "system_prompt",
  ]);
  if (!allowed.has(column)) throw new Error("不允許的設定欄位");

  await ensureUserSettings(db, userId);
  await db
    .prepare(`UPDATE user_settings SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = ?`)
    .bind(value, userId)
    .run();
}

export async function getHistory(
  db: D1Database,
  conversationKey: string,
  limit: number,
): Promise<ConversationMessage[]> {
  const result = await db
    .prepare(
      "SELECT role, content FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(conversationKey, limit)
    .all<ConversationMessage>();

  return (result.results ?? []).reverse();
}

export async function saveMessage(
  db: D1Database,
  conversationKey: string,
  eventId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO messages (conversation_key, event_id, role, content) VALUES (?, ?, ?, ?)",
    )
    .bind(conversationKey, eventId, role, content)
    .run();
}

export async function getEventMessage(
  db: D1Database,
  eventId: string,
  role: "user" | "assistant",
): Promise<string | null> {
  const row = await db
    .prepare("SELECT content FROM messages WHERE event_id = ? AND role = ? LIMIT 1")
    .bind(eventId, role)
    .first<{ content: string }>();
  return row?.content ?? null;
}

export async function clearHistory(db: D1Database, conversationKey: string): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE conversation_key = ?").bind(conversationKey).run();
}

export async function trimHistory(
  db: D1Database,
  conversationKey: string,
  keep: number,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM messages
       WHERE conversation_key = ?
         AND id NOT IN (
           SELECT id FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT ?
         )`,
    )
    .bind(conversationKey, conversationKey, keep)
    .run();
}

export interface WebhookEventRow {
  event_id: string;
  status: "received" | "queued" | "done" | "failed";
  retry_key: string;
  last_error: string | null;
}

export async function getWebhookEvent(db: D1Database, eventId: string): Promise<WebhookEventRow | null> {
  return db
    .prepare("SELECT event_id, status, retry_key, last_error FROM webhook_events WHERE event_id = ?")
    .bind(eventId)
    .first<WebhookEventRow>();
}

export async function createWebhookEvent(
  db: D1Database,
  eventId: string,
  retryKey: string,
): Promise<WebhookEventRow> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO webhook_events (event_id, status, retry_key) VALUES (?, 'received', ?)",
    )
    .bind(eventId, retryKey)
    .run();

  const row = await getWebhookEvent(db, eventId);
  if (!row) throw new Error("無法建立 webhook event 狀態");
  return row;
}

export async function setWebhookStatus(
  db: D1Database,
  eventId: string,
  status: WebhookEventRow["status"],
  lastError: string | null = null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE webhook_events SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?",
    )
    .bind(status, lastError, eventId)
    .run();
}
