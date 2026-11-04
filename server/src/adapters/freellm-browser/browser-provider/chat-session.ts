import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {desktopRequest} from "./desktop-client.js";
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
  tabId?: string;
}

export function isProviderErrorReply(provider:string,text:string):boolean {
  const cleaned = text.trim();
  if (provider === "gemini") {
    return /^(?:(?:i'm\s+)?sorry,?\s*(?:but\s+)?something went wrong\.?\s*(?:please try (?:your request )?again\.?)?|i encountered an error doing what you asked\.?\s*(?:could you try again\??)?)$/i.test(cleaned);
  }
  if (provider === "deepseek") {
    return /(?:server\s+is\s+busy|too\s+many\s+requests|rate\s+limit|please\s+try\s+again\s+later|try\s+again\s+in\s+\d+|服务器繁忙|请求过于频繁)/i.test(cleaned);
  }
  return false;
}

export class PlaywrightChatSession implements ChatSession {
  private page: Page;
  private config: SiteConfig;
  private sessionDir: string;
  private baselineMessageCount = 0;
  readonly tabId?: string;
  isClosed(): boolean { return this.page.isClosed(); }
  url(): string { return this.page.url(); }
  async stop(): Promise<boolean> { const match = await this.findFirstElement(this.config.stopButton); if (!match) return false; await match.element.click(); return true; }
  async setBusy(busy:boolean):Promise<void>{if(this.tabId)await desktopRequest("tabs/state",{id:this.tabId,busy});}
  async findVisible(selectors: string[]) { return this.findFirstElement(selectors); }
  public matchedSelectors: Record<string, string> = {};

  constructor(options: ChatSessionOptions) {
    this.page = options.page;
    this.tabId = options.tabId;
    this.config = options.config;
    this.sessionDir =
      options.sessionDir ||
      path.join(os.homedir(), ".paperclip", "freellm", "diagnostics", this.config.id);

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  public getPage(): Page {
    return this.page;
  }

  private async findFirstElement(selectors: string[], allowHidden = false) {
    for (const selector of selectors) {
      try {
        const el = await this.page.$(selector);
        if (el && (allowHidden || await el.isVisible().catch(() => false))) return { element: el, selector };
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
          const bodyText = await this.page.evaluate((selectors) => { const clone=document.body.cloneNode(true) as HTMLElement; for(const selector of [...selectors,"textarea","[contenteditable]"]){try{clone.querySelectorAll(selector).forEach(node=>node.remove());}catch{}}return clone.innerText||clone.textContent||""; }, this.config.lastMessage).catch(() => "");
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


  private async messageMarkdown(element:any):Promise<string>{

    return element.evaluate((root:HTMLElement)=>{
      const clone=root.cloneNode(true) as HTMLElement;
      for(const element of Array.from(clone.querySelectorAll("button,script,style,[aria-hidden='true']")))element.remove();
      for(const block of Array.from(clone.querySelectorAll("pre,code-block:not(:has(pre))"))){
        const code=block.querySelector("code")||block;
        let label=block.getAttribute("data-language")||code.className.match(/language-([\w_-]+)/)?.[1]||block.querySelector("[class*='language']")?.textContent?.trim()||"";
        try{const value=JSON.parse(code.textContent||"");if(value&&typeof value.callId==="string"&&typeof value.tool==="string"&&value.arguments&&!label)label="tool_call";}catch{}
        block.replaceWith(document.createTextNode("\n\n"+String.fromCharCode(96).repeat(3)+label+"\n"+(code.textContent||"").trim()+"\n"+String.fromCharCode(96).repeat(3)+"\n\n"));
      }
      for(const link of Array.from(clone.querySelectorAll("a[href]"))){
        const href=link.getAttribute("href")||"";
        if(/^https?:/.test(href))link.replaceWith(document.createTextNode("["+(link.textContent||href)+"]("+href+")"));
      }
      for(const img of Array.from(clone.querySelectorAll("img[src]"))){
        const src=img.getAttribute("src")||"";
        const alt=img.getAttribute("alt")||img.getAttribute("aria-label")||"Generated Image";
        if(src && !src.startsWith("data:image/svg") && !src.includes("avatar") && !src.includes("emoji") && !src.includes("icon") && !src.includes("google_logo") && !src.includes("sparkle")){
          img.replaceWith(document.createTextNode("\n\n!["+alt+"]("+src+")\n\n"));
        }
      }
      for(const br of Array.from(clone.querySelectorAll("br")))br.replaceWith(document.createTextNode("\n"));
      for(const block of Array.from(clone.querySelectorAll("p,div,section,article,li,h1,h2,h3,h4,h5,h6"))){block.prepend("\n");block.append("\n");}
      return (clone.textContent||"").replace(/\n{3,}/g,"\n\n").trim();
    });
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
              const subEl = textSelector === "p" ? null : await latest.$(textSelector);
              if (subEl) {
                const text = (await this.messageMarkdown(subEl)) || "";
                if (text.trim().length > 0) {
                  this.matchedSelectors["lastMessage"] = containerSelector;
                  this.matchedSelectors["messageText"] = textSelector;
                  return this.cleanMessageText(text);
                }
              }
            } catch {}
          }
          // Fall back to container innerText
          const raw = (await this.messageMarkdown(latest)) || "";
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


  async waitUntilReady(opts?:{signal?:AbortSignal;onBlocker?:(message:string|null)=>void}):Promise<void>{
    const deadline=Date.now()+10*60*1000;let reported="";
    while(Date.now()<deadline){
      opts?.signal?.throwIfAborted();
      if(this.page.isClosed())throw Object.assign(new Error("Provider tab was closed"),{beforeSubmit:true,blocker:"browser_disconnected"});
      const blocker=await this.checkBlockers(),input=await this.findFirstElement(this.config.chatInput);
      if(!blocker&&input){if(reported)opts?.onBlocker?.(null);return;}
      const reason=blocker?.blocker||"not_ready";
      if(reported!==reason){reported=reason;opts?.onBlocker?.(this.config.name+": "+(blocker?.details||"واجهة المحادثة تحتاج فحصًا"));}
      if(blocker&&!["login","login_blocked","captcha"].includes(blocker.blocker))throw Object.assign(new Error(blocker.details),{beforeSubmit:true,blocker:blocker.blocker});
      await this.page.waitForTimeout(1000);
    }
    throw Object.assign(new Error("انتهت مهلة انتظار تسجيل الدخول أو التحقق البشري"),{beforeSubmit:true,blocker:"login"});
  }
  async dismissOverlays(): Promise<void> {
    try {
      const dismissSelectors = [
        "mat-dialog-actions button",
        "discovery-card-dialog button",
        "button:has-text('Got it')",
        "button:has-text('Dismiss')",
        "button:has-text('حسناً')",
        "button:has-text('إغلاق')",
        "button[aria-label*='Close']",
        "button[aria-label*='إغلاق']",
      ];
      for (const sel of dismissSelectors) {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.click({ timeout: 1000 }).catch(() => {});
          await this.page.waitForTimeout(200);
        }
      }
      const hasBackdrop = await this.page.$(".cdk-overlay-backdrop, .modal-backdrop");
      if (hasBackdrop && await hasBackdrop.isVisible()) {
        await this.page.keyboard.press("Escape").catch(() => {});
        await this.page.waitForTimeout(200);
      }
    } catch {}
  }

  async send(text: string): Promise<void> {
    if (this.page.isClosed()) {
      throw new Error("Cannot send message: page is closed.");
    }

    // Check blockers before sending
    const blocker = await this.checkBlockers();
    if (blocker) {
      throw Object.assign(new Error(`Cannot send message: blocked by ${blocker.blocker} (${blocker.details})`),{beforeSubmit:true,blocker:blocker.blocker});
    }

    await this.dismissOverlays().catch(() => {});

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
      throw Object.assign(new Error("Chat input is unavailable; inspect the provider tab"),{beforeSubmit:true,blocker:"not_ready"});
    }

    this.matchedSelectors["chatInput"] = inputMatch.selector;
    const { element: inputEl } = inputMatch;
    await inputEl.focus();
    await this.page.keyboard.press("ControlOrMeta+A");
    await this.page.keyboard.insertText(text);
    await this.page.waitForTimeout(300);

    // Find send button
    const sendMatch = await this.findFirstElement(this.config.sendButton);
    const viewport=await this.page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    const buttonBox=sendMatch?await sendMatch.element.boundingBox():null;
    if (sendMatch && buttonBox && buttonBox.x>=0 && buttonBox.y>=0 && buttonBox.x+buttonBox.width<=viewport.width && buttonBox.y+buttonBox.height<=viewport.height) {
      this.matchedSelectors["sendButton"] = sendMatch.selector;
      try {
        await sendMatch.element.click({ timeout: 5000 });
      } catch {
        // If click was intercepted by an overlay or timed out, press Escape to clear overlays then press Enter
        await this.page.keyboard.press("Escape").catch(() => {});
        await this.page.waitForTimeout(200);
        await this.page.keyboard.press("Enter").catch(() => {});
      }
    } else {
      await this.page.keyboard.press("Enter");
    }
  }

  async attach(files: string[]): Promise<void> {
    if (files.length === 0) return;
    if (this.page.isClosed()) throw new Error("Cannot attach files: page is closed.");

    // Check if attach button needs to be opened to reveal the hidden input
    let fileInputMatch = await this.findFirstElement(this.config.fileInput, true);
    if (!fileInputMatch && this.config.attachButton) {
      const attachMatch = await this.findFirstElement(this.config.attachButton);
      if (attachMatch) {
        this.matchedSelectors["attachButton"] = attachMatch.selector;
        await attachMatch.element.click();
        await this.page.waitForTimeout(600);
        fileInputMatch = await this.findFirstElement(this.config.fileInput, true);
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
    onSnapshot?: (text: string) => void;
    onBlocker?: (message:string|null)=>void;
    signal?: AbortSignal;
  }): Promise<ReplyResult> {
    const timeoutMs = opts?.timeoutMs || this.config.completion.maxTimeoutMs || 300000;
    const pollInterval = this.config.completion.pollIntervalMs || 500;
    const requiredStability = this.config.completion.stabilityMs || 2500;

    const startTime = Date.now();
    let paused=0,reportedBlocker="";const humanDeadline=Date.now()+10*60*1000;
    let hasStarted = false;
    let lastText = "";
    let stableSince = Date.now();

    while (Date.now() - startTime - paused < timeoutMs) {
      if (opts?.signal?.aborted) {
        await this.stop().catch(() => false);
        return {
          status: "cancelled",
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

      const limitBlocker=blocker&&["rate_limit","quota_exhausted"].includes(blocker.blocker)?blocker:null;
      if(blocker&&!limitBlocker){
        if(["login","login_blocked","captcha"].includes(blocker.blocker)&&Date.now()<humanDeadline){
          if(reportedBlocker!==blocker.blocker){reportedBlocker=blocker.blocker;opts?.onBlocker?.(this.config.name+": "+blocker.details);}
          const waitStart=Date.now();await this.page.waitForTimeout(pollInterval);paused+=Date.now()-waitStart;continue;
        }
        return {status:"blocked",text:lastText,blocker:blocker.blocker,blockerDetails:blocker.details};
      }
      if(reportedBlocker){reportedBlocker="";opts?.onBlocker?.(null);stableSince=Date.now();}

      // Check stop button
      const stopMatch = await this.findFirstElement(this.config.stopButton);
      const isGenerating = !!stopMatch;

      // Extract current text
      const currentText = await this.extractLatestMessageText();
      // A site can display a limit warning after delivering its last answer.
      // Keep the completed answer; stop only when the warning is the outcome.
      if(limitBlocker&&!isGenerating&&(!currentText.trim()||/quota exceeded|reached your daily limit|limit reached/i.test(currentText))){
        return {status:"blocked",text:lastText,blocker:limitBlocker.blocker,blockerDetails:limitBlocker.details};
      }

      if (currentText.length > 0 || isGenerating) {
        hasStarted = true;
      }

      if (currentText !== lastText) {
        opts?.onSnapshot?.(currentText);
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
        if(isProviderErrorReply(this.config.id,lastText))return {
          status:"blocked",text:lastText,blocker:"provider_error",
          blockerDetails:`أعادت منصة ${this.config.name || this.config.id} تنبيهاً بالانشغال أو خطأ في الرد. العمل محفوظ لإعادة المحاولة المنظمة.`,
        };
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
      stopped:await this.stop().catch(()=>false),
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
