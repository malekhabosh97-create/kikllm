import { describe, expect, it, vi } from "vitest";
import { BrowserSessionHub } from "../adapters/freellm-browser/browser-provider/session-hub.js";
import type { ChatSession, ReplyResult, SiteAdapter } from "../adapters/freellm-browser/browser-provider/types.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

class MockDeepSeekSession implements ChatSession {
  private closed = false;
  private currentUrl = "https://chat.deepseek.com/a/test-session";
  public activeOperations = 0;
  public static maxConcurrentObserved = 0;

  constructor(public tabId?: string) {}

  isClosed(): boolean { return this.closed; }
  url(): string { return this.currentUrl; }
  async stop(): Promise<boolean> { return true; }
  async setBusy(_busy: boolean): Promise<void> {}
  async waitUntilReady(): Promise<void> {}

  async send(_text: string): Promise<void> {
    this.activeOperations++;
    if (this.activeOperations > MockDeepSeekSession.maxConcurrentObserved) {
      MockDeepSeekSession.maxConcurrentObserved = this.activeOperations;
    }
  }

  async waitForReply(): Promise<ReplyResult> {
    // Simulate model inference time (100ms)
    await new Promise(r => setTimeout(r, 100));
    this.activeOperations--;
    return {
      status: "ok",
      text: "```tool_call\n{\"callId\":\"call-1\",\"tool\":\"report_progress\",\"arguments\":{\"status\":\"done\"}}\n```",
    };
  }
}

describe("DeepSeek Serialized Queue & Concurrency Pacing", () => {
  it("serializes 5 concurrent agents so that maximum concurrent requests is exactly 1", async () => {
    MockDeepSeekSession.maxConcurrentObserved = 0;
    const testDir = path.join(os.tmpdir(), "freellm-test-sessions-" + crypto.randomUUID());

    const mockAdapter: SiteAdapter = {
      id: "deepseek",
      health: async () => ({ ok: true }),
      listModels: async () => [{ id: "deepseek-chat", label: "DeepSeek Chat", locked: false }],
      newChat: async () => new MockDeepSeekSession("tab-" + crypto.randomUUID()),
      resumeChat: async (url) => {
        const s = new MockDeepSeekSession("tab-resumed");
        (s as any).currentUrl = url;
        return s;
      },
    };

    const hub = new BrowserSessionHub(
      testDir,
      () => mockAdapter,
      async () => ({}),
    );

    const agentIds = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"];
    const agentNames = [
      "Code Reviewer",
      "Fullstack Dev",
      "QA Tester",
      "DeepSeek Assistant",
      "Creative Designer",
    ];

    const timeline: { agent: string; start: number; end: number }[] = [];

    console.log("Launching 5 concurrent agent tasks on DeepSeek simultaneously...");
    const startTime = Date.now();

    const tasks = agentIds.map(async (agentId, index) => {
      const name = agentNames[index];
      const taskStart = Date.now();
      
      const res = await hub.turn({
        companyId: "test-company",
        agentId,
        model: "deepseek-chat",
        prompt: `Agent ${name} prompt: analyze feature ${index + 1}`,
        instructions: `Role instructions for ${name}`,
        requestId: `req-${agentId}-1`,
        agentName: name,
      });

      const taskEnd = Date.now();
      timeline.push({ agent: name, start: taskStart - startTime, end: taskEnd - startTime });
      return res;
    });

    const results = await Promise.all(tasks);

    console.log("=== Execution Timeline (relative ms) ===");
    for (const t of timeline) {
      console.log(`Agent [${t.agent}]: started at +${t.start}ms, completed at +${t.end}ms`);
    }

    // 1. All 5 agents completed successfully
    expect(results).toHaveLength(5);
    for (const res of results) {
      expect(res.status).toBe("ok");
      expect(res.text).toContain("report_progress");
    }

    // 2. Strict serialization: active operations on DeepSeek never exceeded 1
    expect(MockDeepSeekSession.maxConcurrentObserved).toBe(1);

    // 3. Pacing was respected: total execution time reflects sequential pacing
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(1000);
  });
});
