// Vendored from NandhaKishorM/laya laya-ts at ec8409e542941bb4bb649d5fec00d4cec96ae024. See NOTICE.md and LICENSE.laya.
/* eslint-disable */
import type { TokenizerLike } from "./tokenizer.js";
export type QType = "choice" | "score" | "noul";
export interface InternalQ { t: QType; ins: string; crit: unknown }
/** Python `json.dumps(v, ensure_ascii=False)` replica: separators (", ", ": "),
unicode raw, unknown types fall back to undefined (caller applies str()). */
function pyJson(v: unknown): string | undefined {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyJson(x) ?? "null").join(", ")}]`;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const s = pyJson(x);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}: ${s}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return undefined;
}
export function serializeState(state: unknown): string {
  if (typeof state === "string") return state;
  return pyJson(state) ?? String(state);
}
function renderCriterion(v: unknown): string {
  return typeof v === "string" ? v : pyJson(v) ?? String(v);
}
export function renderOptions(q: InternalQ): string[] {
  if (q.t === "choice") {
    const crit = q.crit as Record<string, unknown>;
    return Object.entries(crit).map(([k, v]) =>
      v === null || v === undefined || v === "" ? k : `${k}: ${renderCriterion(v)}`);
  }
  if (q.t === "score") {
    return (q.crit as unknown[]).map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  }
  const crit = (q.crit ?? {}) as Record<string, unknown>;
  const f = crit["false"], t = crit["true"];
  return [
    "false: " + (f !== null && f !== undefined && f !== "" ? renderCriterion(f) : "no, the statement does not hold"),
    "true: " + (t !== null && t !== undefined && t !== "" ? renderCriterion(t) : "yes, the statement holds"),
  ];
}
export function buildSequence(tok: TokenizerLike, state: unknown, q: InternalQ,
    maxLen = 512, headMaxLen = 192, optionOrder?: number[], truncateLeft = false): { ids: number[]; markers: number[] } {
  const maskTok = tok.maskToken;
  const opts = renderOptions(q);
  const order = optionOrder ?? opts.map((_, i) => i);
  const ins = String(q.ins).split(maskTok).join(" ");
  let headIds = tok.encode(`${q.t} question: ${ins}`);
  let optIds = order.map((i) =>
    [tok.maskId, ...tok.encode(" " + opts[i]!.split(maskTok).join(" ")).slice(0, 48)]);
  let budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (budget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  headIds = headIds.slice(0, Math.max(8, budget));
  let ids = [tok.clsId, ...headIds, tok.sepId];
  const markers: number[] = [];
  for (const o of optIds) { markers.push(ids.length); ids.push(...o); }
  ids.push(tok.sepId);
  const room = Math.max(0, maxLen - ids.length - 1);
  const stAll = tok.encode(serializeState(state).split(maskTok).join(" "));
  const st = truncateLeft ? stAll.slice(-room) : stAll.slice(0, room);
  ids = [...ids, ...st, tok.sepId].slice(0, maxLen);
  return { ids, markers: markers.filter((m) => m < maxLen) };
}
