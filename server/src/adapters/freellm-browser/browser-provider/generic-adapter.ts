import os from "node:os";
import path from "node:path";
import { BasePlaywrightSiteAdapter } from "./site-adapter.js";
import type { SiteConfig } from "./types.js";
export const WEB_PROVIDERS = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com", responses: ["[data-message-author-role='assistant']"] },
  { id: "claude", name: "Claude", url: "https://claude.ai/new", responses: ["[data-is-streaming]", "[data-testid='assistant-message']", ".font-claude-message"] },
  { id: "qwen", name: "Qwen", url: "https://chat.qwen.ai", responses: [".qwen-markdown", "[data-message-role='assistant']"] },
  { id: "grok", name: "Grok", url: "https://grok.com", responses: [".response-content-markdown", "[data-message-role='assistant']"] },
  { id: "glm", name: "GLM", url: "https://chat.z.ai", responses: [".markdown-prose", "[data-message-role='assistant']"] },
  { id: "arena", name: "Arena", url: "https://arena.ai", responses: ["[data-message-author-role='assistant']", ".prose"] },
] as const;
export class GenericSiteAdapter extends BasePlaywrightSiteAdapter {
  constructor(provider: typeof WEB_PROVIDERS[number]) {
    const config: SiteConfig = {
      id: provider.id, name: provider.name, url: provider.url, newChatUrl: provider.url,
      chatInput: ["textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
      sendButton: ["button[aria-label='Send message']", "button[aria-label='Send']", "button[type='submit']"],
      stopButton: ["button[aria-label*='Stop']", "button[data-testid='stop-button']"],
      lastMessage: [...provider.responses], messageText: [], attachButton: ["button[aria-label*='Attach']"], fileInput: ["input[type='file']"],
      loginIndicators: ["button:has-text('Log in')", "a:has-text('Log in')"],
      blockers: [
        { type: "login", urlPattern: "/(login|sign_in|signin)(/|\\?|$)" },
        { type: "captcha", selector: "#challenge-running, iframe[src*='challenges.cloudflare']" },
        { type: "rate_limit", selector: "[data-testid='rate-limit-error']" }
      ],
      completion: { stabilityMs: 3000, pollIntervalMs: 500, maxTimeoutMs: 300000 }
    };
    super({ config, profileDir: path.join(os.homedir(), ".paperclip", "freellm", provider.id) });
  }
  override async newChat(modelId?:string) {
    if(modelId&&modelId!==this.id&&modelId!==this.id+"-default")throw new Error("This provider only supports the account's current mode until its model picker is calibrated");
    return super.newChat(modelId);
  }

}
