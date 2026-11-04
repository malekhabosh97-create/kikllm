import { describe, expect, it, vi } from "vitest";
import { BrowserSessionHub } from "../adapters/freellm-browser/browser-provider/session-hub.js";
import type { ChatSession, ReplyResult, SiteAdapter } from "../adapters/freellm-browser/browser-provider/types.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

class MockDeepSeekFailingSession implements ChatSession {
  private closed = false;
  private currentUrl = "https://chat.deepseek.com/a/retry-test";
  public attempts = 0;
  public sendHistory: string[] = [];

  constructor(
    public maxFailuresBeforeSuccess: number,
    public failureType: "provider_error" | "other" = "provider_error",
  ) {}

  isClosed(): boolean { return this.closed; }
  url(): string { return this.currentUrl; }
  async stop(): Promise<boolean> { return true; }
  async setBusy(_busy: boolean): Promise<void> {}
  async waitUntilReady(): Promise<void> {}

  async send(text: string): Promise<void> {
    this.sendHistory.push(text);
  }

  async waitForReply(): Promise<ReplyResult> {
    this.attempts++;
    if (this.attempts <= this.maxFailuresBeforeSuccess) {
      return {
        status: "blocked",
        blocker: this.failureType,
        text: "The server is busy. Please try again later. (503)",
        blockerDetails: "DeepSeek busy rate limit",
      };
    }
    return {
      status: "ok",
      text: `نجحت العملية بعد ${this.attempts - 1} محاولات إعادة`,
    };
  }
}

describe("DeepSeek Retry and Exponential Backoff Independent Test", () => {
  it("retries on provider_error and recovers when the model succeeds on attempt 3", async () => {
    const testDir = path.join(os.tmpdir(), "freellm-retry-test-" + crypto.randomUUID());
    const mockSession = new MockDeepSeekFailingSession(2, "provider_error");

    const mockAdapter: SiteAdapter = {
      id: "deepseek",
      health: async () => ({ ok: true }),
      listModels: async () => [{ id: "deepseek-chat", label: "DeepSeek Chat", locked: false }],
      newChat: async () => mockSession,
      resumeChat: async () => mockSession,
    };

    const hub = new BrowserSessionHub(
      testDir,
      () => mockAdapter,
      async () => ({}),
    );

    const blockerMessages: string[] = [];

    const startTime = Date.now();
    const result = await hub.turn({
      companyId: "retry-test-company",
      agentId: "agent-retry-1",
      model: "deepseek-chat",
      prompt: "Review the authentication module",
      instructions: "You are a code reviewer",
      requestId: "retry-req-1",
      agentName: "Code Reviewer",
      onBlocker: (msg) => {
        if (msg) blockerMessages.push(msg);
      },
    });
    const elapsedMs = Date.now() - startTime;

    console.log("=== Retry & Backoff Execution Evidence ===");
    console.log(`Total attempts made: ${mockSession.attempts}`);
    console.log(`Send invocations: ${mockSession.sendHistory.length}`);
    console.log(`Blocker notifications received (${blockerMessages.length}):`);
    blockerMessages.forEach((m, i) => console.log(`  [Notification ${i + 1}]: ${m}`));
    console.log(`Total elapsed backoff time: ${elapsedMs}ms`);
    console.log(`Final reply status: ${result.status}`);
    console.log(`Final reply text: ${result.text}`);

    // Evidence Assertions:
    // 1. Initial attempt (failed) + Retry 1 (failed) + Retry 2 (succeeded) = 3 total attempts
    expect(mockSession.attempts).toBe(3);
    expect(mockSession.sendHistory).toHaveLength(3);
    expect(mockSession.sendHistory[1]).toContain("[إعادة محاولة بعد الانتظار]");
    expect(mockSession.sendHistory[2]).toContain("[إعادة محاولة بعد الانتظار]");

    // 2. onBlocker was notified for each retry
    expect(blockerMessages).toHaveLength(2);
    expect(blockerMessages[0]).toContain("إعادة المحاولة التلقائية رقم 1/3");
    expect(blockerMessages[1]).toContain("إعادة المحاولة التلقائية رقم 2/3");

    // 3. Backoff time occurred: attempt 1 wait was 2500ms, attempt 2 wait was 5000ms => >= 7500ms
    expect(elapsedMs).toBeGreaterThanOrEqual(7400);

    // 4. Recovered and finished with status "ok"
    expect(result.status).toBe("ok");
    expect(result.text).toContain("نجحت العملية");
  }, 20000);

  it("stops after 3 retries if provider_error persists and reports blocked status", async () => {
    const testDir = path.join(os.tmpdir(), "freellm-retry-fail-test-" + crypto.randomUUID());
    // Permanent failures (always fails)
    const mockSession = new MockDeepSeekFailingSession(99, "provider_error");

    const mockAdapter: SiteAdapter = {
      id: "deepseek",
      health: async () => ({ ok: true }),
      listModels: async () => [{ id: "deepseek-chat", label: "DeepSeek Chat", locked: false }],
      newChat: async () => mockSession,
      resumeChat: async () => mockSession,
    };

    const hub = new BrowserSessionHub(
      testDir,
      () => mockAdapter,
      async () => ({}),
    );

    const blockerMessages: string[] = [];
    const result = await hub.turn({
      companyId: "retry-test-company",
      agentId: "agent-retry-2",
      model: "deepseek-chat",
      prompt: "Persistent fail test",
      instructions: "You are a tester",
      requestId: "retry-req-2",
      agentName: "QA Tester",
      onBlocker: (msg) => {
        if (msg) blockerMessages.push(msg);
      },
    });

    console.log("=== Permanent Failure Exhaustion Evidence ===");
    console.log(`Total attempts made: ${mockSession.attempts}`);
    console.log(`Blocker notifications: ${blockerMessages.length}`);
    console.log(`Final status: ${result.status}, blocker: ${result.blocker}`);

    // Initial attempt + 3 retries = 4 total attempts
    expect(mockSession.attempts).toBe(4);
    expect(blockerMessages).toHaveLength(3);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toBe("provider_error");
  }, 25000);
});
