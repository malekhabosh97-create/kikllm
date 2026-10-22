import fs from "node:fs";
import path from "node:path";
import { FreeLLMBrowserDaemon } from "./daemon.js";

async function main() {
  const port = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
  const profileDir = "C:\\Users\\malek\\.freellm-browser-profile";
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`[FreeLLM] Initializing browser daemon with profile at: ${profileDir}`);
  const daemon = new FreeLLMBrowserDaemon({ port, profileDir });
  
  const listeningPort = await daemon.start();
  const tokenFile = path.resolve(profileDir, "token.txt");
  fs.writeFileSync(tokenFile, daemon.token, "utf8");

  // Also write to server/.browser-profile for backwards compatibility
  const serverProfile = path.resolve(process.cwd(), ".browser-profile");
  fs.mkdirSync(serverProfile, { recursive: true });
  fs.writeFileSync(path.resolve(serverProfile, "token.txt"), daemon.token, "utf8");

  console.log(`[FreeLLM] Daemon successfully running on http://127.0.0.1:${listeningPort}`);
  console.log(`[FreeLLM] Auth token written to: ${tokenFile}`);
  console.log(`[FreeLLM] Auth token value: ${daemon.token}`);
}

main().catch((err) => {
  console.error("[FreeLLM] Failed to start browser daemon:", err);
  process.exit(1);
});
