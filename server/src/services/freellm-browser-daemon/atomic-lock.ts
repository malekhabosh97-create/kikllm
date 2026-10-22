import fs from "node:fs";
import path from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: string;
  port: number;
  token: string;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we lack permission to signal it
    return e.code === "EPERM";
  }
}

export function acquireAtomicLock(lockFilePath: string, port: number, token: string): LockInfo {
  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Check if existing lock is stale
  if (fs.existsSync(lockFilePath)) {
    try {
      const raw = fs.readFileSync(lockFilePath, "utf8");
      const existing: LockInfo = JSON.parse(raw);
      if (isPidAlive(existing.pid)) {
        throw new Error(
          `Browser profile is currently locked by active PID ${existing.pid} (started at ${existing.startedAt}). Cannot launch two processes on the same profile.`,
        );
      }
      // Stale lock from dead process: safely remove
      fs.unlinkSync(lockFilePath);
    } catch (err: any) {
      if (err.message.includes("Cannot launch two processes")) {
        throw err;
      }
      // If file was corrupted or unreadable, remove it
      try {
        fs.unlinkSync(lockFilePath);
      } catch {}
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port,
    token,
  };

  // 'wx' flag ensures atomic file creation; fails if file already exists (race protection)
  const fd = fs.openSync(lockFilePath, "wx");
  fs.writeFileSync(fd, JSON.stringify(info, null, 2), "utf8");
  fs.closeSync(fd);

  return info;
}

export function releaseAtomicLock(lockFilePath: string): void {
  try {
    if (fs.existsSync(lockFilePath)) {
      const raw = fs.readFileSync(lockFilePath, "utf8");
      const info: LockInfo = JSON.parse(raw);
      if (info.pid === process.pid) {
        fs.unlinkSync(lockFilePath);
      }
    }
  } catch {}
}
