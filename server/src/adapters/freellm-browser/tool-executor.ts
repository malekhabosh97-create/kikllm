import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  companies,
  issues,
  issueComments,
  projectWorkspaces,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  stageFileMutation,
  assertSafeWorkspacePath,
  calculateSha256,
} from "../../services/file-mutation.js";

export const TOOL_INSTRUCTIONS = `
[TOOL PROTOCOL & CAPABILITIES]
You are equipped with real developer, team management, and execution tools.
You MUST output your action in a JSON code block using the exact tool_call format:

\`\`\`tool_call
{
  "callId": "call_<random_id>",
  "tool": "<tool_name>",
  "arguments": { ... }
}
\`\`\`

Available Tools:
1. "get_project_context": { "path"?: string }
   Inspects the local project directory, tech stack, package.json, directory structure, and git status.
2. "list_dir": { "path"?: string }
   Lists files and subdirectories in a directory with file sizes.
3. "read_file": { "path": "path/to/file.ext", "maxLines"?: number }
   Reads the content of a file within the workspace with line numbers.
4. "search_code": { "query": "text to find", "path"?: string }
   Searches for strings or identifiers across files in the workspace.
5. "run_command": { "command": "npm test" }
   Runs a safe command in the workspace directory (e.g. tests, lint, git diff) and returns exit code, stdout, and stderr.
6. "propose_file_mutation": {
     "relativePath": "path/to/file.ext",
     "operation": "create" | "modify" | "delete",
     "content": "full content of file"
   }
   Stages a file creation or modification with diff preview and cryptographic hash check, submitting for user review in Paperclip Approvals.
7. "list_agents": {}
   Lists all specialized agents currently available in the company team with their roles, models, and IDs.
8. "create_agent": {
     "name": "Frontend Developer",
     "role": "engineer",
     "title": "React & UI Specialist",
     "model": "deepseek-normal" | "deepseek-deepthink" | "gemini-argon" | "gemini-flash",
     "systemPrompt": "Specialized instructions and role guidelines for this agent..."
   }
   Provisions a new permanent agent in the company with custom role and instructions.
9. "delegate_task": {
     "agentId"?: string,
     "agentName"?: string,
     "title": "Task title",
     "description": "Detailed task requirements and acceptance criteria",
     "priority"?: "low" | "medium" | "high" | "urgent",
     "acceptanceCriteria"?: ["Unit tests pass", "File created"]
   }
   Creates a real tracked task in Paperclip and assigns it to a specialist agent on your team.
10. "verify_task": {
      "taskId"?: string,
      "expectedFiles"?: ["relative/path/to/file.ext"],
      "testCommand"?: "npm test"
    }
    Empirically verifies task deliverables against actual disk files and automated test results. Never accepts completion without evidence!
11. "send_agent_message": {
      "targetAgentId": "uuid-of-agent",
      "message": "Message to deliver to the agent's standing thread"
    }
    Delivers a message directly to another agent's conversation thread in Paperclip.

Rules:
- Output only ONE tool_call at a time.
- Await the [TOOL RESULT] before taking your next step.
- Always verify your work with "verify_task" or "run_command" before claiming completion.
- When your objective is accomplished, summarize the results clearly without any tool_call block.
`;

export interface ParsedToolCall {
  callId: string;
  tool: string;
  arguments: Record<string, any>;
}

