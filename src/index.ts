import {
  createWebhookEvent,
  ensureUserSettings,
  getEventMessage,
  getHistory,
  getWebhookEvent,
  saveMessage,
  setWebhookStatus,
  trimHistory,
  updateSetting,
} from "./db";
import { handlePostbackCommand, handleTextCommand } from "./commands";
import { pushLongText, replyMessages, startLoading, verifyLineSignature } from "./line";
import { chatCompletion, listModels, UnslothApiError } from "./unsloth";
import type { Env, InferenceJob, LineSource, LineWebhookBody, LineWebhookEvent } from "./types";
import { allowedUserIds, envInt, safeErrorMessage } from "./utils";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "line-unsloth-worker", version: "0.0.1" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");
    const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response("Invalid signature", { status: 401 });

    let body: LineWebhookBody;
    try {
      body = JSON.parse(rawBody) as LineWebhookBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const events = body.events ?? [];
    if (events.length === 0) return new Response("OK", { status: 200 });

    try {
      await Promise.all(events.map((event) => handleWebhookEvent(event, env, ctx)));
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("webhook handling failed", error);
      return new Response("Webhook processing failed", { status: 500 });
    }
  },

  async queue(batch: MessageBatch<InferenceJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processInferenceJob(message.body, env);
        message.ack();
      } catch (error) {
        const detail = safeErrorMessage(error);
        console.error("queue inference failed", {
          messageId: message.id,
          attempts: message.attempts,
          error: detail,
        });

        if (message.attempts >= 3) {
          try {
            await setWebhookStatus(env.DB, message.body.eventId, "failed", detail.slice(0, 1000));
            await pushLongText(
              env,
              message.body.chatId,
              `模型呼叫失敗。\n\n${userFacingInferenceError(error)}`,
              message.body.retryKey,
            );
          } catch (notifyError) {
            console.error("failed to send terminal error", notifyError);
          }
          message.ack();
        } else {
          const delaySeconds = Math.min(60, 5 ** message.attempts);
          message.retry({ delaySeconds });
        }
      }
    }
  },
};

async function handleWebhookEvent(event: LineWebhookEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const ids = sourceIds(event.source);
  if (!ids) return;

  const { actorId, chatId, conversationKey, settingsUserId, isDirectUser } = ids;
  const allowlist = allowedUserIds(env.ALLOWED_LINE_USER_IDS);
  if (allowlist.size > 0 && !allowlist.has(actorId)) {
    if (event.replyToken) {
      await replyMessages(env, event.replyToken, [{ type: "text", text: "此帳號未被允許使用這個 Bot。" }]);
    }
    return;
  }

  const eventId = event.webhookEventId ?? `fallback-${event.timestamp ?? Date.now()}-${event.message?.id ?? crypto.randomUUID()}`;
  const existing = await getWebhookEvent(env.DB, eventId);
  if (existing?.status === "queued" || existing?.status === "done" || existing?.status === "failed") return;
  const state = existing ?? (await createWebhookEvent(env.DB, eventId, crypto.randomUUID()));

  if (event.type === "message" && event.message?.type === "text" && typeof event.message.text === "string") {
    const commandResult = await handleTextCommand(
      { env, settingsUserId, conversationKey, actorId },
      event.message.text,
    );

    if (commandResult.handled) {
      if (event.replyToken && commandResult.messages?.length) {
        await replyMessages(env, event.replyToken, commandResult.messages);
      }
      await setWebhookStatus(env.DB, eventId, "done");
      return;
    }

    const job: InferenceJob = {
      eventId,
      retryKey: state.retry_key,
      chatId,
      settingsUserId,
      conversationKey,
      text: event.message.text,
    };

    await env.LLM_QUEUE.send(job);
    await setWebhookStatus(env.DB, eventId, "queued");
    if (isDirectUser) ctx.waitUntil(startLoading(env, chatId, 60));
    return;
  }

  if (event.type === "postback" && typeof event.postback?.data === "string") {
    const result = await handlePostbackCommand(
      { env, settingsUserId, conversationKey, actorId },
      event.postback.data,
    );
    if (result.handled && event.replyToken && result.messages?.length) {
      await replyMessages(env, event.replyToken, result.messages);
    }
    await setWebhookStatus(env.DB, eventId, "done");
    return;
  }

  if (event.replyToken) {
    await replyMessages(env, event.replyToken, [
      { type: "text", text: "目前先支援文字聊天。輸入 /help 查看指令。" },
    ]);
  }
  await setWebhookStatus(env.DB, eventId, "done");
}

