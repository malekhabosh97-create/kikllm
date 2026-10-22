import type { Page } from "playwright";

export interface GeminiStreamChunk {
  type: "token" | "thinking" | "status" | "error" | "replace";
  text?: string;
  status?: string;
  message?: string;
}

export class GeminiHandler {
  constructor(private page: Page) {}

  async navigate(): Promise<void> {
    await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
  }

  async checkStatus(): Promise<"READY" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION"> {
    if (this.page.isClosed()) return "NEEDS_LOGIN";

    const url = this.page.url();
    if (url.includes("accounts.google.com") || url.includes("/signin") || url.includes("/sign_in")) {
      return "NEEDS_LOGIN";
    }

    // Check challenge / bot verification
    const challenge = await this.page.$("#challenge-running, #challenge-stage, .g-recaptcha, iframe[src*='recaptcha'], [id*='captcha']");
    if (challenge) {
      return "NEEDS_HUMAN_INTERVENTION";
    }

    // Check if input area is available
    const input = await this.page.$('rich-textarea, div.ql-editor[role="textbox"], div[role="textbox"]');
    if (input) {
      return "READY";
    }

    // Check if sign-in button is explicitly visible
    const signinBtn = await this.page.$('button:has-text("Sign in"), a:has-text("Sign in")');
    if (signinBtn) {
      return "NEEDS_LOGIN";
    }

    return "READY";
  }

  async selectModel(modelKey?: string): Promise<void> {
    if (!modelKey || modelKey === "gemini-default" || this.page.isClosed()) return;

    try {
      const pickerBtn = await this.page.$('button[aria-label*="mode picker"], button:has-text("Gemini")');
      if (!pickerBtn) return;

      const currentText = (await pickerBtn.innerText()) || "";
      const currentAria = (await pickerBtn.getAttribute("aria-label")) || "";

      let keyword = "";
      if (modelKey.includes("pro")) keyword = "Pro";
      else if (modelKey.includes("flash-lite")) keyword = "Flash-Lite";
      else if (modelKey.includes("flash")) keyword = "Flash";
      else if (modelKey.includes("argon")) keyword = "Argon";

      if (!keyword) return;

      if (currentText.includes(keyword) || currentAria.includes(keyword)) {
        return;
      }

      await pickerBtn.click();
      await this.page.waitForTimeout(400);

      const items = await this.page.$$('[role="menuitem"], .mat-mdc-menu-item');
      for (const item of items) {
        const itemText = await item.innerText();
        if (itemText.includes(keyword)) {
          await item.click();
          await this.page.waitForTimeout(400);
          break;
        }
      }

      await this.page.keyboard.press("Escape").catch(() => {});
    } catch (e: any) {
      console.warn("[GeminiHandler] Failed to switch model:", e.message);
    }
  }

  async startNewChat(): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      const newChatBtn = await this.page.$(
        'a[href="/app"], button[aria-label*="New chat"], [data-test-id="new-chat-button"], button:has-text("New chat")'
      );
      if (newChatBtn) {
        await newChatBtn.click();
        await this.page.waitForTimeout(500);
      } else {
        await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
      }
    } catch {
      await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  async stopGeneration(): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const stopBtn = await this.page.$(
        'button[aria-label*="Stop response"], button.stop-response-button, [aria-label*="Stop"]'
      );
      if (stopBtn) {
        await stopBtn.click();
        return true;
      }
    } catch {}
    return false;
  }

  getConversationUrl(): string {
    return this.page.url();
  }

  async *sendMessage(
    prompt: string,
    modelKey?: string,
  ): AsyncGenerator<GeminiStreamChunk, void, unknown> {
    const status = await this.checkStatus();
    if (status !== "READY") {
      yield { type: "status", status };
      return;
    }

    await this.selectModel(modelKey);

    // Baseline count of existing assistant messages to ensure we only read the NEW turn
    const responseSelector = "message-content, .response-content, .model-response-text, model-response";
    const initialElements = await this.page.$$(responseSelector);
    const baselineCount = initialElements.length;

    const editor = await this.page.waitForSelector(
      'div.ql-editor[role="textbox"], rich-textarea div[contenteditable="true"], textarea',
      { timeout: 15000 },
    );

    await editor.click();
    await editor.fill(prompt);
    await this.page.waitForTimeout(300);

    const sendBtn = await this.page.$(
      'button[aria-label*="Send message"], button.send-button, [aria-label*="Submit"]',
    );
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await this.page.keyboard.press("Enter");
    }

    let hasStarted = false;
    let lastLength = 0;
    let stableChecks = 0;

    for (let i = 0; i < 360; i++) {
      // up to 6 minutes
      await this.page.waitForTimeout(1000);

      // Check if Captcha / Challenge popped up
      const challenge = await this.page.$("#challenge-running, .g-recaptcha, iframe[src*='recaptcha']");
      if (challenge) {
        yield { type: "status", status: "NEEDS_HUMAN_INTERVENTION" };
        return;
      }

      // Check for stop button (indicates generation in progress)
      const stopBtn = await this.page.$(
        'button[aria-label*="Stop response"], button.stop-response-button, [aria-label*="Stop"]'
      );

      const currentElements = await this.page.$$(responseSelector);

      // CRITICAL FIX: Only read if a NEW response element has appeared beyond baseline
      if (currentElements.length > baselineCount) {
        const lastEl = currentElements[currentElements.length - 1];
        let currentText = (await lastEl.innerText()) || "";

        if (currentText.startsWith("Gemini said")) {
          currentText = currentText.replace(/^Gemini said\s*/i, "").trim();
        }

        if (currentText.length > 0) {
          if (!hasStarted) {
            hasStarted = true;
          }

          if (currentText.length > lastLength) {
            const newChunk = currentText.slice(lastLength);
            yield { type: "token", text: newChunk };
            lastLength = currentText.length;
            stableChecks = 0;
          } else if (currentText.length < lastLength) {
            // Text was edited/corrected by the model in-place
            yield { type: "replace", text: currentText };
            lastLength = currentText.length;
            stableChecks = 0;
          } else {
            stableChecks++;
          }
        }
      } else if (stopBtn) {
        // Stop button exists but text not yet rendered => Model is thinking/generating initial tokens
        if (!hasStarted) {
          hasStarted = true;
          yield { type: "thinking" };
        }
      }

      // Generation completion condition:
      // Response element exists, stop button is gone, and text has remained stable for at least 3 checks
      if (hasStarted && currentElements.length > baselineCount && !stopBtn && stableChecks >= 3) {
        break;
      }
    }
  }
}
