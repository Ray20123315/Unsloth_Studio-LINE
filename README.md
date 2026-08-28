# LINE × Unsloth Cloudflare Worker

這是一個直接部署到 Cloudflare Workers 的 LINE AI Gateway：

```text
LINE
  ↓ webhook
Cloudflare Worker
  ├─ D1：每位使用者的模型 / 參數 / 對話記憶
  └─ Queue：等待較慢的 Unsloth 推論
       ↓
https://unsloth-api.msiai.ray2025.com
       ↓ Cloudflare Tunnel
Unsloth Studio API
```

## 1. 已做好的功能

- LINE webhook `x-line-signature` HMAC-SHA256 驗簽
- Unsloth Bearer API Key 放 Cloudflare Secret，不寫死在程式
- 動態讀取 `GET /v1/models`
- `POST /v1/chat/completions`
- 每位 LINE 使用者獨立設定
- D1 對話記憶
- Cloudflare Queue 非同步推論
- Queue retry + LINE `X-Line-Retry-Key`，降低重試造成重複訊息的風險；LINE 回傳 409（同 retry key 已接受）時視為冪等成功
- 長回答自動切成 LINE 可接受的文字訊息
- LINE Loading animation（1 對 1 聊天）
- 基本 webhook 去重
- 群組 / room 可用；設定以發言者分開，對話記憶以「聊天室 + 發言者」分開

## 2. LINE 指令

```text
/model
/models
/params
/status
/temp 0.7
/top_p 0.95
/top_k 20
/tokens 2048
/repeat 1.0
/thinking on
/thinking off
/system 你是一位專業助理
/system reset
/system off
/reset
/whoami
/help
```

一般文字不是 `/` 開頭時，直接送到 Unsloth。

## 3. 第一次部署

### 3.1 安裝

```bash
npm install
npx wrangler login
```

### 3.2 建 D1

```bash
npm run db:create
```

Wrangler 會回傳 D1 的 `database_id`。把它填進 `wrangler.jsonc`：

```jsonc
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

### 3.3 建 Queue

```bash
npm run queue:create
```

### 3.4 建 D1 Schema

```bash
npm run db:migrate:remote
```

### 3.5 設三個 Secret

不要把實際值寫進 `wrangler.jsonc` 或 Git。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put UNSLOTH_API_KEY
```

### 3.6 部署

`wrangler.jsonc` 預設使用：

```text
line.msiai.ray2025.com
```

部署：

```bash
npm run deploy
```

Webhook URL：

```text
https://line.msiai.ray2025.com/webhook
```

健康檢查：

```text
https://line.msiai.ray2025.com/health
```

## 4. 重要設定

都在 `wrangler.jsonc`：

```jsonc
"UNSLOTH_BASE_URL": "https://unsloth-api.msiai.ray2025.com",
"MAX_HISTORY_MESSAGES": "20",
"MAX_STORED_MESSAGES": "200",
"MAX_OUTPUT_TOKENS_HARD_LIMIT": "16384",
"UNSLOTH_TIMEOUT_MS": "540000",
"ALLOWED_LINE_USER_IDS": ""
```

### `ALLOWED_LINE_USER_IDS`

預設空白 = 所有加入 Bot 的使用者都能用。

如果只想自己用，可先在 LINE 輸入：

```text
/whoami
```

拿到 User ID 後設定，例如：

```jsonc
"ALLOWED_LINE_USER_IDS": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

多人用逗號分隔。

## 5. 為什麼 Queue `max_concurrency` 預設是 1？

第一版故意設定成：

```jsonc
"max_concurrency": 1
```

原因是本機 Unsloth 常常只有一張 GPU / 一個主要 inference server，而且聊天歷史有順序。先一次處理一個請求最不容易遇到：

- 兩個請求同時搶 GPU
- 同一個人的上下文順序顛倒
- 切模型互相干擾

如果之後確認你的 Unsloth 可安全並行，再把它調高。

## 6. Unsloth 模型切換注意事項

程式不會硬編模型名稱，而是每次 `/model` / `/models` 從：

```text
GET /v1/models
```

取得目前 API 真正可用的模型。

目前 Unsloth 在部分 MLX 情境仍有「已下載但尚未手動載入的模型不出現在 `/v1/models`」的已知問題，因此這個 Bot 只顯示 Unsloth API 實際回傳的模型，避免選到 API 無法載入的項目。

## 7. Local development

建立本機秘密檔：

```bash
cp .dev.vars.example .dev.vars
```

填入測試用值後：

```bash
npm run db:migrate:local
npm run dev
```

正式 secrets 不要 commit。

## 8. Type check

```bash
npm run typecheck
```

## 9. 安全設計

- LINE webhook 在 parse JSON 前先驗證原始 body signature。
- Unsloth API Key 只從 Worker Secret 讀取。
- `/health` 不會輸出 secrets、模型清單或 D1 內容。
- 使用者的模型與參數完全在伺服端保存。
- 若 Bot 只供自己使用，強烈建議設定 `ALLOWED_LINE_USER_IDS`。

## 10. GitHub CI

`.github/workflows/ci.yml` 會在 push / pull request 時執行：

- `npm install --ignore-scripts`
- `npm run typecheck`
- `wrangler deploy --dry-run`（CI 只用假的 D1 UUID 做設定解析與 bundle，不會部署）

正式部署前仍必須把 `wrangler.jsonc` 的 `REPLACE_WITH_D1_DATABASE_ID` 換成真實 D1 database ID。
