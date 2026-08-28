import { clearHistory, ensureUserSettings, updateSetting } from "./db";
import { listModels } from "./unsloth";
import type { Env, LineMessage, LineQuickReplyItem, UserSettings } from "./types";
import { envInt, parseFiniteNumber, shortLabel, splitLineText } from "./utils";

export interface CommandContext {
  env: Env;
  settingsUserId: string;
  conversationKey: string;
  actorId: string;
}

export interface CommandResult {
  handled: boolean;
  messages?: LineMessage[];
}

export async function handleTextCommand(ctx: CommandContext, text: string): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const arg = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const settings = await ensureUserSettings(ctx.env.DB, ctx.settingsUserId);

  switch (command) {
    case "/help":
    case "/start":
      return { handled: true, messages: [textMessage(helpText())] };

    case "/whoami":
      return { handled: true, messages: [textMessage(`你的 LINE User ID：\n${ctx.actorId}`)] };

    case "/status":
    case "/params":
      return { handled: true, messages: [paramsMessage(settings, ctx.env)] };

    case "/models": {
      const models = await listModels(ctx.env);
      if (models.length === 0) return { handled: true, messages: [textMessage("Unsloth 目前沒有回傳可用模型。") ] };
      const body = models.map((model, index) => `${index + 1}. ${model}`).join("\n");
      const fullText = `可用模型（${models.length}）：\n\n${body}\n\n切換方式：\n/model 完整模型ID`;
      const chunks = splitLineText(fullText).slice(0, 5);
      if (splitLineText(fullText).length > 5) {
        chunks[4] = `${chunks[4] ?? ""}\n\n（模型清單過長，只顯示前五則 LINE 訊息。）`;
      }
      return {
        handled: true,
        messages: chunks.map(textMessage),
      };
    }

    case "/model":
      if (!arg) return { handled: true, messages: [await modelPicker(ctx.env, settings)] };
      return { handled: true, messages: [await setModel(ctx.env, ctx.settingsUserId, arg)] };

    case "/temp":
      return numberSetting(ctx, "temperature", "Temperature", arg, 0, 2, false);

    case "/top_p":
      return numberSetting(ctx, "top_p", "Top P", arg, 0, 1, false);

    case "/top_k":
      return numberSetting(ctx, "top_k", "Top K", arg, 0, 1000, true);

    case "/tokens": {
      const hardLimit = envInt(ctx.env.MAX_OUTPUT_TOKENS_HARD_LIMIT, 16384);
      return numberSetting(ctx, "max_tokens", "Max Tokens", arg, 1, hardLimit, true);
    }

    case "/repeat":
      return numberSetting(ctx, "repetition_penalty", "Repetition Penalty", arg, 0.1, 2, false);

    case "/thinking": {
      const normalized = arg.toLowerCase();
      if (normalized !== "on" && normalized !== "off") {
        return { handled: true, messages: [textMessage("用法：/thinking on 或 /thinking off")] };
      }
      await updateSetting(ctx.env.DB, ctx.settingsUserId, "enable_thinking", normalized === "on" ? 1 : 0);
      return { handled: true, messages: [textMessage(`Thinking 已${normalized === "on" ? "開啟" : "關閉"}。`)] };
    }

    case "/system": {
      if (!arg) {
        const effective = settings.system_prompt ?? ctx.env.DEFAULT_SYSTEM_PROMPT;
        return {
          handled: true,
          messages: [textMessage(`目前 System Prompt：\n${effective || "（空白）"}\n\n/system reset：恢復預設\n/system off：設為空白`) ],
        };
      }
      if (arg.toLowerCase() === "reset") {
        await updateSetting(ctx.env.DB, ctx.settingsUserId, "system_prompt", null);
        return { handled: true, messages: [textMessage("System Prompt 已恢復 Worker 預設值。") ] };
      }
      if (arg.toLowerCase() === "off") {
        await updateSetting(ctx.env.DB, ctx.settingsUserId, "system_prompt", "");
        return { handled: true, messages: [textMessage("System Prompt 已設為空白。") ] };
      }
      if (arg.length > 4000) {
        return { handled: true, messages: [textMessage("System Prompt 太長，請控制在 4000 字元內。") ] };
      }
      await updateSetting(ctx.env.DB, ctx.settingsUserId, "system_prompt", arg);
      return { handled: true, messages: [textMessage("System Prompt 已更新。") ] };
    }

    case "/reset":
      await clearHistory(ctx.env.DB, ctx.conversationKey);
      return { handled: true, messages: [textMessage("這個對話的聊天記憶已清除；模型與參數設定保留。") ] };

    default:
      return { handled: true, messages: [textMessage(`不知道這個指令：${command}\n輸入 /help 查看可用指令。`) ] };
  }
}

