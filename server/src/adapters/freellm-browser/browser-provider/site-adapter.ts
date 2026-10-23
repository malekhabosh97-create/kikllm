import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type {
  SiteAdapter,
  SiteConfig,
  SiteHealth,
  ChatSession,
  Blocker,
} from "./types.js";
import { PlaywrightChatSession } from "./chat-session.js";

export interface SiteAdapterOptions {
  config: SiteConfig;
  profileDir: string;
  headless?: boolean;
  chromePath?: string;
}

export class BasePlaywrightSiteAdapter implements SiteAdapter {
  readonly id: string;
  protected config: SiteConfig;
  protected profileDir: string;
  protected headless: boolean;
  protected chromePath?: string;
  protected context: BrowserContext | null = null;
  private queue: Promise<any> = Promise.resolve();

  constructor(options: SiteAdapterOptions) {
    this.config = options.config;
    this.id = options.config.id;
    this.profileDir = options.profileDir;
    this.headless = options.headless ?? false;
    this.chromePath = options.chromePath;
  }

  /**
   * Enqueue a task to run sequentially on this site's browser context (concurrency = 1).
   */
  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  protected async getContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    const defaultChromePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];

    let executablePath = this.chromePath;
    if (!executablePath) {
      for (const p of defaultChromePaths) {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      }
    }

    const launchArgs = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ];

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      executablePath,
      channel: executablePath ? undefined : "chrome",
      args: launchArgs,
      viewport: null, // use actual window size
    });

    this.context.on("close", () => {
      this.context = null;
    });

    return this.context;
  }

  async health(): Promise<SiteHealth> {
    try {
      const context = await this.getContext();
      const pages = context.pages();
      let page: Page;

      if (pages.length > 0 && !pages[0].isClosed()) {
        page = pages[0];
      } else {
        page = await context.newPage();
      }

      if (!page.url().includes(this.config.url) && !page.url().includes("accounts.google.com")) {
        await page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
      }

      const currentUrl = page.url();

      // Check if logged in by examining URL and login indicators
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("/signin") ||
        currentUrl.includes("/sign_in")
      ) {
        return {
          ok: false,
          isLoggedIn: false,
          reason: "Needs login: currently at authentication URL.",
          currentUrl,
        };
      }

      for (const indicator of this.config.loginIndicators) {
        try {
          const el = await page.$(indicator);
          if (el && (await el.isVisible().catch(() => false))) {
            return {
              ok: false,
              isLoggedIn: false,
              reason: `Needs login: detected sign-in indicator (${indicator}).`,
              currentUrl,
            };
          }
        } catch {}
      }

      // Check blockers
      const session = new PlaywrightChatSession({
        page,
        config: this.config,
      });
      const blocker = await session.checkBlockers();
      if (blocker) {
        return {
          ok: false,
          isLoggedIn: blocker.blocker !== "login" && blocker.blocker !== "login_blocked",
          reason: `Site blocked: ${blocker.blocker} (${blocker.details})`,
          currentUrl,
        };
      }

      return {
        ok: true,
        isLoggedIn: true,
        currentUrl,
      };
    } catch (err: any) {
      return {
        ok: false,
        reason: `Health check error: ${err.message}`,
      };
    }
  }

  async listModels(): Promise<string[]> {
    if (this.config.modelOptions) {
      return Object.keys(this.config.modelOptions);
    }
    return ["default"];
  }

  async newChat(modelId?: string): Promise<ChatSession> {
    return this.enqueue(async () => {
      const context = await this.getContext();
      const page = await context.newPage();

      const targetUrl = this.config.newChatUrl || this.config.url;
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const session = new PlaywrightChatSession({
        page,
        config: this.config,
      });

      // Check immediately for blockers (e.g. login required or login blocked)
      const blocker = await session.checkBlockers();
      if (blocker) {
        if (blocker.blocker === "login" || blocker.blocker === "login_blocked") {
          throw new Error(`Authentication required for ${this.config.name}: ${blocker.details}`);
        }
        throw new Error(`Site blocked on initial navigation: ${blocker.blocker} (${blocker.details})`);
      }

      return session;
    });
  }

  async shutdown(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}
