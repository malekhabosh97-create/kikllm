import type { z } from "zod";

export interface ParsedToolCall { callId: string; tool: string; arguments: Record<string, any>; }

export type ReplyKind =
  | "tool_call"
  | "invalid_tool_call"
  | "question"
  | "blocker"
  | "delivery"
  | "answer";

export interface ClassifiedReply {
  kind: ReplyKind;
  call?: ParsedToolCall;
  /** Additional well-formed calls that were present but intentionally not executed (protocol allows one per turn). */
  ignoredCallIds: string[];
  /** Human/model-readable reasons a candidate call was rejected. */
  issues: string[];
  /** Free text of a declared question or blocker. */
  detail?: string;
}

const CALL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const ILLUSTRATIVE = /(?:do not execute|don't execute|illustrative example|example only|for example|e\.g\.|على سبيل المثال|نموذج توضيحي|مثال توضيحي|لا تنفذ|مثال:)/i;
const STATUS_MARKER = /\[\[\s*STATUS\s*:\s*(delivered|question|blocked)\s*(?::\s*([\s\S]*?))?\]\]/i;

interface Fence { label: string; body: string; start: number; end: number; }

export function extractFences(text: string): Fence[] {
  const fences: Fence[] = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)\n?```/g;
  for (const match of text.matchAll(regex)) {
    fences.push({ label: match[1].trim().toLowerCase(), body: match[2], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return fences;
}

function extractBalancedJsonObject(raw: string): any {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseJson(raw: string): any {
  try { return JSON.parse(raw.trim()); } catch { return extractBalancedJsonObject(raw); }
}

/**
 * Only the text immediately before a fence decides whether it is illustrative.
 * Scanning the whole reply would discard real calls whenever the model used "for example" anywhere.
 */
function isIllustrativeFence(text: string, fence: Fence): boolean {
  const before = text.slice(Math.max(0, fence.start - 200), fence.start);
  const lastLines = before.split("\n").slice(-3).join("\n");
  if (ILLUSTRATIVE.test(lastLines)) return true;
  const lineStart = text.lastIndexOf("\n", fence.start - 1) + 1;
  return text.slice(lineStart, fence.start).trim().startsWith(">");
}

function looksLikeEnvelope(raw: string): boolean {
  return /"tool"\s*:/.test(raw) && /"(?:callId|arguments)"\s*:/.test(raw);
}

export function classifyReply(response: string, schemas: Record<string, z.ZodType<any>>): ClassifiedReply {
  const text = response.trim();
  const result: ClassifiedReply = { kind: "answer", ignoredCallIds: [], issues: [] };
  if (!text) return result;
  const lines = text.split("\n");
  const fullyQuoted = lines.every(line => line.trim().startsWith(">"));

  const accepted: ParsedToolCall[] = [];
  const consider = (raw: string, label: string, illustrative: boolean) => {
    const explicit = label === "tool_call";
    if (!explicit && !looksLikeEnvelope(raw)) return;
    if (illustrative) return;
    const value = parseJson(raw);
    if (!value || typeof value !== "object") { result.issues.push("tool_call block is not valid JSON"); return; }
    if (value.example === true) return;
    if (typeof value.callId !== "string" || !CALL_ID.test(value.callId)) { result.issues.push("callId must match [a-zA-Z0-9_-]{1,128}"); return; }
    if (typeof value.tool !== "string" || !schemas[value.tool]) { result.issues.push("unknown tool \"" + String(value.tool) + "\""); return; }
    if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) { result.issues.push(value.tool + ": arguments must be a JSON object"); return; }
    const parsed = schemas[value.tool].safeParse(value.arguments);
    if (!parsed.success) {
      result.issues.push(value.tool + ": " + parsed.error.issues.slice(0, 5).map(issue => (issue.path.join(".") || "arguments") + " " + issue.message).join("; "));
      return;
    }
    accepted.push({ callId: value.callId, tool: value.tool, arguments: value.arguments });
  };

  if (!fullyQuoted) {
    const fences = extractFences(text);
    for (const fence of fences) consider(fence.body, fence.label, isIllustrativeFence(text, fence));
    if (!fences.length && text.startsWith("{") && text.endsWith("}")) consider(text, "", false);
  }

  if (accepted.length) {
    const [first, ...rest] = accepted;
    result.kind = "tool_call";
    result.call = first;
    result.ignoredCallIds = rest.filter(call => call.callId !== first.callId).map(call => call.callId);
    return result;
  }
  if (result.issues.length) { result.kind = "invalid_tool_call"; return result; }

  const marker = text.match(STATUS_MARKER);
  if (marker) {
    const state = marker[1].toLowerCase();
    result.kind = state === "delivered" ? "delivery" : state === "question" ? "question" : "blocker";
    result.detail = (marker[2] || "").trim() || undefined;
  }
  return result;
}

export function stripStatusMarker(text: string): string {
  return text.replace(STATUS_MARKER, "").trim();
}

export function correctionPrompt(issues: string[], attempt: number, max: number): string {
  return [
    "[PROTOCOL_ERROR attempt " + attempt + "/" + max + "] Your tool call was NOT executed.",
    "Problems: " + issues.slice(0, 5).join(" | "),
    "Resend exactly one fenced block and nothing that resembles another call:",
    "```tool_call",
    "{\"callId\":\"unique-id\",\"tool\":\"<tool_name>\",\"arguments\":{}}",
    "```",
    "If you cannot proceed, end with [[STATUS: blocked: <reason>]].",
  ].join("\n");
}
