import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type {
  ChatSession,
  ReplyResult,
  Blocker,
  SiteConfig,
} from "./types.js";

export interface ChatSessionOptions {
  page: Page;
  config: SiteConfig;
  sessionDir?: string;
}

export class PlaywrightChatSession implements ChatSession {
  private page: Page;
  private config: SiteConfig;
  private sessionDir: string;
  private baselineMessageCount = 0;
  public matchedSelectors: Record<string, string> = {};

  constructor(options: ChatSessionOptions) {
    this.page = options.page;
    this.config = options.config;
    this.sessionDir =
      options.sessionDir ||
      path.resolve(process.cwd(), "calibration", this.config.id);

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  public getPage(): Page {
    return this.page;
  }

  private async findFirstElement(selectors: string[]) {
    for (const selector of selectors) {
      try {
        const el = await this.page.$(selector);
        if (el) return { element: el, selector };
      } catch {}
    }
    return null;
  }

  public async checkBlockers(): Promise<{ blocker: Blocker; details: string } | null> {
    if (this.page.isClosed()) {
      return { blocker: "browser_disconnected", details: "Page or browser was closed." };
    }

    const currentUrl = this.page.url();

    for (const rule of this.config.blockers) {
      // 1. Check URL pattern
      if (rule.urlPattern && new RegExp(rule.urlPattern, "i").test(currentUrl)) {
        return {
          blocker: rule.type,
          details: `URL matched blocker pattern: ${rule.urlPattern} (current: ${currentUrl})`,
        };
      }

      // 2. Check selector
      if (rule.selector) {
        try {
          const match = await this.page.$(rule.selector);
          if (match && (await match.isVisible().catch(() => false))) {
            return {
              blocker: rule.type,
              details: `Selector matched blocker rule: ${rule.selector}`,
            };
          }
        } catch {}
      }

      // 3. Check text pattern in page body
      if (rule.textPattern) {
        try {
          const bodyText = await this.page.evaluate(() => document.body?.innerText || "").catch(() => "");
          if (new RegExp(rule.textPattern, "i").test(bodyText)) {
            return {
              blocker: rule.type,
              details: `Body text matched blocker regex: ${rule.textPattern}`,
            };
          }
        } catch {}
      }
    }

    return null;
  }

  private async countAssistantMessages(): Promise<number> {
    for (const selector of this.config.lastMessage) {
      try {
        const elements = await this.page.$$(selector);
        if (elements.length > 0) {
          return elements.length;
        }
      } catch {}
    }
    return 0;
  }

  private async extractLatestMessageText(): Promise<string> {
    for (const containerSelector of this.config.lastMessage) {
      try {
        const containers = await this.page.$$(containerSelector);
        if (containers.length > this.baselineMessageCount) {
          const latest = containers[containers.length - 1];
          // Try sub-selectors first
          for (const textSelector of this.config.messageText) {
            try {
              const subEl = await latest.$(textSelector);
              if (subEl) {
                const text = (await subEl.innerText()) || "";
                if (text.trim().length > 0) {
                  this.matchedSelectors["lastMessage"] = containerSelector;
                  this.matchedSelectors["messageText"] = textSelector;
                  return this.cleanMessageText(text);
                }
              }
            } catch {}
          }
          // Fall back to container innerText
          const raw = (await latest.innerText()) || "";
          if (raw.trim().length > 0) {
            this.matchedSelectors["lastMessage"] = containerSelector;
            return this.cleanMessageText(raw);
          }
        }
      } catch {}
    }
    return "";
  }

  private cleanMessageText(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith("Gemini said")) {
      cleaned = cleaned.replace(/^Gemini said\s*/i, "").trim();
    }
    return cleaned;
  }

