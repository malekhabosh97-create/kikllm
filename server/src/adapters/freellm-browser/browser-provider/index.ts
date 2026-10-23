export * from "./types.js";
export * from "./site-adapter.js";
export * from "./chat-session.js";
export * from "./gemini-adapter.js";

import type { SiteAdapter } from "./types.js";
import { GeminiSiteAdapter } from "./gemini-adapter.js";

const adapters = new Map<string, SiteAdapter>();

export function getSiteAdapter(siteId: string): SiteAdapter {
  const normalized = siteId.toLowerCase();
  if (adapters.has(normalized)) {
    return adapters.get(normalized)!;
  }

  if (normalized === "gemini") {
    const adapter = new GeminiSiteAdapter();
    adapters.set(normalized, adapter);
    return adapter;
  }

  throw new Error(`Unsupported or uncalibrated site adapter: ${siteId}`);
}
