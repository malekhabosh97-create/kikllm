import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const node = process.execPath;
const logFile = path.join(ROOT, "server.log");
const outFd = fs.openSync(logFile, "a");

console.log(`Starting server from ${ROOT}...`);

const server = spawn(node, [path.join(ROOT, "cli/node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "server/src/index.ts")], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", outFd, outFd],
  env: {
    ...process.env,
    PORT: "3100",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_MIGRATION_PROMPT: "never"
  }
});

server.unref();
console.log(`Server launched with PID: ${server.pid}`);
process.exit(0);
