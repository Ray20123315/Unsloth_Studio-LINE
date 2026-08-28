import type { ConversationMessage, Env, UserSettings } from "./types";
import { envInt } from "./utils";

export class UnslothApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Unsloth API ${status}: ${responseBody.slice(0, 600)}`);
    this.name = "UnslothApiError";
  }
}

function baseUrl(env: Env): string {
  return env.UNSLOTH_BASE_URL.replace(/\/+$/, "");
}

async function unslothFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), envInt(env.UNSLOTH_TIMEOUT_MS, 540_000));

  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${env.UNSLOTH_API_KEY}`);
    if (init.body) headers.set("Content-Type", "application/json");

    const response = await fetch(`${baseUrl(env)}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new UnslothApiError(response.status, body);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listModels(env: Env): Promise<string[]> {
  const response = await unslothFetch(env, "/v1/models", { method: "GET" });
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const models = (body.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(models)];
}

export async function chatCompletion(
  env: Env,
  settings: UserSettings,
  model: string,
  messages: ConversationMessage[],
  systemPrompt: string,
): Promise<string> {
  const requestMessages: Array<{ role: string; content: string }> = [];
  if (systemPrompt.trim()) requestMessages.push({ role: "system", content: systemPrompt.trim() });
  requestMessages.push(...messages);

  const response = await unslothFetch(env, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: requestMessages,
      stream: false,
      temperature: settings.temperature,
      top_p: settings.top_p,
      top_k: settings.top_k,
      max_tokens: settings.max_tokens,
      repetition_penalty: settings.repetition_penalty,
      enable_thinking: Boolean(settings.enable_thinking),
    }),
  });

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };

  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .join("");
    if (text) return text;
  }

  throw new Error("Unsloth 回應成功，但 choices[0].message.content 沒有文字");
}