export async function handlePostbackCommand(
  ctx: CommandContext,
  data: string,
): Promise<CommandResult> {
  const params = new URLSearchParams(data);
  const command = params.get("cmd");
  if (command !== "set_model") return { handled: false };
  const model = params.get("model");
  if (!model) return { handled: true, messages: [textMessage("模型資料無效，請重新輸入 /model。") ] };
  return { handled: true, messages: [await setModel(ctx.env, ctx.settingsUserId, model)] };
}

async function setModel(env: Env, userId: string, requested: string): Promise<LineMessage> {
  const models = await listModels(env);
  const exact = models.find((model) => model === requested);
  if (!exact) {
    return textMessage(`找不到模型：\n${requested}\n\n請輸入 /model 或 /models 重新選擇。`);
  }
  await updateSetting(env.DB, userId, "model", exact);
  return textMessage(`模型已切換：\n${exact}`);
}

async function modelPicker(env: Env, settings: UserSettings): Promise<LineMessage> {
  const models = await listModels(env);
  if (models.length === 0) return textMessage("Unsloth 目前沒有回傳可用模型。");

  const items: LineQuickReplyItem[] = [];
  for (const model of models) {
    if (items.length >= 13) break;
    const data = `cmd=set_model&model=${encodeURIComponent(model)}`;
    if (data.length > 300) continue;
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: shortLabel(model.split("/").pop() ?? model, 20),
        data,
        displayText: `切換模型：${shortLabel(model, 60)}`,
      },
    });
  }

  const current = settings.model ?? "（尚未指定，首次聊天會自動選第一個）";
  const note = models.length > items.length ? `\n\n目前顯示前 ${items.length} 個；輸入 /models 可看完整清單。` : "";
  const message: LineMessage = textMessage(`目前模型：\n${current}\n\n請選擇模型：${note}`);
  if (items.length > 0) message.quickReply = { items };
  return message;
}

async function numberSetting(
  ctx: CommandContext,
  column: "temperature" | "top_p" | "top_k" | "max_tokens" | "repetition_penalty",
  label: string,
  raw: string,
  min: number,
  max: number,
  integer: boolean,
): Promise<CommandResult> {
  const value = parseFiniteNumber(raw);
  if (value === null || value < min || value > max || (integer && !Number.isInteger(value))) {
    return {
      handled: true,
      messages: [textMessage(`用法：/${commandName(column)} 數值\n允許範圍：${min}～${max}${integer ? "（整數）" : ""}`)],
    };
  }
  await updateSetting(ctx.env.DB, ctx.settingsUserId, column, value);
  return { handled: true, messages: [textMessage(`${label} 已設為 ${value}。`)] };
}

function commandName(column: string): string {
  if (column === "temperature") return "temp";
  if (column === "max_tokens") return "tokens";
  if (column === "repetition_penalty") return "repeat";
  return column;
}

function paramsMessage(settings: UserSettings, env: Env): LineMessage {
  const system = settings.system_prompt ?? env.DEFAULT_SYSTEM_PROMPT;
  const text = [
    "目前設定",
    "",
    `模型：${settings.model ?? "自動"}`,
    `Temperature：${settings.temperature}`,
    `Top P：${settings.top_p}`,
    `Top K：${settings.top_k}`,
    `Max Tokens：${settings.max_tokens}`,
    `Repetition Penalty：${settings.repetition_penalty}`,
    `Thinking：${settings.enable_thinking ? "ON" : "OFF"}`,
    `System Prompt：${system ? "已設定" : "空白"}`,
  ].join("\n");

  const quickReply: LineQuickReplyItem[] = [
    quick("模型", "/model"),
    quick("Temp 0.7", "/temp 0.7"),
    quick("Temp 1.0", "/temp 1.0"),
    quick("Tokens 1024", "/tokens 1024"),
    quick("Tokens 2048", "/tokens 2048"),
    quick("Tokens 4096", "/tokens 4096"),
    quick("Thinking ON", "/thinking on"),
    quick("Thinking OFF", "/thinking off"),
    quick("清除對話", "/reset"),
  ];

  return { type: "text", text, quickReply: { items: quickReply } };
}

function quick(label: string, text: string): LineQuickReplyItem {
  return { type: "action", action: { type: "message", label: shortLabel(label, 20), text } };
}

function textMessage(text: string): LineMessage {
  return { type: "text", text };
}

function helpText(): string {
  return [
    "LINE × Unsloth 指令",
    "",
    "/model　選模型",
    "/models　完整模型清單",
    "/params 或 /status　目前參數",
    "/temp 0.7　Temperature",
    "/top_p 0.95　Top P",
    "/top_k 20　Top K",
    "/tokens 2048　最大輸出 Tokens",
    "/repeat 1.0　Repetition Penalty",
    "/thinking on|off　Thinking",
    "/system 內容　System Prompt",
    "/system reset　恢復預設 Prompt",
    "/reset　清除聊天記憶",
    "/whoami　顯示自己的 LINE User ID",
    "",
    "一般文字直接送給目前選擇的 Unsloth 模型。",
  ].join("\n");
}
