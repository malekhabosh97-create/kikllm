import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  companies,
  issues,
  issueComments,
} from "@paperclipai/db";
import { eq, and, asc } from "drizzle-orm";
import {
  TOOL_INSTRUCTIONS,
  parseToolCall,
  executeTool,
  type ParsedToolCall,
} from "./tool-executor.js";
import { getSiteAdapter, type ChatSession } from "./browser-provider/index.js";

export interface UnifiedTurnEvent {
  type:
    | "token"
    | "replace"
    | "status"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "error"
    | "done";
  text?: string;
  status?: string;
  tool?: string;
  callId?: string;
  args?: any;
  result?: string;
  message?: string;
}

export interface RunAgentTurnLoopOptions {
  agentId: string;
  prompt: string;
  workspaceRoot?: string;
  db?: Db;
  companyId?: string;
  issueId?: string;
  onEvent?: (event: UnifiedTurnEvent) => Promise<void> | void;
  signal?: AbortSignal;
}

export function getDaemonToken(): string {
  if (process.env.FREELLM_DAEMON_TOKEN) return process.env.FREELLM_DAEMON_TOKEN;
  const tokenPaths = [
    "C:\\Users\\malek\\.freellm-browser-profile\\token.txt",
    path.resolve(process.cwd(), "server/.browser-profile/token.txt"),
    path.resolve(process.cwd(), ".browser-profile/token.txt"),
  ];
  for (const p of tokenPaths) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8").trim();
      } catch {}
    }
  }
  return "";
}

interface SingleTurnResult {
  fullResponse: string;
  lastStatus: string | null;
  hasError: boolean;
  cancelled: boolean;
}

const activeInProcessSessions = new Map<string, ChatSession>();

