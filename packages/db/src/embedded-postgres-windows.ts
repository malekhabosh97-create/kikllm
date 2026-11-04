import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** Persistent clusters must use PostgreSQL's shutdown protocol on Windows.
 * Killing only the master can leave PG18 IO workers holding shared memory.
 * The owner, not this helper, remains responsible for data-directory cleanup.
 */
export function withGracefulWindowsPostgresStop<T extends { stop(): Promise<void> }>(instance: T, dataDir: string): T {
  if (process.platform !== "win32") return instance;
  const originalStop = instance.stop.bind(instance);
  const managed = instance as unknown as { process?: { pid?: number; spawnfile?: string; exitCode?: number | null; signalCode?: string | null } };
  instance.stop = async () => {
    const child = managed.process;
    if (!child) return originalStop();
    if (child.exitCode != null || child.signalCode != null) { managed.process = undefined; return; }
    if (!child.pid || !child.spawnfile || path.basename(child.spawnfile).toLowerCase() !== "postgres.exe") {
      throw new Error("Cannot verify the owned PostgreSQL process for shutdown");
    }
    const root = fs.realpathSync(dataDir);
    const lines = fs.readFileSync(path.join(root, "postmaster.pid"), "utf8").split(/\r?\n/);
    const sameRoot = path.resolve(lines[1] || "").toLowerCase() === root.toLowerCase();
    if (Number(lines[0]) !== child.pid || !sameRoot) throw new Error("Refusing to stop PostgreSQL: data directory does not identify the owned process");
    const executable = path.join(path.dirname(child.spawnfile), "pg_ctl.exe");
    if (!fs.existsSync(executable)) throw new Error("PostgreSQL shutdown utility is unavailable");
    await execFileAsync(executable, ["-D", root, "-m", "fast", "-w", "-t", "10", "stop"], {
      windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024, env: { ...process.env, LC_MESSAGES: "C" },
    });
    managed.process = undefined;
  };
  return instance;
}