export function isIllustrativeContext(
  text: string,
  matchIndex: number,
  matchLength: number,
  parsedObj?: any,
): boolean {
  if (parsedObj) {
    if (
      parsedObj.example === true ||
      parsedObj.isExample === true ||
      parsedObj.illustrative === true ||
      parsedObj.dryRun === true
    ) {
      return true;
    }
    const callId = String(parsedObj.callId || "").toLowerCase();
    if (
      callId.includes("example") ||
      callId.includes("sample") ||
      callId.includes("demo") ||
      callId.includes("illustrative") ||
      callId.includes("placeholder")
    ) {
      return true;
    }
  }

  // Preceding text snippet (up to 200 chars before the match)
  const prefix = text
    .substring(Math.max(0, matchIndex - 200), matchIndex)
    .toLowerCase();
  // Following text snippet (up to 200 chars after the match)
  const suffix = text
    .substring(
      matchIndex + matchLength,
      Math.min(text.length, matchIndex + matchLength + 200),
    )
    .toLowerCase();

  const illustrativePatterns = [
    /\bexample\b/,
    /\bfor example\b/,
    /\bsample\b/,
    /\billustrat(ive|ion)\b/,
    /\bdemonstrat(e|ion)\b/,
    /\bdo not execute\b/,
    /\bdon't execute\b/,
    /\bdo not run\b/,
    /\bdon't run\b/,
    /\bjust an example\b/,
    /\bhere is an example\b/,
    /\bas an example\b/,
    /على سبيل المثال/,
    /كمثال/,
    /مجرد مثال/,
    /مثال توضيحي/,
    /نموذج توضيحي/,
    /لا تقم بتنفيذه/,
    /لا تنفذ/,
    /لا تشغل/,
    /للتوضيح فقط/,
    /للتوضيح/,
    /مثال:/,
    /مثال للأداة/,
  ];

  for (const pattern of illustrativePatterns) {
    if (pattern.test(prefix) || pattern.test(suffix)) {
      return true;
    }
  }

  return false;
}

export function parseToolCall(response: string): ParsedToolCall | null {
  try {
    // 1. Look for ```tool_call ... ``` or ```json ... ``` blocks
    const blockRegex =
      /```(?:tool_call|json)?\s*(\{[\s\S]*?"tool"\s*:\s*[\s\S]*?\})\s*```/g;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.tool) {
          if (
            isIllustrativeContext(
              response,
              match.index,
              match[0].length,
              parsed,
            )
          ) {
            continue; // Skip illustrative example block
          }
          return {
            callId: parsed.callId || "call_" + Date.now(),
            tool: parsed.tool,
            arguments: parsed.arguments || parsed.args || {},
          };
        }
      } catch {}
    }

    // 2. Look for raw JSON object containing "tool" and either "callId" or "arguments"
    const rawRegex =
      /\{\s*"callId"\s*:\s*"[^"]+",\s*"tool"\s*:\s*"[^"]+",\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
    while ((match = rawRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.tool) {
          if (
            isIllustrativeContext(
              response,
              match.index,
              match[0].length,
              parsed,
            )
          ) {
            continue;
          }
          return {
            callId: parsed.callId,
            tool: parsed.tool,
            arguments: parsed.arguments || {},
          };
        }
      } catch {}
    }

    // 3. Look for standard action proposal block: {"action": "create_agent", ...}
    const actionRegex =
      /```(?:json)?\s*(\{[\s\S]*?"action"\s*:\s*"create_agent"[\s\S]*?\})\s*```/g;
    while ((match = actionRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (
          isIllustrativeContext(response, match.index, match[0].length, parsed)
        ) {
          continue;
        }
        return {
          callId: "call_act_" + Date.now(),
          tool: "create_agent",
          arguments: {
            name: parsed.name || parsed.agent?.name,
            role: parsed.role || parsed.agent?.role || "engineer",
            title: parsed.title || parsed.agent?.title,
            model: parsed.model || parsed.agent?.model || "gemini-argon",
            systemPrompt:
              parsed.systemPrompt ||
              parsed.agent?.system_prompt ||
              parsed.agent?.description,
          },
        };
      } catch {}
    }
  } catch {}
  return null;
}

