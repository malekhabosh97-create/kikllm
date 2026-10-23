import type { ChatSession, LiveModelInfo, SiteAdapter } from "./types.js";
import { GeminiSiteAdapter } from "./gemini-adapter.js";
import { DeepSeekSiteAdapter } from "./deepseek-adapter.js";

export interface RoutedModel {
  modelId: string;
  provider: string;
  label: string;
  description?: string;
  locked?: boolean;
}

export class ModelRouter {
  private adapters = new Map<string, SiteAdapter>();
  private activeSessions = new Map<string, ChatSession>();

  constructor() {
    this.registerAdapter("gemini", new GeminiSiteAdapter());
    this.registerAdapter("deepseek", new DeepSeekSiteAdapter());
  }

  public registerAdapter(siteId: string, adapter: SiteAdapter): void {
    this.adapters.set(siteId.toLowerCase(), adapter);
  }

  public getAdapter(siteId: string): SiteAdapter {
    const adapter = this.adapters.get(siteId.toLowerCase());
    if (!adapter) {
      throw new Error(`No SiteAdapter registered for site: '${siteId}'`);
    }
    return adapter;
  }

  /**
   * Resolves a requested model or provider identifier to the corresponding site adapter
   * and target model ID within that adapter.
   */
  public resolveRoute(modelOrSite: string): { siteId: string; modelId: string } {
    const normalized = (modelOrSite || "").trim().toLowerCase();

    if (normalized.startsWith("deepseek") || normalized === "r1" || normalized === "v3") {
      const modelId =
        normalized.includes("reasoner") || normalized.includes("r1")
          ? "deepseek-reasoner"
          : "deepseek-chat";
      return { siteId: "deepseek", modelId };
    }

    if (normalized.startsWith("gemini")) {
      let modelId = normalized;
      if (normalized === "gemini") {
        modelId = "gemini-flash";
      }
      return { siteId: "gemini", modelId };
    }

    // Default fallback: if matching a registered site
    if (this.adapters.has(normalized)) {
      return { siteId: normalized, modelId: normalized };
    }

    // Default provider: deepseek
    return { siteId: "deepseek", modelId: normalized || "deepseek-chat" };
  }

  /**
   * Returns a ChatSession for the requested model/provider.
   * If a sessionKey is given and an open session already exists, reuses it.
   */
  public async getSession(
    modelOrSite: string,
    options?: { sessionKey?: string },
  ): Promise<ChatSession> {
    const sessionKey = options?.sessionKey;
    if (sessionKey && this.activeSessions.has(sessionKey)) {
      const existing = this.activeSessions.get(sessionKey)!;
      return existing;
    }

    const { siteId, modelId } = this.resolveRoute(modelOrSite);
    const adapter = this.getAdapter(siteId);
    const session = await adapter.newChat(modelId);

    if (sessionKey) {
      this.activeSessions.set(sessionKey, session);
    }

    return session;
  }

  /**
   * Lists all available live models across all registered site adapters.
   */
  public async listModels(): Promise<RoutedModel[]> {
    const results: RoutedModel[] = [];

    for (const [siteId, adapter] of this.adapters.entries()) {
      try {
        const live = await adapter.listModels();
        for (const m of live) {
          results.push({
            modelId: m.id,
            provider: siteId,
            label: m.label,
            description: m.description,
            locked: m.locked,
          });
        }
      } catch (err: any) {
        console.warn(`[ModelRouter] Could not fetch models for site ${siteId}:`, err.message);
      }
    }

    return results;
  }

  public async shutdownAll(): Promise<void> {
    for (const [siteId, adapter] of this.adapters.entries()) {
      try {
        await adapter.shutdown();
      } catch (e: any) {
        console.warn(`[ModelRouter] Error shutting down ${siteId}:`, e.message);
      }
    }
    this.activeSessions.clear();
  }
}

// Global singleton instance
export const globalModelRouter = new ModelRouter();
