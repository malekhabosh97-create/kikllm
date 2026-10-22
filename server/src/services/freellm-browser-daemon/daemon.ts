import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";
import { acquireAtomicLock, releaseAtomicLock } from "./atomic-lock.js";
import { WindowManager } from "./window-manager.js";
import { DeepSeekHandler } from "./page-handlers/deepseek.js";
import { GeminiHandler } from "./page-handlers/gemini.js";

export interface DaemonConfig {
  port?: number;
  profileDir?: string;
  lockFile?: string;
}

export interface BrowserSession {
  sessionId: string;
  platform: "gemini" | "deepseek";
  model: string;
  page: Page;
  conversationUrl: string;
  isInitialized: boolean;
  lastActiveAt: number;
  handler: GeminiHandler | DeepSeekHandler;
}

export class FreeLLMBrowserDaemon {
  private context: BrowserContext | null = null;
  private defaultPages = new Map<string, Page>();
  private sessions = new Map<string, BrowserSession>();
  private sessionLocks = new Map<string, Promise<void>>();
  private windowManager: WindowManager | null = null;
  private authToken: string;
  private server: http.Server | null = null;
  private profileDir: string;

  constructor(private config: DaemonConfig = {}) {
    this.authToken = crypto.randomBytes(24).toString("hex");
    this.profileDir =
      this.config.profileDir ?? "C:\\Users\\malek\\.freellm-browser-profile";
    fs.mkdirSync(this.profileDir, { recursive: true });
  }

  get token(): string {
    return this.authToken;
  }

  /**
   * Ensure browser connection: connects to real Chrome/Edge on CDP port 9222.
   */
  private async ensureBrowser(): Promise<boolean> {
    try {
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 3000 });
      const contexts = browser.contexts();
      this.context = contexts[0] ?? (await browser.newContext());

      const allPages = this.context.pages();

      // Ensure base DeepSeek page for health/status inspection
      let dsPage = allPages.find((p) => p.url().includes("deepseek.com"));
      if (!dsPage) {
        dsPage = await this.context.newPage();
        await dsPage.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      this.defaultPages.set("deepseek", dsPage);
      if (!this.windowManager) {
        this.windowManager = new WindowManager(dsPage);
      }

      // Ensure base Gemini page for health/status inspection
      let geminiPage = allPages.find((p) => p.url().includes("gemini.google.com"));
      if (!geminiPage) {
        geminiPage = await this.context.newPage();
        await geminiPage.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      this.defaultPages.set("gemini", geminiPage);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get or allocate a dedicated browser session for a specific agent or task.
   */
  private async getOrCreateSession(
    sessionId: string,
    platform: "gemini" | "deepseek",
    model: string,
  ): Promise<BrowserSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    if (!this.context) {
      throw new Error("المتصفح غير متصل. يرجى التأكد من تشغيل المتصفح من سطح المكتب.");
    }

    // Allocate a dedicated tab for this session
    const page = await this.context.newPage();
    const startUrl = platform === "gemini" ? "https://gemini.google.com/app" : "https://chat.deepseek.com";

    const targetUrl = existing?.conversationUrl || startUrl;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

    const handler = platform === "gemini" ? new GeminiHandler(page) : new DeepSeekHandler(page);

    const session: BrowserSession = {
      sessionId,
      platform,
      model,
      page,
      conversationUrl: targetUrl,
      isInitialized: existing ? existing.isInitialized : false,
      lastActiveAt: Date.now(),
      handler,
    };

    // Clean up from map if user manually closes tab
    page.on("close", () => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  async start(): Promise<number> {
    const port = this.config.port ?? 3150;
    const lockFile =
      this.config.lockFile ?? path.resolve(this.profileDir, "browser.lock");

    acquireAtomicLock(lockFile, port, this.authToken);

    process.on("exit", () => releaseAtomicLock(lockFile));
    process.on("SIGINT", () => {
      releaseAtomicLock(lockFile);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      releaseAtomicLock(lockFile);
      process.exit(0);
    });

    await this.ensureBrowser().catch(() => {});

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, "127.0.0.1", () => {
        console.log(`FreeLLM Browser Daemon listening on 127.0.0.1:${port}`);
        resolve(port);
      });
      this.server.on("error", reject);
    });
  }

  private authenticate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const authHeader = req.headers["authorization"];
    const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    const auth = req.headers["x-freellm-auth"] || bearer;
    if (auth !== this.authToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }
    return true;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (!this.authenticate(req, res)) return;

