import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { SiteAdapter, SiteConfig, SiteHealth, ChatSession, LiveModelInfo } from "./types.js";
import { PlaywrightChatSession } from "./chat-session.js";
import { desktopConnection, desktopRequest, desktopPage, type DesktopTab } from "./desktop-client.js";

export interface SiteAdapterOptions { config: SiteConfig; profileDir: string; headless?: boolean; chromePath?: string; embedded?: boolean; }
export class BasePlaywrightSiteAdapter implements SiteAdapter {
  readonly id: string;
  protected config: SiteConfig;
  protected profileDir: string;
  protected headless: boolean;
  protected chromePath?: string;
  protected context: BrowserContext | null = null;
  private contextStarting?: Promise<BrowserContext>;
  private queue: Promise<unknown> = Promise.resolve();
  protected embedded: boolean;
  constructor(options: SiteAdapterOptions) {
    this.config = options.config; this.id = options.config.id; this.profileDir = options.profileDir;
    this.headless = options.headless ?? false; this.chromePath = options.chromePath; this.embedded = options.embedded ?? true;
  }
  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task); this.queue = result.catch(() => {}); return result;
  }
  protected async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.contextStarting) this.contextStarting = (async () => {
      fs.mkdirSync(this.profileDir, { recursive: true });
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless, executablePath: this.chromePath, channel: this.chromePath ? undefined : "chrome", viewport: { width: 1280, height: 800 }
      });
      this.context = context;
      context.on("close", () => { this.context = null; this.contextStarting = undefined; });
      return context;
    })();
    try { return await this.contextStarting; } catch (error) { this.contextStarting = undefined; throw error; }
  }
  protected async providerPage(): Promise<Page> {
    if (this.embedded) {
      const status = await desktopRequest<{ tabs: DesktopTab[] }>("status");
      const existing = status.tabs.find(tab => tab.provider === this.id && tab.purpose !== "conversation");
      const tab = existing || await desktopRequest<DesktopTab>("tabs/create", { provider: this.id, url: this.config.url });
      return desktopPage(tab.targetId);
    }
    const context = await this.getContext();
    const existing = context.pages().find(page => !page.isClosed() && page.url().startsWith(this.config.url));
    if (existing) return existing;
    const page = await context.newPage(); await page.goto(this.config.url, { waitUntil: "domcontentloaded" }); return page;
  }
  async health(): Promise<SiteHealth> {
    try {
      if (this.embedded && !desktopConnection()) return { ok: false, reason: "متصفح التطبيق غير متصل" };
      let page: Page;
      if (this.embedded) {
        const status = await desktopRequest<{ tabs: DesktopTab[] }>("status");
        const tab = status.tabs.find(tab => tab.provider === this.id);
        if (!tab) return { ok: false, reason: "لم يتم فتح حساب المنصة بعد" };
        page = await desktopPage(tab.targetId);
      } else page = await this.providerPage();
      const probe = new PlaywrightChatSession({ page, config: this.config });
      const blocker = await probe.checkBlockers();
      if (blocker) return { ok: false, isLoggedIn: false, currentUrl: page.url(), reason: blocker.blocker + ": " + blocker.details };
      for (const selector of this.config.loginIndicators) {
        const element = await page.$(selector).catch(() => null);
        if (element && await element.isVisible().catch(() => false)) return { ok: false, isLoggedIn: false, currentUrl: page.url(), reason: "تحتاج تسجيل الدخول" };
      }
      const input = await probe.findVisible(this.config.chatInput);
      return { ok: Boolean(input), isLoggedIn: Boolean(input), currentUrl: page.url(), reason: input ? undefined : "واجهة المحادثة غير جاهزة أو تحتاج معايرة" };
    } catch (error) { return { ok: false, reason: String((error as Error).message) }; }
  }
  async listModels(): Promise<LiveModelInfo[]> {
    return [{ id: this.id + "-default", label: "الوضع الحالي في الحساب", locked: false }];
  }
  async newChat(_modelId?: string): Promise<ChatSession> {
    return this.enqueue(async () => {
      let page: Page; let tabId: string | undefined;
      if (this.embedded) {
        const tab = await desktopRequest<DesktopTab>("tabs/create", { provider: this.id, url: this.config.newChatUrl || this.config.url, purpose:"conversation" });
        page = await desktopPage(tab.targetId);await page.setViewportSize({width:1280,height:800}); tabId = tab.id;
      } else {
        page = await (await this.getContext()).newPage();
        await page.goto(this.config.newChatUrl || this.config.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      return new PlaywrightChatSession({ page, config: this.config, tabId });
    });
  }
  async resumeChat(url: string, _modelId?: string): Promise<ChatSession> {
    const destination = new URL(url);
    if (destination.origin !== new URL(this.config.url).origin) throw new Error("رابط المحادثة لا يتبع المنصة");
    let page: Page; let tabId: string | undefined;
    if (this.embedded) {
      const tab = await desktopRequest<DesktopTab>("tabs/create", { provider: this.id, url, purpose:"conversation" }); tabId = tab.id; page = await desktopPage(tab.targetId);await page.setViewportSize({width:1280,height:800});
    } else { page = await (await this.getContext()).newPage(); await page.goto(url, { waitUntil: "domcontentloaded" }); }
    return new PlaywrightChatSession({ page, config: this.config, tabId });
  }
  async shutdown(): Promise<void> { if (this.context) await this.context.close(); this.context = null; }
}