async function executeInProcessGeminiTurn(params: {
  prompt: string;
  modelId: string;
  sessionId: string;
  systemPrompt: string;
  onEvent?: (event: UnifiedTurnEvent) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<SingleTurnResult> {
  const { prompt, modelId, sessionId, systemPrompt, onEvent, signal } = params;
  try {
    const adapter = getSiteAdapter("gemini");
    let session = activeInProcessSessions.get(sessionId);
    if (!session) {
      session = await adapter.newChat(modelId);
      activeInProcessSessions.set(sessionId, session);
      if (systemPrompt) {
        await session.send(systemPrompt + "\n\n" + prompt);
      } else {
        await session.send(prompt);
      }
    } else {
      await session.send(prompt);
    }

    const reply = await session.waitForReply({
      onChunk: async (chunk) => {
        if (onEvent) await onEvent({ type: "token", text: chunk });
      },
      signal,
    });

    if (reply.status === "blocked") {
      if (onEvent) {
        await onEvent({
          type: "error",
          message: `Browser blocked: ${reply.blocker} (${reply.blockerDetails || ""})`,
        });
      }
      return {
        fullResponse: reply.text,
        lastStatus: `BLOCKED:${reply.blocker}`,
        hasError: true,
        cancelled: false,
      };
    }

    if (reply.status === "timeout") {
      if (onEvent) {
        await onEvent({
          type: "error",
          message: `Browser response timeout. Snapshot saved to ${reply.rawHtmlSnapshot || ""}`,
        });
      }
      return {
        fullResponse: reply.text,
        lastStatus: "TIMEOUT",
        hasError: true,
        cancelled: false,
      };
    }

    return {
      fullResponse: reply.text,
      lastStatus: "READY",
      hasError: false,
      cancelled: false,
    };
  } catch (err: any) {
    if (onEvent) {
      await onEvent({ type: "error", message: err.message });
    }
    return {
      fullResponse: "",
      lastStatus: "ERROR",
      hasError: true,
      cancelled: false,
    };
  }
}

function executeDaemonTurn(params: {
  prompt: string;
  platform: "gemini" | "deepseek";
  modelId: string;
  deepThink: boolean;
  sessionId: string;
  systemPrompt: string;
  daemonPort: number;
  daemonToken: string;
  onEvent?: (event: UnifiedTurnEvent) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<SingleTurnResult> {
  const {
    prompt,
    platform,
    modelId,
    deepThink,
    sessionId,
    systemPrompt,
    daemonPort,
    daemonToken,
    onEvent,
    signal,
  } = params;

  // Strangler facade: Route Gemini through in-process browser provider
  if (platform === "gemini") {
    return executeInProcessGeminiTurn({
      prompt,
      modelId,
      sessionId,
      systemPrompt,
      onEvent,
      signal,
    });
  }

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      prompt,
      platform,
      model: modelId,
      deepThink,
      sessionId,
      systemPrompt: systemPrompt || undefined,
    });

    let isDone = false;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: "/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "x-freellm-auth": daemonToken,
        },
      },
      (res) => {
        let fullResponse = "";
        let lastStatus: string | null = null;
        let hasError = false;
        let streamBuffer = "";

        const handlePayload = async (payload: any) => {
          if (payload.type === "token" && payload.text) {
            fullResponse += payload.text;
            if (onEvent) await onEvent({ type: "token", text: payload.text });
          } else if (payload.type === "replace" && payload.text) {
            fullResponse = payload.text;
            if (onEvent) await onEvent({ type: "replace", text: payload.text });
          } else if (payload.type === "thinking") {
            if (onEvent) await onEvent({ type: "thinking" });
          } else if (payload.type === "status") {
            lastStatus = payload.status;
            if (onEvent) await onEvent({ type: "status", status: payload.status });
          } else if (payload.type === "error") {
            hasError = true;
            if (onEvent) await onEvent({ type: "error", message: payload.message });
          }
        };

        res.on("data", async (chunkBuffer: Buffer) => {
          streamBuffer += chunkBuffer.toString("utf8");
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const payload = JSON.parse(trimmed.slice(6));
                await handlePayload(payload);
              } catch {}
            }
          }
        });

        res.on("end", async () => {
          if (streamBuffer.trim().startsWith("data: ")) {
            try {
              const payload = JSON.parse(streamBuffer.trim().slice(6));
              await handlePayload(payload);
            } catch {}
          }

          if (!isDone) {
            isDone = true;
            resolve({
              fullResponse,
              lastStatus,
              hasError,
              cancelled: false,
            });
          }
        });
      },
    );

    req.on("error", (err) => {
      if (!isDone) {
        isDone = true;
        if (onEvent) {
          onEvent({
            type: "error",
            message: `FreeLLM Browser Daemon unreachable: ${err.message}`,
          });
        }
        resolve({
          fullResponse: "",
          lastStatus: "DISCONNECTED",
          hasError: true,
          cancelled: false,
        });
      }
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        if (!isDone) {
          isDone = true;
          req.destroy();
          try {
            const cancelData = JSON.stringify({ sessionId, platform });
            const cancelReq = http.request({
              hostname: "127.0.0.1",
              port: daemonPort,
              path: "/cancel",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(cancelData),
                "x-freellm-auth": daemonToken,
              },
            });
            cancelReq.write(cancelData);
            cancelReq.end();
          } catch {}
          resolve({
            fullResponse: "",
            lastStatus: "CANCELLED",
            hasError: false,
            cancelled: true,
          });
        }
      });
    }

    req.write(postData);
    req.end();
  });
}

