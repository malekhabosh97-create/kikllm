import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  parseToolCall,
  executeTool,
  TOOL_INSTRUCTIONS,
} from "../adapters/freellm-browser/tool-executor.js";
import { assertSafeWorkspacePath } from "../services/file-mutation.js";

describe("FreeLLM Browser Execution & Tool Suite", () => {
  const workspaceRoot = fs.existsSync(path.resolve(process.cwd(), "server"))
    ? process.cwd()
    : path.resolve(process.cwd(), "..");

  describe("Tool Protocol & Parsing (parseToolCall)", () => {
    it("parses valid tool_call fenced block", () => {
      const response = `Here is my plan to inspect the project:
\`\`\`tool_call
{
  "callId": "call_inspect_1",
  "tool": "get_project_context",
  "arguments": { "path": "." }
}
\`\`\`
I will await the result.`;

      const toolCall = parseToolCall(response);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.tool).toBe("get_project_context");
      expect(toolCall?.callId).toBe("call_inspect_1");
      expect(toolCall?.arguments).toEqual({ path: "." });
    });

    it("parses raw JSON tool call without markdown backticks", () => {
      const response = `{"callId": "call_list_2", "tool": "list_dir", "arguments": {"path": "server"}}`;
      const toolCall = parseToolCall(response);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.tool).toBe("list_dir");
      expect(toolCall?.callId).toBe("call_list_2");
      expect(toolCall?.arguments).toEqual({ path: "server" });
    });

    it("parses create_agent action proposal block", () => {
      const response = `I recommend creating a frontend specialist:
\`\`\`json
{
  "action": "create_agent",
  "name": "UI Specialist",
  "role": "engineer",
  "title": "React Frontend Dev",
  "model": "deepseek-normal",
  "systemPrompt": "Focus on high accessibility and smooth animations."
}
\`\`\``;

      const toolCall = parseToolCall(response);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.tool).toBe("create_agent");
      expect(toolCall?.arguments.name).toBe("UI Specialist");
      expect(toolCall?.arguments.model).toBe("deepseek-normal");
      expect(toolCall?.arguments.systemPrompt).toContain("high accessibility");
    });

    it("returns null when model gives final natural language response without tools", () => {
      const response = "All tasks have been completed and verified. Here is the final summary of the changes.";
      const toolCall = parseToolCall(response);
      expect(toolCall).toBeNull();
    });

    it("ignores illustrative/explanatory examples containing tool syntax in English", () => {
      const response = `Here is an example of how you would call the tool, but do not execute it:
\`\`\`tool_call
{
  "callId": "call_sample_1",
  "tool": "run_command",
  "arguments": {
    "command": "rm -rf /"
  }
}
\`\`\`
This was just an example demonstration.`;

      const toolCall = parseToolCall(response);
      expect(toolCall).toBeNull();
    });

    it("ignores illustrative examples containing tool syntax in Arabic", () => {
      const response = `على سبيل المثال، يمكنك استخدام أداة تشغيل الأوامر كالتالي:
\`\`\`tool_call
{
  "callId": "call_example_ar",
  "tool": "run_command",
  "arguments": {
    "command": "npm test"
  }
}
\`\`\`
هذا نموذج توضيحي فقط ولا يجب تشغيله الآن. سأقوم بفحص الملفات أولاً.`;

      const toolCall = parseToolCall(response);
      expect(toolCall).toBeNull();
    });

    it("ignores blocks with example: true or callId marked as sample/demo", () => {
      const response = `\`\`\`tool_call
{
  "callId": "demo-tool-call",
  "tool": "run_command",
  "arguments": { "command": "echo hello" },
  "example": true
}
\`\`\``;

      const toolCall = parseToolCall(response);
      expect(toolCall).toBeNull();
    });

    it("correctly extracts a real executable tool call even when an illustrative example is present", () => {
      const response = `For example, one might run:
\`\`\`tool_call
{
  "callId": "sample_call",
  "tool": "run_command",
  "arguments": { "command": "echo demo" }
}
\`\`\`
However, what we actually need to do right now is get the project context:
\`\`\`tool_call
{
  "callId": "call_real_exec_1",
  "tool": "get_project_context",
  "arguments": {}
}
\`\`\``;

      const toolCall = parseToolCall(response);
      expect(toolCall).not.toBeNull();
      expect(toolCall?.tool).toBe("get_project_context");
      expect(toolCall?.callId).toBe("call_real_exec_1");
    });
  });

  describe("Tool Execution (executeTool)", () => {
    it("executes get_project_context and returns real repository metadata", async () => {
      const result = await executeTool(
        {
          callId: "call_ctx",
          tool: "get_project_context",
          arguments: {},
        },
        workspaceRoot,
      );

      expect(result).toContain("[PROJECT CONTEXT SUMMARY]");
      expect(result).toContain("Root:");
      expect(result).toContain("Top-level Items:");
    });

    it("executes list_dir and lists files with sizes", async () => {
      const result = await executeTool(
        {
          callId: "call_list",
          tool: "list_dir",
          arguments: { path: "server" },
        },
        workspaceRoot,
      );

      expect(result).toContain("[DIRECTORY LISTING: server");
      expect(result).toContain("[FILE] package.json");
    });

    it("executes read_file and returns numbered lines", async () => {
      const result = await executeTool(
        {
          callId: "call_read",
          tool: "read_file",
          arguments: { path: "package.json", maxLines: 15 },
        },
        workspaceRoot,
      );

      expect(result).toContain("[FILE CONTENT: package.json");
      expect(result).toContain("1: {");
    });

    it("prevents path traversal attacks in read_file", async () => {
      const result = await executeTool(
        {
          callId: "call_traversal",
          tool: "read_file",
          arguments: { path: "../../Windows/System32/drivers/etc/hosts" },
        },
        workspaceRoot,
      );

      expect(result).toContain("Security Violation");
    });

    it("executes run_command and captures stdout and exit code", async () => {
      const result = await executeTool(
        {
          callId: "call_cmd",
          tool: "run_command",
          arguments: { command: "node -v" },
        },
        workspaceRoot,
      );

      expect(result).toContain("[COMMAND RESULT (exit code 0)]");
      expect(result).toContain("STDOUT:\nv");
    });

    it("rejects dangerous destructive commands in run_command", async () => {
      const result = await executeTool(
        {
          callId: "call_danger",
          tool: "run_command",
          arguments: { command: "rm -rf /" },
        },
        workspaceRoot,
      );

      expect(result).toContain("[ERROR] Command rejected for security reasons.");
    });

    it("stages propose_file_mutation with SHA-256 and diff preview", async () => {
      const relPath = "server/.paperclip/test-mutation-file.txt";
      const result = await executeTool(
        {
          callId: "call_mut",
          tool: "propose_file_mutation",
          arguments: {
            relativePath: relPath,
            operation: "create",
            content: "Hello from FreeLLM test mutation",
          },
        },
        workspaceRoot,
      );

      expect(result).toContain("[MUTATION STAGED SUCCESSFULLY]");
      expect(result).toContain("Staged SHA-256:");
      expect(result).toContain("Diff Preview:");
      expect(result).toContain("awaiting Board / User approval");
    });
  });

  describe("Empirical Task Verification (verify_task)", () => {
    it("reports PASSED when deliverables exist and tests exit with code 0", async () => {
      const result = await executeTool(
        {
          callId: "call_verify_pass",
          tool: "verify_task",
          arguments: {
            taskId: "task-101",
            expectedFiles: ["package.json"],
            testCommand: "node -e \"process.exit(0)\"",
          },
        },
        workspaceRoot,
      );

      expect(result).toContain("Verdict: VERIFICATION PASSED");
      expect(result).toContain("✅ Verified: 'package.json'");
      expect(result).toContain("✅ Tests PASSED (Exit code 0)");
    });

    it("reports FAILED and rejects delivery when deliverable file is missing", async () => {
      const result = await executeTool(
        {
          callId: "call_verify_fail",
          tool: "verify_task",
          arguments: {
            taskId: "task-102",
            expectedFiles: ["non_existent_file_xyz123.txt"],
          },
        },
        workspaceRoot,
      );

      expect(result).toContain("Verdict: VERIFICATION FAILED");
      expect(result).toContain("❌ Missing: 'non_existent_file_xyz123.txt' does not exist on disk");
    });

    it("reports FAILED and rejects delivery when verification test command fails", async () => {
      const result = await executeTool(
        {
          callId: "call_verify_fail_cmd",
          tool: "verify_task",
          arguments: {
            taskId: "task-103",
            expectedFiles: ["package.json"],
            testCommand: "node -e \"console.error('AssertionError: expected true to be false'); process.exit(1)\"",
          },
        },
        workspaceRoot,
      );

      expect(result).toContain("Verdict: VERIFICATION FAILED");
      expect(result).toContain("❌ Tests FAILED (Exit code 1)");
      expect(result).toContain("AssertionError");
    });
  });

  describe("Team Management & Delegation Tools (DB-backed)", () => {
    it("executes list_agents and formats agent roster", async () => {
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "agt-1",
                name: "CEO - Gemini Argon",
                role: "ceo",
                title: "Executive Lead",
                status: "idle",
                adapterConfig: { model: "gemini-argon" },
              },
              {
                id: "agt-2",
                name: "Fullstack Dev",
                role: "engineer",
                title: "Fullstack Developer",
                status: "busy",
                adapterConfig: { model: "deepseek-normal" },
              },
            ]),
          }),
        }),
      };

      const result = await executeTool(
        {
          callId: "call_roster",
          tool: "list_agents",
          arguments: {},
        },
        workspaceRoot,
        undefined,
        mockDb,
        "comp-1",
      );

      expect(result).toContain("[COMPANY AGENT ROSTER (2 agents)]");
      expect(result).toContain("CEO - Gemini Argon [ID: agt-1]");
      expect(result).toContain("Fullstack Dev [ID: agt-2]");
    });

    it("executes create_agent, writes instructions file, and records agent in DB", async () => {
      const insertedAgent = {
        id: "agt-new-1",
        name: "DevOps Engineer",
        role: "devops",
        title: "CI/CD & Cloud Specialist",
        status: "idle",
      };

      const mockDb: any = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([insertedAgent]),
          }),
        }),
      };

      const result = await executeTool(
        {
          callId: "call_create_ag",
          tool: "create_agent",
          arguments: {
            name: "DevOps Engineer",
            role: "devops",
            title: "CI/CD & Cloud Specialist",
            model: "gemini-flash",
            systemPrompt: "Maintain robust pipelines, automated testing, and zero downtime deployments.",
          },
        },
        workspaceRoot,
        undefined,
        mockDb,
        "comp-1",
      );

      expect(result).toContain("[AGENT CREATED SUCCESSFULLY]");
      expect(result).toContain("Agent ID: agt-new-1");
      expect(result).toContain("Name: DevOps Engineer");
      expect(result).toContain("Model: gemini-flash");
      expect(result).toContain("Instructions Stored: Yes");
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("executes delegate_task and registers real task with acceptance criteria in DB", async () => {
      const createdTask = {
        id: "tsk-888",
        title: "Implement Auth Flow",
        priority: "high",
        status: "todo",
      };

      const mockDb: any = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([createdTask]),
          }),
        }),
      };

      const result = await executeTool(
        {
          callId: "call_delegate",
          tool: "delegate_task",
          arguments: {
            agentId: "agt-2",
            title: "Implement Auth Flow",
            description: "Implement local OAuth2 device login flow.",
            priority: "high",
            acceptanceCriteria: [
              "Unit tests pass",
              "Tokens securely persisted in storage",
            ],
          },
        },
        workspaceRoot,
        undefined,
        mockDb,
        "comp-1",
      );

      expect(result).toContain("[TASK DELEGATED SUCCESSFULLY]");
      expect(result).toContain("Task ID: tsk-888");
      expect(result).toContain("Assignee Agent: agt-2");
      expect(result).toContain("Priority: high");
      expect(result).toContain("Acceptance Criteria Defined: 2 items.");
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("executes send_agent_message and records message in agent conversation thread", async () => {
      const targetAgent = { id: "agt-target", name: "QA Auditor" };
      const createdComment = { id: "cmt-999" };

      let selectCount = 0;
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              selectCount++;
              if (selectCount === 1) {
                // targetAgent query
                return Promise.resolve([targetAgent]);
              }
              // existingIssue query with limit(1)
              return {
                limit: vi.fn().mockResolvedValue([{ id: "iss-123" }]),
              };
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([createdComment]),
          }),
        }),
      };

      const result = await executeTool(
        {
          callId: "call_msg",
          tool: "send_agent_message",
          arguments: {
            targetAgentId: "agt-target",
            message: "Please audit the staged file mutations before final delivery.",
          },
        },
        workspaceRoot,
        { agent: { id: "agt-ceo", name: "CEO" } },
        mockDb,
        "comp-1",
      );

      expect(result).toContain("[MESSAGE DELIVERED TO AGENT]");
      expect(result).toContain("Delivered to: QA Auditor");
      expect(result).toContain("Message ID: cmt-999");
    });
  });
});
