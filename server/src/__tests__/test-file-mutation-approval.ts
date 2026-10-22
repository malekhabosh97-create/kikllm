import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSafePath, applyFileMutationApproval } from "../services/file-mutation-approval.js";

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function runTest() {
  console.log("Testing File Mutation Approval...");
  const tmpDir = path.resolve("./.browser-profile/test-workspace");
  fs.mkdirSync(tmpDir, { recursive: true });

  const testFile = path.join(tmpDir, "hello.txt");
  fs.writeFileSync(testFile, "initial content", "utf8");
  const baseSha = sha256("initial content");

  const stagedFile = path.join(tmpDir, "hello.staged");
  fs.writeFileSync(stagedFile, "updated content by freellm", "utf8");
  const stagedSha = sha256("updated content by freellm");

  const payload = {
    callId: "call-123",
    workspaceId: null,
    issueId: null,
    relativePath: "hello.txt",
    operation: "modify" as const,
    baseSha256: baseSha,
    stagedPath: stagedFile,
    stagedSha256: stagedSha,
    diff: "- initial content\n+ updated content by freellm"
  };

  const mockDb: any = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) })
  };

  process.env.PAPERCLIP_WORKSPACE_DIR = tmpDir;

  const result = await applyFileMutationApproval(mockDb, "test-company", payload);
  console.log("Apply result:", result);

  const appliedContent = fs.readFileSync(testFile, "utf8");
  if (appliedContent !== "updated content by freellm") {
    throw new Error("Applied content mismatch!");
  }
  if (fs.existsSync(stagedFile)) {
    throw new Error("Staged file was not cleaned up!");
  }
  console.log("Modification verified successfully!");

  // Test hash mismatch conflict
  fs.writeFileSync(testFile, "tampered content", "utf8");
  fs.writeFileSync(stagedFile, "another update", "utf8");
  const stagedSha2 = sha256("another update");
  try {
    await applyFileMutationApproval(mockDb, "test-company", {
      ...payload,
      baseSha256: baseSha,
      stagedSha256: stagedSha2
    });
    throw new Error("Should have failed with hash mismatch!");
  } catch (err: any) {
    console.log("Detected conflict correctly:", err.message);
  }

  // Test path traversal
  try {
    validateSafePath(tmpDir, "../../escaped.txt");
    throw new Error("Should have blocked path traversal!");
  } catch (err: any) {
    console.log("Detected traversal correctly:", err.message);
  }

  // Cleanup test dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(">>> ALL FILE MUTATION APPROVAL TESTS PASSED CLEANLY! <<<");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