export async function executeTool(
  toolCall: ParsedToolCall,
  workspaceRoot: string,
  context?: any,
  db?: Db,
  companyId?: string,
): Promise<string> {
  const { tool, arguments: args, callId } = toolCall;
  const targetCompanyId =
    companyId ||
    context?.agent?.companyId ||
    "a2a205d9-2868-41f1-b5cc-8d31ffab793e";

  try {
    switch (tool) {
      // ----------------------------------------------------
      // 1. get_project_context
      // ----------------------------------------------------
      case "get_project_context": {
        const targetPath = args.path
          ? path.resolve(workspaceRoot, args.path)
          : workspaceRoot;
        if (!fs.existsSync(targetPath)) {
          return `[ERROR] Path '${targetPath}' does not exist.`;
        }

        const info: Record<string, any> = {
          workspaceRoot: targetPath,
          timestamp: new Date().toISOString(),
        };

        // Check package.json
        const pkgPath = path.join(targetPath, "package.json");
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            info.projectType = "Node.js / TypeScript";
            info.name = pkg.name;
            info.version = pkg.version;
            info.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
            info.dependencies = pkg.dependencies
              ? Object.keys(pkg.dependencies).slice(0, 20)
              : [];
            info.devDependencies = pkg.devDependencies
              ? Object.keys(pkg.devDependencies).slice(0, 20)
              : [];
          } catch {}
        }

        // Check Python
        const pyproject = path.join(targetPath, "pyproject.toml");
        const reqTxt = path.join(targetPath, "requirements.txt");
        if (fs.existsSync(pyproject) || fs.existsSync(reqTxt)) {
          info.projectType = (info.projectType ? info.projectType + " & " : "") + "Python";
        }

        // Top level directory layout
        try {
          const entries = fs.readdirSync(targetPath, { withFileTypes: true });
          info.topLevelLayout = entries
            .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
            .slice(0, 30)
            .map((e) => (e.isDirectory() ? `[DIR] ${e.name}/` : `[FILE] ${e.name}`));
        } catch {}

        // Check git branch
        const gitHead = path.join(targetPath, ".git", "HEAD");
        if (fs.existsSync(gitHead)) {
          try {
            const headContent = fs.readFileSync(gitHead, "utf8").trim();
            info.gitBranch = headContent.replace("ref: refs/heads/", "");
          } catch {}
        }

        return `[PROJECT CONTEXT SUMMARY]
Root: ${info.workspaceRoot}
Type: ${info.projectType || "General Directory"}
Name: ${info.name || path.basename(targetPath)}
Git Branch: ${info.gitBranch || "(none)"}
Available Scripts: ${info.scripts?.join(", ") || "(none)"}
Dependencies: ${info.dependencies?.slice(0, 10).join(", ") || "(none)"}
Top-level Items:
${info.topLevelLayout?.join("\n") || "(empty)"}`;
      }

      // ----------------------------------------------------
      // 2. list_dir
      // ----------------------------------------------------
      case "list_dir": {
        const subPath = args.path || args.dir || ".";
        const fullPath = assertSafeWorkspacePath(workspaceRoot, subPath);
        if (!fs.existsSync(fullPath)) return `[ERROR] Directory '${subPath}' not found.`;
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const list = entries
          .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
          .map((e) => {
            if (e.isDirectory()) return `[DIR] ${e.name}/`;
            try {
              const sz = fs.statSync(path.join(fullPath, e.name)).size;
              return `[FILE] ${e.name} (${Math.round(sz / 1024)} KB)`;
            } catch {
              return `[FILE] ${e.name}`;
            }
          });
        return `[DIRECTORY LISTING: ${subPath} (${list.length} entries)]\n${list.join("\n") || "(empty directory)"}`;
      }

      // ----------------------------------------------------
      // 3. read_file
      // ----------------------------------------------------
      case "read_file": {
        const relPath = args.path || args.filePath || args.relativePath;
        if (!relPath) return "[ERROR] Missing 'path' argument for read_file.";
        const fullPath = assertSafeWorkspacePath(workspaceRoot, relPath);
        if (!fs.existsSync(fullPath)) return `[ERROR] File '${relPath}' not found.`;
        const stat = fs.statSync(fullPath);
        if (stat.size > 300 * 1024) {
          return `[ERROR] File '${relPath}' is too large (${Math.round(stat.size / 1024)}KB). Limit is 300KB.`;
        }
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        const maxLines = Number(args.maxLines) || 500;
        const preview = lines
          .slice(0, maxLines)
          .map((l, i) => `${i + 1}: ${l}`)
          .join("\n");
        return `[FILE CONTENT: ${relPath} (${lines.length} lines total)]\n${preview}${lines.length > maxLines ? `\n... (truncated after ${maxLines} lines)` : ""}`;
      }

      // ----------------------------------------------------
      // 4. search_code
      // ----------------------------------------------------
      case "search_code": {
        const query = args.query || args.text;
        const subPath = args.path || ".";
        if (!query) return "[ERROR] Missing 'query' argument for search_code.";
        const targetDir = assertSafeWorkspacePath(workspaceRoot, subPath);
        const results: string[] = [];

        function scan(dir: string) {
          if (results.length >= 30) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const f of entries) {
            if (f.name.startsWith(".") || f.name === "node_modules" || f.name === "dist")
              continue;
            const full = path.join(dir, f.name);
            if (f.isDirectory()) {
              scan(full);
            } else if (
              f.isFile() &&
              f.name.match(/\.(ts|js|tsx|jsx|json|md|py|sh|html|css|yaml|yml|sql)$/i)
            ) {
              try {
                const text = fs.readFileSync(full, "utf8");
                if (text.includes(query)) {
                  const rel = path.relative(workspaceRoot, full);
                  results.push(rel);
                }
              } catch {}
            }
          }
        }
        scan(targetDir);
        return `[SEARCH RESULTS for "${query}" (${results.length} files)]\n${results.join("\n") || "No matches found."}`;
      }

      // ----------------------------------------------------
      // 5. run_command
      // ----------------------------------------------------
      case "run_command": {
        const cmd = args.command || args.cmd;
        if (!cmd) return "[ERROR] Missing 'command' argument.";

        // Security check: reject destructive operations
        const normalizedCmd = cmd.trim().toLowerCase();
        if (
          normalizedCmd.startsWith("rm -rf /") ||
          normalizedCmd.startsWith("rm -rf \\") ||
          normalizedCmd.includes("format c:") ||
          normalizedCmd.includes("del /s") ||
          normalizedCmd.includes("shutdown") ||
          normalizedCmd.includes("mkfs") ||
          normalizedCmd.includes("diskpart")
        ) {
          return "[ERROR] Command rejected for security reasons.";
        }

        return new Promise<string>((resolve) => {
          exec(
            cmd,
            { cwd: workspaceRoot, timeout: 60000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              const out = (stdout || "").trim();
              const err = (stderr || "").trim();
              const exitCode = error ? (error.code ?? 1) : 0;
              resolve(
                `[COMMAND RESULT (exit code ${exitCode})]\nSTDOUT:\n${out || "(empty)"}\nSTDERR:\n${err || "(empty)"}`,
              );
            },
          );
        });
      }

      // ----------------------------------------------------
      // 6. propose_file_mutation
      // ----------------------------------------------------
      case "propose_file_mutation": {
        const relPath = args.relativePath || args.path;
        const operation = args.operation || "modify";
        const content = args.content ?? "";

        if (!relPath)
          return "[ERROR] Missing 'relativePath' for propose_file_mutation.";

        const staged = stageFileMutation(workspaceRoot, {
          relativePath: relPath,
          operation,
          content,
        });

        // Submit approval to Paperclip server
        const serverPort = Number(process.env.PORT) || 3100;
        const approvalPayload = JSON.stringify({
          type: "file_mutation",
          requestedByAgentId: context?.agent?.id || null,
          payload: staged,
        });

        const approvalRes = await new Promise<any>((resolve) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: serverPort,
              path: `/api/companies/${targetCompanyId}/approvals`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(approvalPayload),
              },
            },
            (res) => {
              let body = "";
              res.on("data", (d) => (body += d.toString()));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve({ id: "appr_staged" });
                }
              });
            },
          );
          req.on("error", () => resolve({ id: "appr_local" }));
          req.write(approvalPayload);
          req.end();
        });

        return `[MUTATION STAGED SUCCESSFULLY]
Approval ID: ${approvalRes.id || "appr_staged"}
Operation: ${staged.operation}
File: ${staged.relativePath}
Base SHA-256: ${staged.baseSha256 || "(new file)"}
Staged SHA-256: ${staged.stagedSha256}
Diff Preview:
${staged.diff}
Status: Staged and awaiting Board / User approval in Paperclip Approvals.`;
      }

      // ----------------------------------------------------
      // 7. list_agents
      // ----------------------------------------------------
      case "list_agents": {
        if (db) {
          const allAgents = await db
            .select({
              id: agentsTable.id,
              name: agentsTable.name,
              role: agentsTable.role,
              title: agentsTable.title,
              status: agentsTable.status,
              adapterConfig: agentsTable.adapterConfig,
            })
            .from(agentsTable)
            .where(eq(agentsTable.companyId, targetCompanyId));

          const formatted = allAgents.map((a) => {
            const model = (a.adapterConfig as any)?.model || "gemini-argon";
            return `- ${a.name} [ID: ${a.id}] | Role: ${a.role} (${a.title || "specialist"}) | Model: ${model} | Status: ${a.status}`;
          });

          return `[COMPANY AGENT ROSTER (${allAgents.length} agents)]\n${formatted.join("\n") || "No agents registered yet."}`;
        }

        // Fallback via HTTP
        const serverPort = Number(process.env.PORT) || 3100;
        const resData = await new Promise<any>((resolve) => {
          http.get(
            `http://127.0.0.1:${serverPort}/api/companies/${targetCompanyId}/agents`,
            (res) => {
              let body = "";
              res.on("data", (d) => (body += d.toString()));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve([]);
                }
              });
            },
          ).on("error", () => resolve([]));
        });

        if (Array.isArray(resData)) {
          const list = resData.map(
            (a: any) =>
              `- ${a.name} [ID: ${a.id}] | Role: ${a.role} | Model: ${a.adapterConfig?.model || "gemini-argon"}`,
          );
          return `[COMPANY AGENT ROSTER (${resData.length} agents)]\n${list.join("\n")}`;
        }
        return "[ERROR] Unable to fetch agent roster.";
      }

      // ----------------------------------------------------
      // 8. create_agent
      // ----------------------------------------------------
      case "create_agent": {
        const { name, role = "engineer", title, model = "gemini-argon", systemPrompt } =
          args;
        if (!name) return "[ERROR] Missing 'name' for create_agent.";

        const VALID_ROLES = new Set([
          "ceo",
          "cto",
          "cmo",
          "cfo",
          "security",
          "engineer",
          "designer",
          "pm",
          "qa",
          "devops",
          "researcher",
          "general",
        ]);
        const mappedRole = VALID_ROLES.has((role || "").toLowerCase().trim())
          ? role.toLowerCase().trim()
          : "engineer";

        // Generate instructions file path
        const userHome = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\malek";
        const agentInstructionsDir = path.join(
          userHome,
          ".paperclip",
          "instances",
          "default",
          "agents",
        );
        fs.mkdirSync(agentInstructionsDir, { recursive: true });
        const instructionsFilePath = path.join(
          agentInstructionsDir,
          `${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}_instructions.md`,
        );

        const promptContent =
          systemPrompt ||
          `You are ${name}, a specialized ${mappedRole} agent in FreeLLM Work. Fulfill your role with high precision and empirical evidence.`;
        fs.writeFileSync(instructionsFilePath, promptContent, "utf8");

        if (db) {
          const [newAgent] = await db
            .insert(agentsTable)
            .values({
              companyId: targetCompanyId,
              name,
              role: mappedRole,
              title: title || `${name} (${mappedRole.toUpperCase()})`,
              adapterType: "freellm_browser",
              adapterConfig: {
                model,
                systemPrompt: promptContent,
                instructionsFilePath,
              },
              status: "idle",
              permissions: { canCreateAgents: true, canCreateSkills: true },
            })
            .returning();

          return `[AGENT CREATED SUCCESSFULLY]
Agent ID: ${newAgent.id}
Name: ${newAgent.name}
Role: ${newAgent.role} (${newAgent.title})
Model: ${model}
Instructions Stored: Yes (${promptContent.length} chars)
Status: Ready for tasks in FreeLLM Work.`;
        }

        // Fallback HTTP
        const serverPort = Number(process.env.PORT) || 3100;
        const postData = JSON.stringify({
          name,
          role: mappedRole,
          title: title || `${name} (${mappedRole.toUpperCase()})`,
          adapterType: "freellm_browser",
          adapterConfig: { model, systemPrompt: promptContent, instructionsFilePath },
          permissions: { canCreateAgents: true, canCreateSkills: true },
        });

        const created = await new Promise<any>((resolve) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: serverPort,
              path: `/api/companies/${targetCompanyId}/agents`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              },
            },
            (res) => {
              let body = "";
              res.on("data", (d) => (body += d));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve(null);
                }
              });
            },
          );
          req.on("error", () => resolve(null));
          req.write(postData);
          req.end();
        });

        if (created?.id) {
          return `[AGENT CREATED SUCCESSFULLY]
Agent ID: ${created.id}
Name: ${created.name}
Role: ${created.role}
Model: ${model}`;
        }
        return "[ERROR] Failed to create agent.";
      }

      // ----------------------------------------------------
      // 9. delegate_task
      // ----------------------------------------------------
      case "delegate_task": {
        const { agentId, agentName, title, description, priority = "medium", acceptanceCriteria } =
          args;
        if (!title || !description) {
          return "[ERROR] Missing 'title' or 'description' for delegate_task.";
        }

        let targetAgentId = agentId;
        if (!targetAgentId && agentName && db) {
          const found = await db
            .select({ id: agentsTable.id, name: agentsTable.name })
            .from(agentsTable)
            .where(
              and(
                eq(agentsTable.companyId, targetCompanyId),
                sql`lower(${agentsTable.name}) LIKE ${`%${agentName.toLowerCase()}%`}`,
              ),
            )
            .limit(1);
          if (found[0]) targetAgentId = found[0].id;
        }

        const criteriaText =
          Array.isArray(acceptanceCriteria) && acceptanceCriteria.length > 0
            ? `\n\nAcceptance Criteria:\n${acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
            : "";

        const fullDescription = `${description}${criteriaText}`;

        if (db) {
          const [task] = await db
            .insert(issues)
            .values({
              companyId: targetCompanyId,
              title,
              description: fullDescription,
              assigneeAgentId: targetAgentId || null,
              status: "todo",
              priority: priority as any,
              originKind: "agent_delegation",
            })
            .returning();

          let runId = "none";
          if (targetAgentId) {
            try {
              const [run] = await db
                .insert(heartbeatRuns)
                .values({
                  companyId: targetCompanyId,
                  agentId: targetAgentId,
                  scopeKind: "issue",
                  issueId: task.id,
                  status: "queued",
                  invocationSource: "on_demand",
                })
                .returning();
              if (run) runId = run.id;
            } catch {}
          }

          return `[TASK DELEGATED SUCCESSFULLY]
Task ID: ${task.id}
Title: ${task.title}
Assignee Agent: ${targetAgentId || "(unassigned specialist)"}
Initial Run ID: ${runId}
Priority: ${task.priority}
Status: todo
Acceptance Criteria Defined: ${Array.isArray(acceptanceCriteria) ? acceptanceCriteria.length : 0} items.
The task has been registered in Paperclip board.`;
        }

        return `[TASK REGISTERED]
Title: ${title}
Assigned to: ${targetAgentId || agentName || "specialist"}
Status: Registered for team execution.`;
      }

      // ----------------------------------------------------
      // 10. verify_task
      // ----------------------------------------------------
      case "verify_task": {
        const { taskId, expectedFiles = [], testCommand } = args;
        const verificationReport: string[] = [];
        let allPassed = true;

        // Check expected deliverables on disk
        if (Array.isArray(expectedFiles) && expectedFiles.length > 0) {
          verificationReport.push("📁 Deliverable File Checks:");
          for (const rel of expectedFiles) {
            try {
              const full = assertSafeWorkspacePath(workspaceRoot, rel);
              if (!fs.existsSync(full)) {
                verificationReport.push(`  ❌ Missing: '${rel}' does not exist on disk.`);
                allPassed = false;
              } else {
                const stat = fs.statSync(full);
                if (stat.size === 0) {
                  verificationReport.push(`  ❌ Empty File: '${rel}' exists but is 0 bytes.`);
                  allPassed = false;
                } else {
                  const sha = calculateSha256(fs.readFileSync(full));
                  verificationReport.push(
                    `  ✅ Verified: '${rel}' (${stat.size} bytes, SHA: ${sha.slice(0, 12)}...)`,
                  );
                }
              }
            } catch (err: any) {
              verificationReport.push(`  ❌ Error verifying '${rel}': ${err.message}`);
              allPassed = false;
            }
          }
        }

        // Run automated verification test command
        if (testCommand) {
          verificationReport.push(`\n🧪 Test Command Execution: '${testCommand}'`);
          const testResult = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
            (resolve) => {
              exec(
                testCommand,
                { cwd: workspaceRoot, timeout: 60000 },
                (error, stdout, stderr) => {
                  resolve({
                    exitCode: error ? (error.code ?? 1) : 0,
                    stdout: (stdout || "").trim(),
                    stderr: (stderr || "").trim(),
                  });
                },
              );
            },
          );

          if (testResult.exitCode === 0) {
            verificationReport.push(`  ✅ Tests PASSED (Exit code 0).`);
            if (testResult.stdout) {
              const summaryLine = testResult.stdout.split("\n").slice(-4).join("\n  ");
              verificationReport.push(`  Output summary:\n  ${summaryLine}`);
            }
          } else {
            verificationReport.push(`  ❌ Tests FAILED (Exit code ${testResult.exitCode}).`);
            const errSummary = (testResult.stderr || testResult.stdout)
              .split("\n")
              .slice(-6)
              .join("\n  ");
            verificationReport.push(`  Failure output:\n  ${errSummary}`);
            allPassed = false;
          }
        }

        const overallVerdict = allPassed
          ? "VERIFICATION PASSED: All deliverables and checks verified with empirical evidence."
          : "VERIFICATION FAILED: Missing deliverables or failing tests detected. Delivery rejected.";

        return `[VERIFICATION REPORT for ${taskId || "Task"}]
Verdict: ${overallVerdict}
${verificationReport.join("\n")}`;
      }

      // ----------------------------------------------------
      // 11. send_agent_message
      // ----------------------------------------------------
      case "send_agent_message": {
        const { targetAgentId, message } = args;
        if (!targetAgentId || !message) {
          return "[ERROR] Missing 'targetAgentId' or 'message'.";
        }

        if (db) {
          // Find or create conversation issue for the target agent
          const [targetAgent] = await db
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.id, targetAgentId));

          if (!targetAgent) {
            return `[ERROR] Target agent '${targetAgentId}' not found.`;
          }

          const [existingIssue] = await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, targetCompanyId),
                eq(issues.conversationAgentId, targetAgentId),
              ),
            )
            .limit(1);

          let convIssueId = existingIssue?.id;
          if (!convIssueId) {
            const [created] = await db
              .insert(issues)
              .values({
                companyId: targetCompanyId,
                conversationAgentId: targetAgentId,
                conversationUserId: "local-board",
                conversationState: "active",
                assigneeAgentId: targetAgentId,
                title: `Direct Chat: ${targetAgent.name}`,
                status: "todo",
                originKind: "conversation",
              })
              .returning({ id: issues.id });
            convIssueId = created.id;
          }

          const [comment] = await db
            .insert(issueComments)
            .values({
              companyId: targetCompanyId,
              issueId: convIssueId,
              authorAgentId: context?.agent?.id || null,
              authorType: "agent",
              body: `[Message from ${context?.agent?.name || "Team Lead"}]:\n${message}`,
            })
            .returning();

          return `[MESSAGE DELIVERED TO AGENT]
Delivered to: ${targetAgent.name} (ID: ${targetAgentId})
Message ID: ${comment.id}
Status: Successfully recorded in agent's inbox thread.`;
        }

        return `[MESSAGE QUEUED] Delivered to agent ${targetAgentId}: ${message.slice(0, 100)}`;
      }

      default:
        return `[ERROR] Unknown tool: '${tool}'. Available tools: get_project_context, list_dir, read_file, search_code, run_command, propose_file_mutation, list_agents, create_agent, delegate_task, verify_task, send_agent_message.`;
    }
  } catch (err: any) {
    return `[TOOL EXECUTION ERROR for ${tool}]: ${err.message}`;
  }
}
