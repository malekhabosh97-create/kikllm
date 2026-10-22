import type { Page } from "playwright";

export interface DeepSeekStreamChunk {
  type: "token" | "thinking" | "status" | "error" | "replace";
  text?: string;
  status?: string;
  message?: string;
}

export class DeepSeekHandler {
  constructor(private page: Page) {}

  async navigate(): Promise<void> {
    await this.page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });
  }

  async checkStatus(): Promise<"READY" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION"> {
    if (this.page.isClosed()) return "NEEDS_LOGIN";

    const url = this.page.url();
    if (url.includes("/login") || url.includes("/sign_in")) {
      return "NEEDS_LOGIN";
    }

    // Check Cloudflare or Turnstile Captcha
    const cf = await this.page.$("#challenge-running, #challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare']");
    if (cf) {
      return "NEEDS_HUMAN_INTERVENTION";
    }

    // Check for login button
    const loginBtn = await this.page.$("button:has-text('Log in'), button:has-text('Sign in'), a[href*='login']");
    const textarea = await this.page.$("textarea#chat-input, textarea");
    if (!textarea && loginBtn) {
      return "NEEDS_LOGIN";
    }

    return "READY";
  }

  async setDeepThinkMode(enabled: boolean): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      const deepThinkBtn = await this.page.$(
        "button:has-text('DeepThink'), div:has-text('DeepThink'), [aria-label*='DeepThink']",
      );
      if (deepThinkBtn) {
        const isChecked = await deepThinkBtn.evaluate((el) => {
          return (
            el.getAttribute("aria-checked") === "true" ||
            el.classList.contains("active") ||
            el.classList.contains("selected")
          );
        });
        if (isChecked !== enabled) {
          await deepThinkBtn.click();
          await this.page.waitForTimeout(300);
        }
      }
    } catch (e: any) {
      console.warn("Could not toggle DeepThink:", e.message);
    }
  }

  async startNewChat(): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      const newChatBtn = await this.page.$(
        'button:has-text("New chat"), div[role="button"]:has-text("New chat"), a[href="/"]'
      );
      if (newChatBtn) {
        await newChatBtn.click();
        await this.page.waitForTimeout(500);
      } else {
        await this.page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });
      }
    } catch {
      await this.page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  async stopGeneration(): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const stopBtn = await this.page.$("button[aria-label*='Stop'], .ds-icon--stop, button:has-text('Stop')");
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
    deepThink: boolean = false,
  ): AsyncGenerator<DeepSeekStreamChunk, void, unknown> {
    const status = await this.checkStatus();
    if (status !== "READY") {
      yield { type: "status", status };
      return;
    }

    await this.setDeepThinkMode(deepThink);

    // Baseline count of existing messages to only read the NEW turn
    const messageSelector = ".ds-markdown, .fbb737a4";
    const initialMessages = await this.page.$$(messageSelector);
    const baselineCount = initialMessages.length;

    const textarea = await this.page.waitForSelector("textarea#chat-input, textarea", { timeout: 15000 });
    await textarea.click();
    await textarea.fill(prompt);
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press("Enter");

    let hasStarted = false;
    let lastLength = 0;
    let stableChecks = 0;

    for (let i = 0; i < 360; i++) {
      // up to 6 minutes
      await this.page.waitForTimeout(1000);

      // Check if Captcha popped up during generation
      const cf = await this.page.$("#challenge-running, .cf-turnstile");
      if (cf) {
        yield { type: "status", status: "NEEDS_HUMAN_INTERVENTION" };
        return;
      }

      const stopBtn = await this.page.$("button[aria-label*='Stop'], .ds-icon--stop, button:has-text('Stop')");

      // Check if currently thinking
      const thinkingIndicator = await this.page.$(
        ".ds-thinking-header, :has-text('Thinking...'), :has-text('Thought for')",
      );
      if (thinkingIndicator && !hasStarted) {
        yield { type: "thinking" };
      }

      const currentMessages = await this.page.$$(messageSelector);

      // CRITICAL FIX: Only extract text from the NEW turn
      if (currentMessages.length > baselineCount) {
        const lastMsgEl = currentMessages[currentMessages.length - 1];
        const currentText = (await lastMsgEl.innerText()) || "";

        if (currentText.length > 0) {
          if (!hasStarted) {
            hasStarted = true;
          }

          if (currentText.length > lastLength) {
            const chunk = currentText.slice(lastLength);
            lastLength = currentText.length;
            stableChecks = 0;
            yield { type: "token", text: chunk };
          } else if (currentText.length < lastLength) {
            yield { type: "replace", text: currentText };
            lastLength = currentText.length;
            stableChecks = 0;
          } else {
            stableChecks++;
          }
        }
      }

      // Completion check: response exists, stop button disappeared, text has stabilized
      if (hasStarted && currentMessages.length > baselineCount && !stopBtn && stableChecks >= 3) {
        yield { type: "status", status: "COMPLETED" };
        return;
      }
    }

    yield { type: "status", status: "COMPLETED" };
  }
}
