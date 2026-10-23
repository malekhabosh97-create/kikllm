import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BasePlaywrightSiteAdapter, type SiteAdapterOptions } from "./site-adapter.js";
import type { SiteConfig, ChatSession, LiveModelInfo } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadDeepSeekConfig(): SiteConfig {
  const configPath = path.resolve(__dirname, "sites", "deepseek.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as SiteConfig;
}

export const DEFAULT_DEEPSEEK_PROFILE_DIR =
  process.env.FREELLM_DEEPSEEK_PROFILE_DIR || "C:\\Users\\malek\\.freellm-deepseek-profile";

export class DeepSeekSiteAdapter extends BasePlaywrightSiteAdapter {
  constructor(options?: Partial<SiteAdapterOptions>) {
    const config = options?.config || loadDeepSeekConfig();
    const profileDir = options?.profileDir || DEFAULT_DEEPSEEK_PROFILE_DIR;
    const headless = options?.headless ?? false;

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

      if (!page.url().includes("deepseek.com")) {
        await page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000);
      }

      // Check if DeepThink toggle is present in live DOM
      const deepThinkToggle = await page.$(
        "button:has-text('DeepThink'), div:has-text('DeepThink'), [aria-label*='DeepThink']",
      );

      const models: LiveModelInfo[] = [
        {
          id: "deepseek-chat",
          label: "DeepSeek-V3",
          description: "Default fast conversational model",
          locked: false,
          rawText: "DeepSeek-V3",
        },
      ];

      if (deepThinkToggle) {
        models.push({
          id: "deepseek-reasoner",
          label: "DeepSeek-R1 (DeepThink)",
          description: "Reasoning model with thinking process",
          locked: false,
          rawText: "DeepThink (R1)",
        });
      }

      return models;
    });
  }

  override async newChat(modelId?: string): Promise<ChatSession> {
    const session = await super.newChat(modelId);
    const page = (session as any).getPage?.();

    const targetModel = modelId || "deepseek-chat";
    const wantsR1 = targetModel.includes("reasoner") || targetModel.includes("r1");

    if (page) {
      try {
        const deepThinkBtn = await page.$(
          "button:has-text('DeepThink'), div:has-text('DeepThink'), [aria-label*='DeepThink']",
        );

        if (deepThinkBtn) {
          const isCurrentlyActive = await deepThinkBtn.evaluate((el: any) => {
            return (
              el.getAttribute("aria-checked") === "true" ||
              el.classList.contains("active") ||
              el.classList.contains("selected") ||
              el.querySelector(".selected, .active") !== null
            );
          });

          if (isCurrentlyActive !== wantsR1) {
            await deepThinkBtn.click();
            await page.waitForTimeout(400);
          }

          const observedLabel = wantsR1 ? "DeepSeek-R1 (DeepThink ON)" : "DeepSeek-V3 (DeepThink OFF)";
          (session as any).observedModelLabel = observedLabel;
          (session as any).requestedModelId = targetModel;
        } else {
          (session as any).observedModelLabel = "DeepSeek-V3";
          (session as any).requestedModelId = targetModel;
        }
      } catch (e: any) {
        console.warn("[DeepSeekSiteAdapter] Could not toggle model:", e.message);
      }
    }

    return session;
  }
}
