import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";

function getDaemonToken(): string {
  if (process.env.FREELLM_DAEMON_TOKEN) return process.env.FREELLM_DAEMON_TOKEN;
  const tokenPaths = [
    path.resolve(process.cwd(), "server/.browser-profile/token.txt"),
    path.resolve(process.cwd(), ".browser-profile/token.txt"),
  ];
  for (const p of tokenPaths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return "";
}

function checkDaemonHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkDeepSeekStatus(port: number, token: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/status`,
      { headers: { "x-freellm-auth": token }, timeout: 2000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.deepseek || "UNKNOWN");
          } catch {
            resolve("UNKNOWN");
          }
        });
      },
    );
    req.on("error", () => resolve("UNREACHABLE"));
    req.on("timeout", () => {
      req.destroy();
      resolve("UNREACHABLE");
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
  const daemonToken = getDaemonToken();

  const isHealthy = await checkDaemonHealth(daemonPort);
  if (!isHealthy) {
    checks.push({
      code: "freellm_daemon_unreachable",
      level: "error",
      message: `FreeLLM Browser Daemon is not reachable on port ${daemonPort}.`,
      hint: "Run the FreeLLM browser daemon via `pnpm dev:browser` or check your process manager.",
    });
  } else {
    checks.push({
      code: "freellm_daemon_healthy",
      level: "info",
      message: `FreeLLM Browser Daemon is online and listening on port ${daemonPort}.`,
    });

    const dsStatus = await checkDeepSeekStatus(daemonPort, daemonToken);
    if (dsStatus === "READY") {
      checks.push({
        code: "deepseek_ready",
        level: "info",
        message: "DeepSeek web session is active and ready to process requests.",
      });
    } else if (dsStatus === "NEEDS_LOGIN") {
      checks.push({
        code: "deepseek_needs_login",
        level: "warn",
        message: "DeepSeek requires authentication.",
        hint: "Open 'المتصفح' (Browser) in the sidebar to log in to your account.",
      });
    } else if (dsStatus === "NEEDS_HUMAN_INTERVENTION") {
      checks.push({
        code: "deepseek_captcha",
        level: "warn",
        message: "A Cloudflare / Captcha verification challenge was detected.",
        hint: "Open 'المتصفح' in the sidebar to solve the verification challenge.",
      });
    }
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: ctx.adapterType,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
