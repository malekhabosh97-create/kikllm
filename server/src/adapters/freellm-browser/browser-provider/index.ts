export * from "./types.js";
export * from "./site-adapter.js";
export * from "./chat-session.js";
export * from "./gemini-adapter.js";
export * from "./deepseek-adapter.js";
export * from "./model-router.js";
import { globalModelRouter } from "./model-router.js";
export const getSiteAdapter = (siteId: string) => globalModelRouter.getAdapter(siteId);
