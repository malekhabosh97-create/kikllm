import type { Page, CDPSession } from "playwright";
import { exec } from "node:child_process";

export class WindowManager {
  private cdpSession: CDPSession | null = null;

  constructor(private page: Page) {}

  private async getSession(): Promise<CDPSession> {
    if (!this.cdpSession) {
      this.cdpSession = await this.page.context().newCDPSession(this.page);
    }
    return this.cdpSession;
  }

  async showWindow(): Promise<void> {
    try {
      const session = await this.getSession();
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await this.page.bringToFront();
    } catch (e: any) {
      // CDP may fail if not supported on target
    }

    // Also bring window to front in Windows shell
    try {
      exec(`powershell -Command "$w = New-Object -ComObject WScript.Shell; $w.AppActivate('DeepSeek'); $w.AppActivate('Chrome'); $w.AppActivate('Edge')"` );
    } catch {}
  }

  async minimizeWindow(): Promise<void> {
    try {
      const session = await this.getSession();
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch (e: any) {
      console.warn("WindowManager.minimizeWindow failed:", e.message);
    }
  }
}
