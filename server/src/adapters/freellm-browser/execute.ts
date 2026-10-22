import fs from "node:fs";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { runAgentTurnLoop } from "./unified-engine.js";

function extractPromptFromContext(context: AdapterExecutionContext): string {
  if (context.context?.prompt && typeof context.context.prompt === "string") {
    return context.context.prompt;
  }

  const issue = context.context?.paperclipIssue as Record<string, unknown> | undefined;
  if (issue && (issue.title || issue.description)) {
    const parts: string[] = [];
    if (issue.title) parts.push(`Task: ${issue.title}`);
    if (issue.description) parts.push(`Description:\n${issue.description}`);
    return parts.join("\n\n");
  }

  const agent = context.agent as any;
  if (agent?.name) {
    return `Hello, I am ${agent.name}. How can I assist with this workspace?`;
  }

  return "Hello from FreeLLM Work";
}

export async function execute(
  context: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const modelId = (context.config?.model as string) || "gemini-argon";
  const prompt = extractPromptFromContext(context);
  const isGemini = modelId.startsWith("gemini-");
  const platform = isGemini ? "gemini" : "deepseek";

  const agentId = context.agent?.id || `agent-${platform}-${modelId}`;
  const issueId = ((context.context?.paperclipIssue as any)?.id as string) || undefined;
  const companyId = ((context.agent as any)?.companyId as string) || undefined;

  const workspaceRoot =
    (context as any).workspaceDirectory ||
    (context as any).workspaceRoot ||
    (context.config as any)?.cwd ||
    process.cwd();

  const platformName = isGemini ? `Google Gemini (${modelId})` : `DeepSeek (${modelId})`;
  await context.onLog(
    "stdout",
    `[FreeLLM] Agent session active on ${platformName} (Session ID: ${agentId.slice(0, 8)})...\n`,
  );

  const loopResult = await runAgentTurnLoop({
    agentId,
    prompt,
    workspaceRoot,
    companyId,
    issueId,
    signal: context.signal,
    onEvent: async (event) => {
      if (event.type === "token" && event.text) {
        await context.onLog("stdout", event.text);
      } else if (event.type === "replace" && event.text) {
        await context.onLog("stdout", `\n[Updated]: ${event.text}\n`);
      } else if (event.type === "thinking") {
        await context.onLog("stdout", "[Thinking...]\n");
      } else if (event.type === "status") {
        await context.onLog("stdout", `[Status: ${event.status}]\n`);
      } else if (event.type === "tool_call") {
        await context.onLog(
          "stdout",
          `\n[FreeLLM Tool Call]: ${event.tool} (callId: ${event.callId})\n`,
        );
      } else if (event.type === "tool_result") {
        await context.onLog("stdout", `\n[FreeLLM Tool Result]:\n${event.result}\n\n`);
      } else if (event.type === "error") {
        await context.onLog("stderr", `[FreeLLM Error] ${event.message}\n`);
      }
    },
  });

  if (loopResult.lastStatus === "NEEDS_LOGIN") {
    const loginMsg = `${platformName} requires login. Please open 'المتصفح' in the sidebar to log in to your account.`;
    await context.onLog("stderr", `\n[FreeLLM] ${loginMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: loginMsg,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }

  if (loopResult.lastStatus === "NEEDS_HUMAN_INTERVENTION") {
    const capMsg =
      "Captcha / Cloudflare challenge detected. Please open 'المتصفح' in the sidebar to solve the challenge.";
    await context.onLog("stderr", `\n[FreeLLM] ${capMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: capMsg,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }

  if (context.signal?.aborted) {
    return {
      exitCode: 130,
      signal: "SIGINT",
      timedOut: false,
      errorMessage: "Execution cancelled by operator",
    };
  }

  await context.onLog("stdout", "\n[FreeLLM] Agent workflow turn completed successfully.\n");

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: loopResult.fullResponse.slice(0, 300),
    sessionParams: {
      platform,
      model: modelId,
      sessionId: agentId,
      turnCount: loopResult.turnCount,
      toolCallsCount: loopResult.toolCallsCount,
      timestamp: new Date().toISOString(),
    },
    sessionDisplayId: `${platform}-${modelId}`,
  };
}
