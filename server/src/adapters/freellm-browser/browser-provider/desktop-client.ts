import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser, type Page } from "playwright";
export interface DesktopConnection { pid: number; port: number; cdpPort: number; token: string; }
export interface DesktopTab { id: string; targetId: string; provider: string; purpose?: string; label?:string; url: string; title: string; visible: boolean; }
export function desktopConnection(): DesktopConnection | null {
  try {
    const file = process.env.FREELLM_DESKTOP_CONNECTION_FILE || path.join(os.homedir(), ".paperclip", "freellm", "desktop.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isInteger(data.pid) || !Number.isInteger(data.port) || !Number.isInteger(data.cdpPort) || typeof data.token !== "string" || data.token.length < 32) return null;
    process.kill(data.pid, 0); return data;
  } catch { return null; }
}
export async function desktopRequest<T = unknown>(action: string, payload?: unknown): Promise<T> {
  const connection = desktopConnection();
  if (!connection) throw new Error("متصفح التطبيق غير متصل. افتح تطبيق FreeLLM Work لسطح المكتب.");
  const response = await fetch("http://127.0.0.1:" + connection.port + "/" + action, {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + connection.token, "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(45000)
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error || "تعذر تنفيذ عملية المتصفح");
  return result as T;
}
let browserPromise: Promise<Browser> | undefined;
let ownerPid: number | undefined;
export async function desktopBrowser(): Promise<Browser> {
  const connection = desktopConnection();
  if (!connection) throw new Error("متصفح التطبيق غير متصل");
  if (ownerPid !== connection.pid) { browserPromise = undefined; ownerPid = connection.pid; }
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.isConnected()) return browser;
    browserPromise = undefined;
  }
  browserPromise = chromium.connectOverCDP("http://127.0.0.1:" + connection.cdpPort, { timeout: 10000 });
  try { return await browserPromise; } catch (error) { browserPromise = undefined; throw error; }
}
export async function desktopPage(targetId: string): Promise<Page> {
  const browser = await desktopBrowser();
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const cdp = await context.newCDPSession(page);
        try {
          const info = await cdp.send("Target.getTargetInfo");
          if (info.targetInfo.targetId === targetId) return page;
        } finally { await cdp.detach().catch(() => {}); }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("تعذر الاتصال بالتبويب المدمج");
}
