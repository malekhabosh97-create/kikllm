import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  stageFileMutation,
  applyFileMutation,
  calculateSha256,
  assertSafeWorkspacePath,
} from "../src/services/file-mutation.js";
import { executeTool } from "../src/adapters/freellm-browser/tool-executor.js";

async function runPhase3Tests() {
  console.log("=== STARTING PHASE 3 TOOL & MUTATION VERIFICATION SUITE ===");

  const workspaceRoot = path.resolve(process.cwd(), "..");
  console.log(`Workspace root: ${workspaceRoot}`);

  // --- TEST 1: Tool execution (read_file, list_dir, search_code, run_command) ---
  console.log("\n[TEST 1] Testing Local Read-Only Tools...");

  // 1.1 list_dir
  const listRes = await executeTool(
    { callId: "c1", tool: "list_dir", arguments: { path: "server" } },
    workspaceRoot,
    {} as any
  );
  const listPassed = listRes.includes("[DIR]") && listRes.includes("src");
  console.log(` - list_dir test: ${listPassed ? "PASS" : "FAIL"}`);

  // 1.2 read_file
  const readRes = await executeTool(
    { callId: "c2", tool: "read_file", arguments: { path: "server/package.json" } },
    workspaceRoot,
    {} as any
  );
  const readPassed = readRes.includes("@paperclipai/server") && readRes.includes("1:");
  console.log(` - read_file test: ${readPassed ? "PASS" : "FAIL"}`);

  // 1.3 search_code
  const searchRes = await executeTool(
    { callId: "c3", tool: "search_code", arguments: { query: "FreeLLMBrowserDaemon", path: "server/src" } },
    workspaceRoot,
    {} as any
  );
  const searchPassed = searchRes.includes("daemon.ts");
  console.log(` - search_code test: ${searchPassed ? "PASS" : "FAIL"}`);

  // 1.4 run_command
  const cmdRes = await executeTool(
    { callId: "c4", tool: "run_command", arguments: { command: "node -v" } },
    workspaceRoot,
    {} as any
  );
  const cmdPassed = cmdRes.includes("v24.") || cmdRes.includes("v2");
  console.log(` - run_command test: ${cmdPassed ? "PASS" : "FAIL"}`);

  // 1.5 Path traversal security guard
  let traversalBlocked = false;
  try {
    assertSafeWorkspacePath(workspaceRoot, "../../outside-file.txt");
  } catch (err: any) {
    traversalBlocked = err.message.includes("Security Violation");
  }
  console.log(` - path traversal security guard: ${traversalBlocked ? "PASS (Blocked)" : "FAIL"}`);

  // --- TEST 2: File Mutation Lifecycle (Create -> Modify -> Drift Conflict -> Delete) ---
  console.log("\n[TEST 2] Testing File Mutation Staging & Atomic SHA-256 Validation...");
  const testRelPath = ".paperclip/temp-phase3-test.txt";
  const absTestPath = path.resolve(workspaceRoot, testRelPath);

  // Clean up if existed
  if (fs.existsSync(absTestPath)) fs.unlinkSync(absTestPath);

  // 2.1 Stage Create
  const contentV1 = "Version 1: Initial creation by agent";
  const stageCreate = stageFileMutation(workspaceRoot, {
    relativePath: testRelPath,
    operation: "create",
    content: contentV1,
  });
  console.log(` - Stage Create: baseSha256=${stageCreate.baseSha256}, stagedSha256=${stageCreate.stagedSha256.slice(0, 10)}...`);

  // Apply Create
  applyFileMutation(workspaceRoot, stageCreate);
  const fileCreated = fs.existsSync(absTestPath) && fs.readFileSync(absTestPath, "utf8") === contentV1;
  console.log(` - Apply Create: ${fileCreated ? "PASS (Created on disk)" : "FAIL"}`);

  // 2.2 Stage Modify
  const contentV2 = "Version 2: Modified with new features";
  const stageModify = stageFileMutation(workspaceRoot, {
    relativePath: testRelPath,
    operation: "modify",
    content: contentV2,
  });
  console.log(` - Stage Modify: baseSha256 matches current file? ${stageModify.baseSha256 === calculateSha256(contentV1) ? "YES (PASS)" : "NO"}`);

  // 2.3 Drift Conflict Protection (Simulate concurrent edit by human/external process)
  fs.writeFileSync(absTestPath, "Version Concurrent: human edited file externally");
  let conflictCaught = false;
  try {
    applyFileMutation(workspaceRoot, stageModify);
  } catch (e: any) {
    conflictCaught = e.message.includes("Concurrent modification conflict");
  }
  console.log(` - Concurrent drift detection: ${conflictCaught ? "PASS (Refused to overwrite stale file)" : "FAIL"}`);

  // Restore for legitimate apply
  fs.writeFileSync(absTestPath, contentV1);
  applyFileMutation(workspaceRoot, stageModify);
  const fileUpdated = fs.readFileSync(absTestPath, "utf8") === contentV2;
  console.log(` - Apply Modify after hash match: ${fileUpdated ? "PASS (Updated to V2)" : "FAIL"}`);

  // 2.4 Delete
  const stageDelete = stageFileMutation(workspaceRoot, {
    relativePath: testRelPath,
    operation: "delete",
  });
  applyFileMutation(workspaceRoot, stageDelete);
  const fileDeleted = !fs.existsSync(absTestPath);
  console.log(` - Apply Delete: ${fileDeleted ? "PASS (File deleted cleanly)" : "FAIL"}`);

  // --- TEST 3: Paperclip Approvals API Integration ---
  console.log("\n[TEST 3] Testing Paperclip Approvals API Integration for file_mutation...");
  const companyId = "a2a205d9-2868-41f1-b5cc-8d31ffab793e";

  const stagedApproval = stageFileMutation(workspaceRoot, {
    relativePath: ".paperclip/approval-test.txt",
    operation: "create",
    content: "Approved by Paperclip Board",
  });

  const createApprovalRes = await fetch(`http://127.0.0.1:3100/api/companies/${companyId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "file_mutation",
      payload: stagedApproval,
    }),
  }).then((r) => r.json());

  console.log(` - Created approval record: ID=${createApprovalRes.id}, Status=${createApprovalRes.status}, Type=${createApprovalRes.type}`);
  const approvalCreatedPass = Boolean(createApprovalRes.id && createApprovalRes.type === "file_mutation");

  console.log(` - Resolving approval ID=${createApprovalRes.id} (approve)...`);
  const resolveRes = await fetch(`http://127.0.0.1:3100/api/approvals/${createApprovalRes.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisionNote: "Approved for testing" }),
  }).then((r) => r.json());

  console.log(` - Approval resolution result: Status=${resolveRes.status}`);

  const approvalAppliedFile = path.resolve(workspaceRoot, ".paperclip/approval-test.txt");
  const approvalAppliedPass = fs.existsSync(approvalAppliedFile) && fs.readFileSync(approvalAppliedFile, "utf8") === "Approved by Paperclip Board";
  console.log(` - Target file materialized upon approval: ${approvalAppliedPass ? "PASS" : "FAIL"}`);

  // Cleanup test file
  if (fs.existsSync(approvalAppliedFile)) fs.unlinkSync(approvalAppliedFile);

  console.log("\n=== ALL PHASE 3 VERIFICATION TESTS COMPLETE ===");
  const allPassed = listPassed && readPassed && searchPassed && cmdPassed && traversalBlocked && fileCreated && conflictCaught && fileUpdated && fileDeleted && approvalCreatedPass && approvalAppliedPass;
  console.log(`OVERALL PHASE 3 RESULT: ${allPassed ? "100% PASS" : "FAIL"}`);
}

runPhase3Tests().catch((err) => {
  console.error("Phase 3 tests failed:", err);
  process.exit(1);
});
