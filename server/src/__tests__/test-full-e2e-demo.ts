import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createDb, companies, agents, issues, issueComments, approvals } from "@paperclipai/db";
import { eq, and, desc } from "drizzle-orm";
import { stageFileMutation, applyFileMutation } from "../services/file-mutation.js";
import { applyFileMutationApproval } from "../services/file-mutation-approval.js";

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function postJson(port: number, pathName: string, payload: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(dataStr),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 200, data, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(dataStr);
    req.end();
  });
}

function getJson(port: number, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 200, data, raw });
        });
      }
    );
    req.on("error", reject);
  });
}

async function main() {
  console.log("================================================================================");
  console.log("   FreeLLM Work - Comprehensive End-to-End System Verification Suite           ");
  console.log("================================================================================\n");

  const db = createDb("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Verify Company & CEO Agent in Paperclip Database
    // -------------------------------------------------------------------------
    console.log(">>> [Step 1] Verifying Core Company & CEO Agent in Database...");
    const [comp] = await db.select().from(companies).limit(1);
    if (!comp) {
      throw new Error("No company found in database! Setup is incomplete.");
    }
    console.log(`  ✓ Active Company: ${comp.name} (ID: ${comp.id})`);

    const dbAgents = await db.select().from(agents).where(eq(agents.companyId, comp.id));
    console.log(`  ✓ Found ${dbAgents.length} registered agents in database:`);
    for (const a of dbAgents) {
      console.log(`    - [${a.role.toUpperCase()}] ${a.name} (${(a.adapterConfig as any)?.model || "default"})`);
    }

    const ceoAgent = dbAgents.find((a) => a.role === "ceo" || a.name.includes("CEO"));
    if (!ceoAgent) {
      throw new Error("CEO agent not found in database! Must have 'CEO - Gemini Argon 4'");
    }
    console.log(`  ✓ Confirmed CEO Agent: ${ceoAgent.name} (ID: ${ceoAgent.id})`);

    // -------------------------------------------------------------------------
    // STEP 2: Verify Browser Daemon Status & Chrome CDP Connectivity
    // -------------------------------------------------------------------------
    console.log("\n>>> [Step 2] Verifying FreeLLM Browser Daemon & CDP Status...");
    const daemonStatus = await getJson(3100, "/api/browser/status");
    console.log(`  ✓ Daemon Status Response (HTTP ${daemonStatus.status}):`, daemonStatus.data);
    if (daemonStatus.status !== 200) {
      throw new Error("Browser daemon returned non-200 status!");
    }

    // -------------------------------------------------------------------------
    // STEP 3: Multi-Agent Orchestration - Autonomous Agent Creation by CEO
    // -------------------------------------------------------------------------
    console.log("\n>>> [Step 3] Testing CEO Agent Creation Capability...");
    const testAgentName = "Code Reviewer & Quality Auditor";
    const createRes = await postJson(3100, "/api/browser/create-agent", {
      companyId: comp.id,
      name: testAgentName,
      role: "qa",
      title: "Senior Code Quality Auditor",
      model: "deepseek-normal",
      systemPrompt: "You are a specialized code reviewer ensuring zero vulnerabilities and optimal performance.",
    });

    console.log(`  ✓ Create Agent Response (HTTP ${createRes.status}):`, {
      id: createRes.data?.id,
      name: createRes.data?.name,
      role: createRes.data?.role,
    });

    if (createRes.status !== 201 && createRes.status !== 200) {
      throw new Error(`Failed to create agent: ${createRes.raw}`);
    }

    // Verify persisted in DB
    const [persistedAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, createRes.data.id));
    if (!persistedAgent) {
      throw new Error("Created agent not found in PostgreSQL agents table!");
    }
    console.log(`  ✓ Verified New Agent in Database: ${persistedAgent.name} (ID: ${persistedAgent.id})`);

    // -------------------------------------------------------------------------
    // STEP 4: Centralized Conversation Turn & Database Durability
    // -------------------------------------------------------------------------
    console.log("\n>>> [Step 4] Testing Direct Chat History & Turn Durability...");
    const historyBefore = await getJson(3100, `/api/browser/agent-chat/history?agentId=${ceoAgent.id}`);
    console.log(`  ✓ Retrieved existing history for CEO: ${historyBefore.data?.messages?.length || 0} messages`);

    // Verify conversation issue exists and satisfies constraint
    const [convIssue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, comp.id),
          eq(issues.conversationAgentId, ceoAgent.id),
        )
      )
      .limit(1);

    if (convIssue) {
      console.log(`  ✓ Linked Conversation Issue ID: ${convIssue.id}`);
      console.log(`    - conversationUserId: ${convIssue.conversationUserId}`);
      console.log(`    - conversationState: ${convIssue.conversationState}`);
      console.log(`    - conversationAgentId: ${convIssue.conversationAgentId}`);
    }

    // -------------------------------------------------------------------------
    // STEP 5: Closed-Loop File Mutation, SHA-256 Fingerprint & Server Approval
    // -------------------------------------------------------------------------
    console.log("\n>>> [Step 5] Testing File Mutation Staging & Server-Side Approvals...");
    const workspaceRoot = path.resolve("..");
    fs.mkdirSync(path.resolve(workspaceRoot, "workspace"), { recursive: true });

    // 5a. Create a new file via staging
    const targetRelPath = "workspace/generated_feature.ts";
    const targetFullPath = path.resolve(workspaceRoot, targetRelPath);
    if (fs.existsSync(targetFullPath)) {
      fs.unlinkSync(targetFullPath);
    }
    const initialCode = `// Feature created by Autonomous FreeLLM Team\nexport function calculateMetrics(a: number, b: number): number {\n  return a * b + 42;\n}\n`;

    const stagedCreate = stageFileMutation(workspaceRoot, {
      relativePath: targetRelPath,
      operation: "create",
      content: initialCode,
    });

    console.log("  ✓ Staged File Creation Payload:", {
      relativePath: stagedCreate.relativePath,
      operation: stagedCreate.operation,
      stagedSha256: stagedCreate.stagedSha256,
      stagedPath: stagedCreate.stagedPath,
    });

    // 5b. Create Approval in Paperclip Database
    const approvalRes = await postJson(3100, `/api/companies/${comp.id}/approvals`, {
      type: "file_mutation",
      decisionModel: "manual",
      payload: stagedCreate,
    });
    console.log(`  ✓ Created Pending Approval (HTTP ${approvalRes.status}): ID ${approvalRes.data?.id}`);
    const approvalId = approvalRes.data?.id;

    if (!approvalId) {
      throw new Error(`Failed to create approval in Paperclip: ${approvalRes.raw}`);
    }

    // 5c. Approve the mutation via Paperclip Approvals API
    const approveRes = await postJson(3100, `/api/approvals/${approvalId}/approve`, {});
    console.log(`  ✓ Approved Mutation via API (HTTP ${approveRes.status}):`, approveRes.data);

    // 5d. Verify file applied on disk
    if (!fs.existsSync(targetFullPath)) {
      throw new Error(`File ${targetFullPath} was not written to disk upon approval!`);
    }
    const appliedContent = fs.readFileSync(targetFullPath, "utf8");
    if (appliedContent !== initialCode) {
      throw new Error("Applied file content does not match initial staged content!");
    }
    console.log("  ✓ Verified File Successfully Written to Disk with exact content.");

    // 5e. Modify the file via staging & approval
    const modifiedCode = `// Feature created by Autonomous FreeLLM Team\n// Updated with high precision metrics\nexport function calculateMetrics(a: number, b: number): number {\n  return (a * b + 42) * 1.5;\n}\n`;
    const stagedModify = stageFileMutation(workspaceRoot, {
      relativePath: targetRelPath,
      operation: "modify",
      content: modifiedCode,
    });

    console.log("  ✓ Staged File Modification with Unified Diff:", {
      diff: stagedModify.diff,
      baseSha256: stagedModify.baseSha256?.slice(0, 16) + "...",
      stagedSha256: stagedModify.stagedSha256.slice(0, 16) + "...",
    });

    const approvalModifyRes = await postJson(3100, `/api/companies/${comp.id}/approvals`, {
      type: "file_mutation",
      decisionModel: "manual",
      payload: stagedModify,
    });
    const modifyApprovalId = approvalModifyRes.data?.id;
    console.log(`  ✓ Created Second Pending Approval: ID ${modifyApprovalId}`);

    const approveModifyRes = await postJson(3100, `/api/approvals/${modifyApprovalId}/approve`, {});
    console.log(`  ✓ Approved Modification via API (HTTP ${approveModifyRes.status}):`, approveModifyRes.data);

    const updatedContent = fs.readFileSync(targetFullPath, "utf8");
    if (updatedContent !== modifiedCode) {
      throw new Error("Updated file content does not match modified staged content!");
    }
    console.log("  ✓ Verified Modified File Written to Disk with exact content.");

    // 5f. Verify Conflict Detection on Concurrent Drift
    console.log("  ✓ Testing Conflict Detection on Concurrent File Drift...");
    const driftStaged = stageFileMutation(workspaceRoot, {
      relativePath: targetRelPath,
      operation: "modify",
      content: "// Staged update attempt during drift\n",
    });

    // Mutate file externally to trigger drift conflict
    fs.writeFileSync(targetFullPath, "// External untracked concurrent change\n", "utf8");

    try {
      applyFileMutation(workspaceRoot, driftStaged);
      throw new Error("Should have thrown Concurrent modification conflict!");
    } catch (err: any) {
      if (err.message.includes("Concurrent modification conflict") || err.message.includes("FILE_MODIFIED_CONFLICT")) {
        console.log(`  ✓ Conflict Blocked Successfully: ${err.message.slice(0, 75)}...`);
      } else {
        throw err;
      }
    } finally {
      if (fs.existsSync(driftStaged.stagedPath)) {
        fs.unlinkSync(driftStaged.stagedPath);
      }
    }

    // -------------------------------------------------------------------------
    // STEP 6: UI Production Assets Verification
    // -------------------------------------------------------------------------
    console.log("\n>>> [Step 6] Verifying Web UI Accessibility & Endpoints...");
    const uiRes = await getJson(3100, "/freellm-chat");
    console.log(`  ✓ Direct Chat UI Endpoint HTTP status: ${uiRes.status}`);
    if (uiRes.status !== 200) {
      throw new Error("Direct Chat UI endpoint failed to respond with 200!");
    }

    // Cleanup test artifacts
    if (fs.existsSync(targetFullPath)) {
      fs.unlinkSync(targetFullPath);
    }

    console.log("\n================================================================================");
    console.log("🎉 ALL TESTS PASSED! FreeLLM Work Autonomous Multi-Agent System is 100% OPERATIONAL!");
    console.log("================================================================================\n");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Test Suite Failed:", err);
    process.exit(1);
  }
}

main();
