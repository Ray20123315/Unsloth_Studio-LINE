import type { Env, LineMessage } from "./types";
import { retryKeyForBatch, splitLineText } from "./utils";

const LINE_API = "https://api.line.me";

export async function verifyLineSignature(
  rawBody: string,
  receivedSignature: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!receivedSignature || !channelSecret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = bytesToBase64(new Uint8Array(signature));
  return constantTimeEqual(expected, receivedSignature);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function lineFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`);
  headers.set("Content-Type", "application/json");

  const response = await fetch(`${LINE_API}${path}`, { ...init, headers });

  // For retryable push APIs, LINE returns 409 when the same X-Line-Retry-Key
  // was already accepted. Treat that as idempotent success rather than failure.
  if (response.status === 409 && headers.has("X-Line-Retry-Key")) return response;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE API ${response.status}: ${body.slice(0, 600)}`);
  }
  return response;
}

export async function replyMessages(env: Env, replyToken: string, messages: LineMessage[]): Promise<void> {
  if (!replyToken || messages.length === 0) return;
  await lineFetch(env, "/v2/bot/message/reply", {
    method: "POST",
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
}

export async function pushMessages(
  env: Env,
  to: string,
  messages: LineMessage[],
  retryKey: string,
): Promise<void> {
  const batches: LineMessage[][] = [];
  for (let i = 0; i < messages.length; i += 5) batches.push(messages.slice(i, i + 5));

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    if (!batch || batch.length === 0) continue;
    await lineFetch(env, "/v2/bot/message/push", {
      method: "POST",
      headers: { "X-Line-Retry-Key": retryKeyForBatch(retryKey, i) },
      body: JSON.stringify({ to, messages: batch }),
    });
  }
}

export async function pushLongText(env: Env, to: string, text: string, retryKey: string): Promise<void> {
  const messages: LineMessage[] = splitLineText(text).map((chunk) => ({ type: "text", text: chunk }));
  await pushMessages(env, to, messages, retryKey);
}

export async function startLoading(env: Env, chatId: string, seconds = 60): Promise<void> {
  try {
    await lineFetch(env, "/v2/bot/chat/loading/start", {
      method: "POST",
      body: JSON.stringify({ chatId, loadingSeconds: seconds }),
    });
  } catch {
    // Loading animation is optional and may not be available in every chat context.
  }
}