  async send(text: string): Promise<void> {
    if (this.page.isClosed()) {
      throw new Error("Cannot send message: page is closed.");
    }

    // Check blockers before sending
    const blocker = await this.checkBlockers();
    if (blocker) {
      throw new Error(`Cannot send message: blocked by ${blocker.blocker} (${blocker.details})`);
    }

    // Record baseline count of assistant messages
    this.baselineMessageCount = await this.countAssistantMessages();

    // Wait for chat input if not immediately ready
    let inputMatch = await this.findFirstElement(this.config.chatInput);
    if (!inputMatch) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.page.waitForTimeout(500);
        inputMatch = await this.findFirstElement(this.config.chatInput);
        if (inputMatch) break;
      }
    }

    if (!inputMatch) {
      throw new Error(
        `Failed to find chat input using selectors: ${this.config.chatInput.join(", ")}`,
      );
    }

    this.matchedSelectors["chatInput"] = inputMatch.selector;
    const { element: inputEl } = inputMatch;
    await inputEl.click();
    await inputEl.fill(text);
    await this.page.waitForTimeout(300);

    // Find send button
    const sendMatch = await this.findFirstElement(this.config.sendButton);
    if (sendMatch) {
      this.matchedSelectors["sendButton"] = sendMatch.selector;
      await sendMatch.element.click();
    } else {
      await this.page.keyboard.press("Enter");
    }
  }

  async attach(files: string[]): Promise<void> {
    if (files.length === 0) return;
    if (this.page.isClosed()) throw new Error("Cannot attach files: page is closed.");

    // Check if attach button needs to be opened to reveal the hidden input
    let fileInputMatch = await this.findFirstElement(this.config.fileInput);
    if (!fileInputMatch && this.config.attachButton) {
      const attachMatch = await this.findFirstElement(this.config.attachButton);
      if (attachMatch) {
        this.matchedSelectors["attachButton"] = attachMatch.selector;
        await attachMatch.element.click();
        await this.page.waitForTimeout(600);
        fileInputMatch = await this.findFirstElement(this.config.fileInput);
      }
    }

    if (fileInputMatch) {
      this.matchedSelectors["fileInput"] = fileInputMatch.selector;
      await fileInputMatch.element.setInputFiles(files);
      await this.page.waitForTimeout(1000);
      await this.page.keyboard.press("Escape").catch(() => {});

      // Check if composer was disabled by Gemini due to missing login
      const isDisabled = await this.page.evaluate(() => {
        const editor = document.querySelector("rich-textarea");
        return (
          editor?.classList.contains("ql-disabled") ||
          editor?.querySelector("[contenteditable='false']") !== null
        );
      });

      if (isDisabled) {
        throw new Error(
          "File attachment rejected by Gemini: composer is disabled (ql-disabled). Gemini requires being signed in to a Google account to attach files.",
        );
      }

      // Verify that attachment chip appears in DOM within composer before proceeding
      for (const filePath of files) {
        const baseName = path.basename(filePath);
        let chipFound = false;
        const chipStart = Date.now();
        while (Date.now() - chipStart < 10000) {
          chipFound = await this.page.evaluate((targetName) => {
            const composer = document.querySelector("rich-textarea, .chat-composer, form, .input-area");
            if (!composer) return false;
            const elements = Array.from(composer.querySelectorAll("*"));
            return elements.some((el) => {
              const text = (el as HTMLElement).innerText || "";
              const aria = el.getAttribute("aria-label") || "";
              return (
                (text.includes(targetName) || aria.includes(targetName)) &&
                (el as HTMLElement).offsetParent !== null &&
                el.tagName !== "INPUT" &&
                el.tagName !== "SCRIPT"
              );
            });
          }, baseName);

          if (chipFound) break;
          await this.page.waitForTimeout(500);
        }

        if (!chipFound) {
          throw new Error(
            `Attachment chip verification failed: '${baseName}' was not rendered in the chat composer within 10s.`,
          );
        }
      }
      return;
    }

    throw new Error(
      `File attachment failed: could not locate file input with selectors (${this.config.fileInput.join(", ")})`,
    );
  }

  async waitForReply(opts?: {
    timeoutMs?: number;
    onChunk?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<ReplyResult> {
    const timeoutMs = opts?.timeoutMs || this.config.completion.maxTimeoutMs || 300000;
    const pollInterval = this.config.completion.pollIntervalMs || 500;
    const requiredStability = this.config.completion.stabilityMs || 2500;

    const startTime = Date.now();
    let hasStarted = false;
    let lastText = "";
    let stableSince = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (opts?.signal?.aborted) {
        return {
          status: "blocked",
          text: lastText,
          blocker: "unknown",
          blockerDetails: "Aborted by caller signal",
        };
      }

      if (this.page.isClosed()) {
        return {
          status: "blocked",
          text: lastText,
          blocker: "browser_disconnected",
          blockerDetails: "Browser tab was closed during generation.",
        };
      }

      // Check blockers
      const blocker = await this.checkBlockers();
      if (blocker) {
        const screenshotPath = path.join(
          this.sessionDir,
          `blocker-${blocker.blocker}-${Date.now()}.png`,
        );
        const htmlPath = path.join(
          this.sessionDir,
          `blocker-${blocker.blocker}-${Date.now()}.html`,
        );
        try {
          await this.page.screenshot({ path: screenshotPath, fullPage: true });
          const html = await this.page.content();
          fs.writeFileSync(htmlPath, html, "utf8");
        } catch {}

        return {
          status: "blocked",
          text: lastText,
          blocker: blocker.blocker,
          blockerDetails: blocker.details,
          screenshotPath,
          rawHtmlSnapshot: htmlPath,
        };
      }

      // Check stop button
      const stopMatch = await this.findFirstElement(this.config.stopButton);
      const isGenerating = !!stopMatch;

      // Extract current text
      const currentText = await this.extractLatestMessageText();

      if (currentText.length > 0 || isGenerating) {
        hasStarted = true;
      }

      if (currentText !== lastText) {
        if (opts?.onChunk && currentText.startsWith(lastText)) {
          opts.onChunk(currentText.slice(lastText.length));
        } else if (opts?.onChunk) {
          opts.onChunk(currentText);
        }
        lastText = currentText;
        stableSince = Date.now();
      }

      // Completion condition:
      // Generation has started, stop button is gone, text is non-empty, and text has remained stable for >= stabilityMs
      if (
        hasStarted &&
        !isGenerating &&
        lastText.length > 0 &&
        Date.now() - stableSince >= requiredStability
      ) {
        return {
          status: "ok",
          text: lastText,
        };
      }

      await this.page.waitForTimeout(pollInterval);
    }

    // Timeout occurred
    const timeoutScreenshot = path.join(this.sessionDir, `timeout-${Date.now()}.png`);
    const timeoutHtml = path.join(this.sessionDir, `timeout-${Date.now()}.html`);
    try {
      await this.page.screenshot({ path: timeoutScreenshot, fullPage: true });
      const html = await this.page.content();
      fs.writeFileSync(timeoutHtml, html, "utf8");
    } catch {}

    return {
      status: "timeout",
      text: lastText,
      screenshotPath: timeoutScreenshot,
      rawHtmlSnapshot: timeoutHtml,
    };
  }

  async close(): Promise<void> {
    if (!this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
  }
}
