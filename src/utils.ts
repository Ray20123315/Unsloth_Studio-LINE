export function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseFiniteNumber(input: string): number | null {
  if (input.trim() === "") return null;
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

export function allowedUserIds(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

export function shortLabel(value: string, maxCodeUnits = 20): string {
  if (value.length <= maxCodeUnits) return value;
  if (maxCodeUnits <= 1) return value.slice(0, maxCodeUnits);
  let cut = maxCodeUnits - 1;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}…`;
}

export function splitLineText(text: string, maxCodeUnits = 4900): string[] {
  const normalized = text.trim() || "（模型沒有回傳文字內容）";
  const chunks: string[] = [];
  let rest = normalized;

  while (rest.length > maxCodeUnits) {
    let cut = maxCodeUnits;
    const minSoftCut = Math.floor(maxCodeUnits * 0.6);
    const newline = rest.lastIndexOf("\n", maxCodeUnits);
    const space = rest.lastIndexOf(" ", maxCodeUnits);
    const soft = Math.max(newline, space);
    if (soft >= minSoftCut) cut = soft;

    const prev = rest.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = maxCodeUnits;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

export function retryKeyForBatch(baseUuid: string, batchIndex: number): string {
  const hex = baseUuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return crypto.randomUUID();
  const suffix = Number.parseInt(hex.slice(-8), 16) ^ (batchIndex >>> 0);
  const next = `${hex.slice(0, -8)}${suffix.toString(16).padStart(8, "0")}`;
  return `${next.slice(0, 8)}-${next.slice(8, 12)}-${next.slice(12, 16)}-${next.slice(16, 20)}-${next.slice(20)}`;
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