    if (req.url === "/status" && req.method === "GET") {
      const isOnline = await this.ensureBrowser();
      if (!isOnline) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            deepseek: "DISCONNECTED",
            gemini: "DISCONNECTED",
            activeSessions: 0,
            isGenerating: false,
          }),
        );
        return;
      }

      const dsPage = this.defaultPages.get("deepseek");
      const geminiPage = this.defaultPages.get("gemini");

      const dsStatus = dsPage ? await new DeepSeekHandler(dsPage).checkStatus() : "DISCONNECTED";
      const geminiStatus = geminiPage ? await new GeminiHandler(geminiPage).checkStatus() : "DISCONNECTED";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          deepseek: dsStatus,
          gemini: geminiStatus,
          activeSessions: this.sessions.size,
          isGenerating: false,
        }),
      );
      return;
    }

    if (req.url === "/sessions" && req.method === "GET") {
      const sessionList = Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        platform: s.platform,
        model: s.model,
        conversationUrl: s.conversationUrl,
        isInitialized: s.isInitialized,
        lastActiveAt: s.lastActiveAt,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessionList));
      return;
    }

    if (req.url === "/window/show" && req.method === "POST") {
      await this.ensureBrowser();
      if (this.windowManager) await this.windowManager.showWindow();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/window/minimize" && req.method === "POST") {
      await this.ensureBrowser();
      if (this.windowManager) await this.windowManager.minimizeWindow();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/tab/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { platform, sessionId } = JSON.parse(body || "{}");
          await this.ensureBrowser();

          let targetPage: Page | undefined;
          if (sessionId && this.sessions.has(sessionId)) {
            targetPage = this.sessions.get(sessionId)?.page;
          } else if (platform) {
            targetPage = this.defaultPages.get(platform);
          }

          if (targetPage && !targetPage.isClosed()) {
            await targetPage.bringToFront();
            if (this.windowManager) await this.windowManager.showWindow();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, sessionId, platform }));
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Target tab not found" }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === "/cancel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { sessionId, platform } = JSON.parse(body || "{}");
          let stopped = false;

          if (sessionId && this.sessions.has(sessionId)) {
            const session = this.sessions.get(sessionId);
            if (session && !session.page.isClosed()) {
              stopped = await session.handler.stopGeneration();
            }
          } else if (platform && this.defaultPages.has(platform)) {
            const page = this.defaultPages.get(platform);
            if (page && !page.isClosed()) {
              const handler = platform === "gemini" ? new GeminiHandler(page) : new DeepSeekHandler(page);
              stopped = await handler.stopGeneration();
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, stopped }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === "/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const {
            prompt,
            platform = "deepseek",
            model = "deepseek-normal",
            deepThink = false,
            sessionId,
            systemPrompt,
          } = JSON.parse(body);

          const isOnline = await this.ensureBrowser();
          if (!isOnline) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "المتصفح غير متصل. يرجى تشغيل المتصفح من سطح المكتب." }));
            return;
          }

          // Allocate isolated session if sessionId is provided, otherwise fallback to default platform tab
          let session: BrowserSession | null = null;
          let targetHandler: GeminiHandler | DeepSeekHandler;

          if (sessionId) {
            session = await this.getOrCreateSession(sessionId, platform, model);
            targetHandler = session.handler;
          } else {
            const defaultPage = this.defaultPages.get(platform);
            if (!defaultPage) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `المنصة ${platform} غير متصلة.` }));
              return;
            }
            targetHandler = platform === "gemini" ? new GeminiHandler(defaultPage) : new DeepSeekHandler(defaultPage);
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          // Session Lock to prevent multiple concurrent requests colliding on the same page
          const lockKey = sessionId || platform;
          const prevLock = this.sessionLocks.get(lockKey) || Promise.resolve();
          let releaseLock: () => void;
          const currentLock = new Promise<void>((r) => (releaseLock = r));
          this.sessionLocks.set(lockKey, currentLock);

          await prevLock;

          res.on("error", () => {});

          try {
            // One-time Bootstrap / System Prompt if session is not yet initialized
            if (session && !session.isInitialized && systemPrompt) {
              const bootstrapPrompt = `[SYSTEM INITIALIZATION & AGENT ROLE]\n${systemPrompt}\n\n[INSTRUCTION]\nPlease acknowledge receipt with a one-sentence confirmation and await tasks.`;
              if (platform === "gemini") {
                for await (const chunk of (targetHandler as GeminiHandler).sendMessage(bootstrapPrompt, model)) {
                  // Consume initialization turn silently or as init status
                  if (chunk.type === "status" && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              } else {
                for await (const chunk of (targetHandler as DeepSeekHandler).sendMessage(bootstrapPrompt, false)) {
                  if (chunk.type === "status" && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              }
              session.isInitialized = true;
              session.conversationUrl = session.page.url();
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: "status", status: "INITIALIZED" })}\n\n`);
              }
            }

            // Stream user task prompt
            if (platform === "gemini") {
              for await (const chunk of (targetHandler as GeminiHandler).sendMessage(prompt, model)) {
                if (!res.writableEnded) {
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              }
            } else {
              for await (const chunk of (targetHandler as DeepSeekHandler).sendMessage(prompt, !!deepThink)) {
                if (!res.writableEnded) {
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              }
            }

            if (session) {
              session.conversationUrl = session.page.url();
              session.lastActiveAt = Date.now();
            }

            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            }
          } catch (innerErr: any) {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "error", message: innerErr.message })}\n\n`);
            }
          } finally {
            releaseLock!();
            if (!res.writableEnded) {
              res.end();
            }
          }
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
            res.end();
          }
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const session of this.sessions.values()) {
      if (!session.page.isClosed()) {
        await session.page.close().catch(() => {});
      }
    }
    this.sessions.clear();
  }
}