async function processInferenceJob(job: InferenceJob, env: Env): Promise<void> {
  const event = await getWebhookEvent(env.DB, job.eventId);
  if (event?.status === "done") return;

  const settings = await ensureUserSettings(env.DB, job.settingsUserId);
  await saveMessage(env.DB, job.conversationKey, job.eventId, "user", job.text);

  let answer = await getEventMessage(env.DB, job.eventId, "assistant");
  if (!answer) {
    const historyLimit = Math.max(2, envInt(env.MAX_HISTORY_MESSAGES, 20));
    const history = await getHistory(env.DB, job.conversationKey, historyLimit);
    let model = settings.model;

    if (!model) {
      const models = await listModels(env);
      model = models[0] ?? null;
      if (!model) throw new Error("Unsloth /v1/models 沒有回傳任何模型");
      await updateSetting(env.DB, job.settingsUserId, "model", model);
      settings.model = model;
    }

    const systemPrompt = settings.system_prompt ?? env.DEFAULT_SYSTEM_PROMPT;
    try {
      answer = await chatCompletion(env, settings, model, history, systemPrompt);
    } catch (error) {
      if (error instanceof UnslothApiError && error.status === 404 && /model/i.test(error.responseBody)) {
        const models = await listModels(env);
        const fallback = models[0];
        if (!fallback) throw error;
        await updateSetting(env.DB, job.settingsUserId, "model", fallback);
        settings.model = fallback;
        answer = await chatCompletion(env, settings, fallback, history, systemPrompt);
      } else {
        throw error;
      }
    }

    await saveMessage(env.DB, job.conversationKey, job.eventId, "assistant", answer);
  }

  await pushLongText(env, job.chatId, answer, job.retryKey);
  await setWebhookStatus(env.DB, job.eventId, "done");

  const keep = Math.max(20, envInt(env.MAX_STORED_MESSAGES, 200));
  await trimHistory(env.DB, job.conversationKey, keep);
}

function sourceIds(source: LineSource | undefined):
  | {
      actorId: string;
      chatId: string;
      settingsUserId: string;
      conversationKey: string;
      isDirectUser: boolean;
    }
  | null {
  if (!source) return null;

  if (source.type === "user" && source.userId) {
    return {
      actorId: source.userId,
      chatId: source.userId,
      settingsUserId: source.userId,
      conversationKey: source.userId,
      isDirectUser: true,
    };
  }

  const chatId = source.groupId ?? source.roomId;
  if (!chatId) return null;
  const actorId = source.userId ?? chatId;
  return {
    actorId,
    chatId,
    settingsUserId: actorId,
    conversationKey: `${chatId}:${actorId}`,
    isDirectUser: false,
  };
}

function userFacingInferenceError(error: unknown): string {
  if (error instanceof UnslothApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Unsloth API Key 驗證失敗，請檢查 Cloudflare Worker Secret：UNSLOTH_API_KEY。";
    }
    if (error.status === 404) {
      return "找不到指定模型或 API endpoint。可先在 LINE 輸入 /model 重新選模型。";
    }
    if (error.status === 429) return "Unsloth 目前太忙，稍後再試。";
    if (error.status >= 500) return "Unsloth 服務暫時發生錯誤，稍後再試。";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Unsloth 回應逾時。可能正在載入模型或生成時間過長。";
  }
  return "請查看 Cloudflare Worker Logs 取得詳細錯誤。";
}
