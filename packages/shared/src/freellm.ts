export type FreeLLMRunStatus = "running" | "completed" | "waiting_review" | "waiting_children" | "blocked" | "failed" | "cancelled" | "limit_reached";
export interface FreeLLMToolOutcome {
  ok: boolean;
  status: "executed" | "failed" | "pending_approval" | "unknown";
  data?: Record<string, unknown>;
  error?: string;
  verified?: boolean;
  mutated?: boolean;
}
export interface FreeLLMTurnEvent {
  type: "token" | "replace" | "status" | "thinking" | "tool_call" | "tool_result" | "error" | "done" | "run_started";
  text?: string; status?: string; tool?: string; callId?: string;
  args?: Record<string, unknown>; result?: string; message?: string; runId?: string; issueId?: string;
}
