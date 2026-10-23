import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BasePlaywrightSiteAdapter, type SiteAdapterOptions } from "./site-adapter.js";
import type { SiteConfig, ChatSession } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadGeminiConfig(): SiteConfig {
  const configPath = path.resolve(__dirname, "sites", "gemini.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as SiteConfig;
}

export const DEFAULT_GEMINI_PROFILE_DIR =
  process.env.FREELLM_GEMINI_PROFILE_DIR || "C:\\Users\\malek\\.freellm-gemini-profile";

export class GeminiSiteAdapter extends BasePlaywrightSiteAdapter {
  constructor(options?: Partial<SiteAdapterOptions>) {
    const config = options?.config || loadGeminiConfig();
    const profileDir = options?.profileDir || DEFAULT_GEMINI_PROFILE_DIR;
    const headless = options?.headless ?? false; // headed by default

    super({
      config,
      profileDir,
      headless,
      chromePath: options?.chromePath,
    });
  }

  override async newChat(modelId?: string): Promise<ChatSession> {
    const session = await super.newChat(modelId);
    const page = (session as any).getPage?.();

    if (page && modelId && this.config.modelOptions?.[modelId]) {
      const modelSpec = this.config.modelOptions[modelId];
      try {
        const pickerMatch = await this.findModelPicker(page);
        if (pickerMatch) {
          await pickerMatch.click();
          await page.waitForTimeout(400);

          if (modelSpec.selector) {
            const item = await page.$(modelSpec.selector);
            if (item) {
              await item.click();
              await page.waitForTimeout(400);
            }
          }
          await page.keyboard.press("Escape").catch(() => {});
        }
      } catch (e: any) {
        console.warn(`[GeminiSiteAdapter] Could not switch to model ${modelId}:`, e.message);
      }
    }

    return session;
  }

  private async findModelPicker(page: any) {
    if (!this.config.modelMenu) return null;
    for (const selector of this.config.modelMenu) {
      try {
        const el = await page.$(selector);
        if (el) return el;
      } catch {}
    }
    return null;
  }
}