export async function runAgentTurnLoop(
  options: RunAgentTurnLoopOptions,
): Promise<{
  fullResponse: string;
  turnCount: number;
  toolCallsCount: number;
  lastStatus: string | null;
}> {
  const {
    agentId,
    prompt,
    workspaceRoot = "C:\\Users\\malek\\Documents\\freellm work",
    db,
    companyId,
    issueId,
    onEvent,
    signal,
  } = options;

  let agent: any = null;
  let modelId = "gemini-argon";
  let agentSystemPrompt = "";

  if (db && agentId) {
    const [found] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId));
    if (found) {
      agent = found;
      const cfg = (found.adapterConfig as any) || {};
      if (cfg.model) modelId = cfg.model;
      if (cfg.systemPrompt) agentSystemPrompt = cfg.systemPrompt;
      else if (
        cfg.instructionsFilePath &&
        fs.existsSync(cfg.instructionsFilePath)
      ) {
        try {
          agentSystemPrompt = fs.readFileSync(cfg.instructionsFilePath, "utf8").trim();
        } catch {}
      } else if (found.capabilities) {
        agentSystemPrompt = found.capabilities;
      }
    }
  }

  if (!agentSystemPrompt && agent) {
    agentSystemPrompt = `You are ${agent.name}, acting as ${agent.role || agent.title || "Specialist"} in FreeLLM Work.
Your objective is to provide thoughtful, empirical, high-quality results.
Always verify and ground your findings in real project facts before answering.`;
  }

  const isGemini = modelId.startsWith("gemini-");
  const platform: "gemini" | "deepseek" = isGemini ? "gemini" : "deepseek";
  const deepThink =
    modelId === "deepseek-deepthink" ||
    modelId.includes("thinking") ||
    modelId.includes("r1");

  const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
  const daemonToken = getDaemonToken();

  const fullSystemPrompt = `${agentSystemPrompt}\n\n${TOOL_INSTRUCTIONS}`.trim();

  let currentPrompt = prompt;
  let turnCount = 0;
  let toolCallsCount = 0;
  const MAX_TURNS = 12;
  let finalResponse = "";
  let lastObservedStatus: string | null = null;

  while (turnCount < MAX_TURNS) {
    turnCount++;

    if (signal?.aborted) {
      break;
    }

    const { fullResponse, lastStatus, hasError, cancelled } =
      await executeDaemonTurn({
        prompt: currentPrompt,
        platform,
        modelId,
        deepThink,
        sessionId: agentId,
        systemPrompt: turnCount === 1 ? fullSystemPrompt : "",
        daemonPort,
        daemonToken,
        onEvent,
        signal,
      });

    lastObservedStatus = lastStatus;

    if (cancelled || signal?.aborted) {
      break;
    }

    if (hasError && !fullResponse) {
      if (onEvent) {
        await onEvent({
          type: "error",
          message: `تعذر توليد الرد من ${platform} (${modelId}). تأكد من تسجيل الدخول إلى المتصفح.`,
        });
      }
      break;
    }

    finalResponse = fullResponse;

    // Check for actionable tool calls
    const toolCall = parseToolCall(fullResponse);
    if (!toolCall) {
      // Final response produced without requiring further tools
      break;
    }

    // A tool call was issued by the model
    toolCallsCount++;
    if (onEvent) {
      await onEvent({
        type: "tool_call",
        tool: toolCall.tool,
        callId: toolCall.callId,
        args: toolCall.arguments,
      });
    }

    // Persist tool call announcement in DB thread
    if (db && issueId && agent) {
      try {
        await db.insert(issueComments).values({
          companyId: agent.companyId,
          issueId,
          authorAgentId: agent.id,
          authorType: "agent",
          body: `⚡ **[Tool Call: \`${toolCall.tool}\`]** (callId: \`${toolCall.callId}\`)\n\`\`\`json\n${JSON.stringify(toolCall.arguments, null, 2)}\n\`\`\``,
        });
      } catch {}
    }

    // Execute the requested tool
    const toolResult = await executeTool(
      toolCall,
      workspaceRoot,
      { agent },
      db,
      companyId || agent?.companyId,
    );

    if (onEvent) {
      await onEvent({
        type: "tool_result",
        tool: toolCall.tool,
        callId: toolCall.callId,
        result: toolResult,
      });
    }

    // Persist tool result in DB thread
    if (db && issueId && agent) {
      try {
        await db.insert(issueComments).values({
          companyId: agent.companyId,
          issueId,
          authorAgentId: agent.id,
          authorType: "agent",
          body: `📋 **[Tool Result: \`${toolCall.tool}\`]**\n\`\`\`text\n${toolResult.slice(0, 4000)}\n\`\`\``,
        });
      } catch {}
    }

    // Feed result back into model for next turn
    currentPrompt = `[TOOL RESULT for callId: ${toolCall.callId}]\n${toolResult}\n\nPlease proceed with your next action or provide your final response to the user.`;
  }

  // Persist final agent response to DB
  if (finalResponse.trim() && db && issueId && agent) {
    try {
      await db.insert(issueComments).values({
        companyId: agent.companyId,
        issueId,
        authorAgentId: agent.id,
        authorType: "agent",
        body: finalResponse.trim(),
      });
    } catch (saveErr) {
      console.error("[FreeLLM] Failed to persist final agent reply:", saveErr);
    }
  }

  if (onEvent) {
    await onEvent({ type: "done" });
  }

  return {
    fullResponse: finalResponse,
    turnCount,
    toolCallsCount,
    lastStatus: lastObservedStatus,
  };
}
