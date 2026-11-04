import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FileMutationPayload } from "@paperclipai/shared";

export function calculateSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function assertSafeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(normalizedRoot, relativePath);

  // Guard against path traversal attacks (.. or root escape)
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(`Security Violation: Path '${relativePath}' escapes the workspace boundary '${workspaceRoot}'.`);
  }

  const realRoot=fs.realpathSync(normalizedRoot);
  let ancestor=resolved;
  while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error("Invalid path");ancestor=parent;}
  const realAncestor=fs.realpathSync(ancestor);
  const rel=path.relative(realRoot,realAncestor);
  if(rel.startsWith(".."+path.sep)||rel===".."||path.isAbsolute(rel))throw new Error("Security Violation: Path resolves outside workspace.");

  return resolved;
}

export function stageFileMutation(
  workspaceRoot: string,
  input: {
    relativePath: string;
    operation: "create" | "modify" | "delete";
    content?: string;
  },
): FileMutationPayload {
  const targetPath = assertSafeWorkspacePath(workspaceRoot, input.relativePath);
  const exists = fs.existsSync(targetPath);

  let baseSha256: string | null = null;
  if (input.operation !== "delete" && input.content === undefined) throw new Error("File content is required");
  const content = input.content ?? "";

  if (input.operation === "modify") {
    if (!exists) {
      throw new Error(`Cannot modify file '${input.relativePath}': File does not exist.`);
    }
    const currentBuf = fs.readFileSync(targetPath);
    baseSha256 = calculateSha256(currentBuf);
  } else if (input.operation === "create") {
    if (exists) {
      throw new Error(`Cannot create file '${input.relativePath}': File already exists. Use 'modify' instead.`);
    }
    baseSha256 = null;
  } else if (input.operation === "delete") {
    if (!exists) {
      throw new Error(`Cannot delete file '${input.relativePath}': File does not exist.`);
    }
    const currentBuf = fs.readFileSync(targetPath);
    baseSha256 = calculateSha256(currentBuf);
  }

  const callId = "mut_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const stagedDir = assertSafeWorkspacePath(workspaceRoot, ".paperclip/staged-mutations");
  fs.mkdirSync(stagedDir, { recursive: true });

  const stagedPath = path.resolve(stagedDir, `${callId}.staged`);
  fs.writeFileSync(stagedPath, content, "utf8");
  const stagedSha256 = calculateSha256(content);

  const original = exists ? fs.readFileSync(targetPath,"utf8") : "";
  const diff = createTwoFilesPatch(input.operation === "create" ? "/dev/null" : "a/"+input.relativePath, input.operation === "delete" ? "/dev/null" : "b/"+input.relativePath, original, input.operation === "delete" ? "" : content);

  return {
    callId,
    relativePath: input.relativePath,
    operation: input.operation,
    baseSha256,
    stagedSha256,
    stagedPath,
    diff,
  };
}

export function applyFileMutation(
  workspaceRoot: string,
  payload: FileMutationPayload,
): { success: true; targetPath: string; operation: string } {
  const targetPath = assertSafeWorkspacePath(workspaceRoot, payload.relativePath);

  const stagingRoot=path.join(path.resolve(workspaceRoot),".paperclip","staged-mutations");
  assertSafeWorkspacePath(workspaceRoot,path.relative(workspaceRoot,payload.stagedPath));
  const stagedRelative=path.relative(stagingRoot,path.resolve(payload.stagedPath));
  if(stagedRelative.startsWith("..")||path.isAbsolute(stagedRelative))throw new Error("Staged file is not owned by this workspace");
  if (!fs.existsSync(payload.stagedPath)) {
    throw new Error(`Staged mutation file '${payload.stagedPath}' not found.`);
  }

  const stagedContent = fs.readFileSync(payload.stagedPath);
  const actualStagedSha = calculateSha256(stagedContent);
  if (actualStagedSha !== payload.stagedSha256) {
    throw new Error(
      `Staged content integrity check failed. Expected SHA ${payload.stagedSha256}, but got ${actualStagedSha}.`,
    );
  }

  if(payload.operation !== "create" && !payload.baseSha256)throw new Error("An existing-file mutation requires its base SHA-256");
  const historyDir=assertSafeWorkspacePath(workspaceRoot,".paperclip/file-history");
  const backup=()=>{fs.mkdirSync(historyDir,{recursive:true});const name=crypto.randomUUID();fs.copyFileSync(targetPath,path.join(historyDir,name+".original"));fs.writeFileSync(path.join(historyDir,name+".json"),JSON.stringify({relativePath:payload.relativePath,sha256:payload.baseSha256,operation:payload.operation,createdAt:new Date().toISOString()}));};
  if (payload.operation === "modify") {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Target file '${payload.relativePath}' no longer exists.`);
    }
    const currentSha = calculateSha256(fs.readFileSync(targetPath));
    if (payload.baseSha256 && currentSha !== payload.baseSha256) {
      throw new Error(
        `Concurrent modification conflict: File '${payload.relativePath}' has changed since the mutation was proposed. Expected SHA: ${payload.baseSha256}, current SHA: ${currentSha}. Re-review required.`,
      );
    }

    backup();
    // Atomic replacement via temporary sibling file
    const tmpFile = `${targetPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpFile, stagedContent);
    try {
      fs.renameSync(tmpFile, targetPath);
    } catch {
      // Fallback on Windows if target is momentarily locked
      fs.copyFileSync(tmpFile, targetPath);
      fs.unlinkSync(tmpFile);
    }
  } else if (payload.operation === "create") {
    if (fs.existsSync(targetPath)) {
      throw new Error(`Target file '${payload.relativePath}' already exists.`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(payload.stagedPath, targetPath, fs.constants.COPYFILE_EXCL);
  } else if (payload.operation === "delete") {
    if (fs.existsSync(targetPath)) {
      const currentSha = calculateSha256(fs.readFileSync(targetPath));
      if (payload.baseSha256 && currentSha !== payload.baseSha256) {
        throw new Error(
          `Concurrent modification conflict on delete: File '${payload.relativePath}' has changed. Expected SHA: ${payload.baseSha256}, current: ${currentSha}.`,
        );
      }
      backup();
      fs.unlinkSync(targetPath);
    }
  }

  // Clean up staged file
  try {
    fs.unlinkSync(payload.stagedPath);
  } catch {}

  return {
    success: true,
    targetPath,
    operation: payload.operation,
  };
}
