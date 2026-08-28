export interface Env {
  DB: D1Database;
  LLM_QUEUE: Queue<InferenceJob>;

  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  UNSLOTH_API_KEY: string;

  UNSLOTH_BASE_URL: string;
  DEFAULT_SYSTEM_PROMPT: string;
  MAX_HISTORY_MESSAGES: string;
  MAX_STORED_MESSAGES: string;
  MAX_OUTPUT_TOKENS_HARD_LIMIT: string;
  UNSLOTH_TIMEOUT_MS: string;
  ALLOWED_LINE_USER_IDS: string;
}

export interface UserSettings {
  line_user_id: string;
  model: string | null;
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  repetition_penalty: number;
  enable_thinking: number;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InferenceJob {
  eventId: string;
  retryKey: string;
  chatId: string;
  settingsUserId: string;
  conversationKey: string;
  text: string;
}

export interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

export interface LineSource {
  type: "user" | "group" | "room" | string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineWebhookEvent {
  type: string;
  mode?: string;
  timestamp?: number;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  replyToken?: string;
  source?: LineSource;
  message?: {
    id?: string;
    type?: string;
    text?: string;
    quoteToken?: string;
  };
  postback?: {
    data?: string;
  };
}

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: {
    items: LineQuickReplyItem[];
  };
}

export interface LineQuickReplyItem {
  type: "action";
  action:
    | { type: "message"; label: string; text: string }
    | { type: "postback"; label: string; data: string; displayText?: string };
}

export type LineMessage = LineTextMessage;
