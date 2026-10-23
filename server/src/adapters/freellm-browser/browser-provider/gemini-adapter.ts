import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BasePlaywrightSiteAdapter, type SiteAdapterOptions } from "./site-adapter.js";
import type { SiteConfig, ChatSession, LiveModelInfo } from "./types.js";

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

  override async listModels(): Promise<LiveModelInfo[]> {
    return this.enqueue(async () => {
      const context = await this.getContext();
      const pages = context.pages();
      let page = pages.find((p) => !p.isClosed());
      if (!page) {
        page = await context.newPage();
      }

      if (!page.url().includes("gemini.google.com")) {
        await page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000);
      }

      const pickerBtn = await this.findModelPicker(page);
      if (!pickerBtn) {
        return [];
      }

      await pickerBtn.click();
      await page.waitForTimeout(600);

      const items = await page.evaluate(() => {
        const menuItems = Array.from(document.querySelectorAll("gem-menu-item, [role='menuitem']"));
        return menuItems
          .filter((item) => (item as HTMLElement).offsetParent !== null)
          .map((item) => {
            const rawText = (item as HTMLElement).innerText?.trim()?.replace(/\n+/g, " | ") || "";
            const ariaLabel = item.getAttribute("aria-label") || "";
            const dataTestId = item.getAttribute("data-test-id") || "";
            const isDisabled =
              item.getAttribute("aria-disabled") === "true" ||
              item.classList.contains("disabled") ||
              item.hasAttribute("disabled") ||
              rawText.includes("Sign in");

            return {
              rawText,
              ariaLabel,
              dataTestId,
              locked: isDisabled,
            };
          });
      });

      await page.keyboard.press("Escape").catch(() => {});

      return items.map((it) => {
        const parts = it.rawText.split(" | ");
        const label = parts[0] || it.rawText;
        const description = parts[1] || "";
        const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

        return {
          id,
          label,
          description,
          locked: it.locked,
          rawText: it.rawText,
        };
      });
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
          await page.waitForTimeout(500);

          if (modelSpec.selector) {
            const item = await page.$(modelSpec.selector);
            if (item) {
              await item.click();
              await page.waitForTimeout(500);
            }
          }
          await page.keyboard.press("Escape").catch(() => {});

          // Read the picker button's displayed label from live DOM
          const observedLabel =
            ((await pickerMatch.innerText()) || (await pickerMatch.getAttribute("aria-label")) || "")
              .trim();
          (session as any).observedModelLabel = observedLabel;
          (session as any).requestedModelId = modelId;
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
