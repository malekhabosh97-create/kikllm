import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@paperclipai/db";
import { fileMutationPayloadSchema, type FileMutationPayload } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function findExistingAncestor(filePath: string): string {
  let curr = path.dirname(filePath);
  while (!fs.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return curr;
}

export async function resolveWorkspaceDirectory(
  db: Db,
  companyId: string,
  payload: FileMutationPayload,
): Promise<string> {
  if (payload.workspaceId) {
    const execWs = await db
      .select({ cwd: executionWorkspaces.cwd })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, payload.workspaceId))
      .then((rows) => rows[0]?.cwd);
    if (execWs && fs.existsSync(execWs)) return execWs;

    const projWs = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, payload.workspaceId))
      .then((rows) => rows[0]?.cwd);
    if (projWs && fs.existsSync(projWs)) return projWs;
  }

  if (payload.issueId) {
    const issue = await db
      .select({ projectWorkspaceId: issues.projectWorkspaceId, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, payload.issueId))
      .then((rows) => rows[0]);
    if (issue?.projectWorkspaceId) {
      const projWs = await db
        .select({ cwd: projectWorkspaces.cwd })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, issue.projectWorkspaceId))
        .then((rows) => rows[0]?.cwd);
      if (projWs && fs.existsSync(projWs)) return projWs;
    }
  }

  const envWs = process.env.PAPERCLIP_WORKSPACE_DIR;
  if (envWs && fs.existsSync(envWs)) return envWs;

  const current = process.cwd();
  if (path.basename(current) === "server" && fs.existsSync(path.resolve(current, "..", "package.json"))) {
    return path.resolve(current, "..");
  }

  return current;
}

export function validateSafePath(workspaceRoot: string, relativePath: string): string {
  const normRoot = path.resolve(workspaceRoot);
  const targetAbs = path.resolve(normRoot, relativePath);

  // Traversal check
  if (!targetAbs.startsWith(normRoot + path.sep) && targetAbs !== normRoot) {
    throw unprocessable(`Path traversal detected: '${relativePath}' escapes workspace root`);
  }

  // Symlink / Junction escape check
  if (fs.existsSync(targetAbs)) {
    const realTarget = fs.realpathSync(targetAbs);
    const realRoot = fs.realpathSync(normRoot);
    if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
      throw unprocessable(`Path traversal via symlink/junction detected for '${relativePath}'`);
    }
  } else {
    const ancestor = findExistingAncestor(targetAbs);
    if (fs.existsSync(ancestor)) {
      const realAncestor = fs.realpathSync(ancestor);
      const realRoot = fs.realpathSync(normRoot);
      if (!realAncestor.startsWith(realRoot + path.sep) && realAncestor !== realRoot) {
        throw unprocessable(`Path traversal via ancestor symlink/junction detected for '${relativePath}'`);
      }
    }
  }

  return targetAbs;
}

export async function applyFileMutationApproval(
  db: Db,
  companyId: string,
  rawPayload: unknown,
): Promise<{ success: boolean; appliedPath: string; operation: string }> {
  const payload = fileMutationPayloadSchema.parse(rawPayload);
  const workspaceRoot = await resolveWorkspaceDirectory(db, companyId, payload);
  const targetPath = validateSafePath(workspaceRoot, payload.relativePath);

  switch (payload.operation) {
    case "create": {
      if (fs.existsSync(targetPath)) {
        throw unprocessable(
          `File already exists for create operation: ${payload.relativePath}`,
        );
      }

      if (!fs.existsSync(payload.stagedPath)) {
        throw unprocessable(`Staged content file not found at: ${payload.stagedPath}`);
      }

      const stagedBuffer = fs.readFileSync(payload.stagedPath);
      const actualStagedSha = sha256(stagedBuffer);
      if (actualStagedSha !== payload.stagedSha256) {
        throw unprocessable(
          `Staged file hash mismatch: expected ${payload.stagedSha256}, got ${actualStagedSha}`,
        );
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, stagedBuffer);

      try {
        fs.rmSync(payload.stagedPath, { force: true });
      } catch {}

      return { success: true, appliedPath: targetPath, operation: "create" };
    }

    case "modify": {
      if (!fs.existsSync(targetPath)) {
        throw unprocessable(
          `Target file does not exist for modify operation: ${payload.relativePath}`,
        );
      }

      const currentContent = fs.readFileSync(targetPath);
      const currentSha = sha256(currentContent);

      if (payload.baseSha256 && currentSha !== payload.baseSha256) {
        throw unprocessable(
          `FILE_MODIFIED_CONFLICT: Target file has been modified externally since approval was requested (expected base: ${payload.baseSha256}, current: ${currentSha})`,
        );
      }

      if (!fs.existsSync(payload.stagedPath)) {
        throw unprocessable(`Staged content file not found at: ${payload.stagedPath}`);
      }

      const stagedBuffer = fs.readFileSync(payload.stagedPath);
      const actualStagedSha = sha256(stagedBuffer);
      if (actualStagedSha !== payload.stagedSha256) {
        throw unprocessable(
          `Staged file hash mismatch: expected ${payload.stagedSha256}, got ${actualStagedSha}`,
        );
      }

      fs.writeFileSync(targetPath, stagedBuffer);

      try {
        fs.rmSync(payload.stagedPath, { force: true });
      } catch {}

      return { success: true, appliedPath: targetPath, operation: "modify" };
    }

    case "delete": {
      if (!fs.existsSync(targetPath)) {
        throw unprocessable(
          `Target file does not exist for delete operation: ${payload.relativePath}`,
        );
      }

      const currentContent = fs.readFileSync(targetPath);
      const currentSha = sha256(currentContent);

      if (payload.baseSha256 && currentSha !== payload.baseSha256) {
        throw unprocessable(
          `FILE_MODIFIED_CONFLICT: Target file has been modified externally since approval was requested (expected base: ${payload.baseSha256}, current: ${currentSha})`,
        );
      }

      fs.rmSync(targetPath, { force: true });

      if (payload.stagedPath && fs.existsSync(payload.stagedPath)) {
        try {
          fs.rmSync(payload.stagedPath, { force: true });
        } catch {}
      }

      return { success: true, appliedPath: targetPath, operation: "delete" };
    }

    default:
      throw unprocessable(`Unsupported file mutation operation: ${(payload as any).operation}`);
  }
}

export function cleanupFileMutationApproval(rawPayload: unknown): void {
  try {
    const payload = fileMutationPayloadSchema.safeParse(rawPayload);
    if (payload.success && payload.data.stagedPath && fs.existsSync(payload.data.stagedPath)) {
      fs.rmSync(payload.data.stagedPath, { force: true });
    }
  } catch {}
}
