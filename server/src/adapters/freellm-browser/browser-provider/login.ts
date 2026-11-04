import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { GeminiSiteAdapter, DEFAULT_GEMINI_PROFILE_DIR, loadGeminiConfig } from "./gemini-adapter.js";
import { DeepSeekSiteAdapter, DEFAULT_DEEPSEEK_PROFILE_DIR, loadDeepSeekConfig } from "./deepseek-adapter.js";

async function promptEnter(promptText: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function runLogin(siteName: string) {
  console.log(`\n======================================================`);
  console.log(`[LOGIN] Manual Login Runner for site: ${siteName}`);
  console.log(`======================================================\n`);

  const calibrationDir = path.resolve(process.cwd(), "calibration", siteName);
  if (!fs.existsSync(calibrationDir)) {
    fs.mkdirSync(calibrationDir, { recursive: true });
  }

  const isDeepSeek = siteName.toLowerCase().includes("deepseek");
  const config = isDeepSeek ? loadDeepSeekConfig() : loadGeminiConfig();
  const profileDir = isDeepSeek ? DEFAULT_DEEPSEEK_PROFILE_DIR : DEFAULT_GEMINI_PROFILE_DIR;
  console.log(`[LOGIN] Target Profile Dir: ${profileDir}`);
  console.log(`[LOGIN] Launching headed Chrome...`);

  const adapter = isDeepSeek
    ? new DeepSeekSiteAdapter({
        config,
        profileDir,
        headless: false,
        embedded: false,
      })
    : new GeminiSiteAdapter({
        config,
        profileDir,
        headless: false,
        embedded: false,
      });

  const context = await (adapter as any).getContext();
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  console.log(`[LOGIN] Navigating to ${config.url}...`);
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

  let isBlocked = false;
  let isDone = false;

  // Background blocker monitor: checks all open tabs if Google blocks login
  const monitorTimer = setInterval(async () => {
    if (isDone || isBlocked) return;
    try {
      const activePages = context.pages().filter((p: any) => !p.isClosed());
      for (const p of activePages) {
        const currentUrl = p.url();
        const bodyText = await p.evaluate(() => document.body?.innerText || "").catch(() => "");

        if (
          bodyText.includes("This browser or app may not be secure") ||
          bodyText.includes("Couldn't sign you in") ||
          currentUrl.includes("/rejected")
        ) {
          isBlocked = true;
          clearInterval(monitorTimer);

          console.error(`\n[LOGIN] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
          console.error(`[LOGIN] STOP: Google blocked sign-in in this automated browser instance!`);
          console.error(`[LOGIN] Message detected: "This browser or app may not be secure"`);
          console.error(`[LOGIN] Per instruction: Stopping immediately with zero evasion.`);
          console.error(`[LOGIN] Recommendation: Switch provider to DeepSeek.`);
          console.error(`[LOGIN] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);

          const blockedScreenshot = path.join(calibrationDir, "login-blocked.png");
          await p.screenshot({ path: blockedScreenshot, fullPage: true }).catch(() => {});
          console.log(`[LOGIN] Saved blocker screenshot to: ${blockedScreenshot}`);

          await adapter.shutdown();
          process.exit(2);
        }
      }
    } catch {}
  }, 1500);

  console.log(`\n[LOGIN] ======================================================================`);
  console.log(`[LOGIN] Headed Chrome window is now OPEN.`);
  console.log(`[LOGIN] Please log in manually with your account (NO TIMEOUT).`);
  console.log(`[LOGIN] Complete sign-in and any 2FA verification in the Chrome window.`);
  console.log(`[LOGIN] ======================================================================\n`);

  // Wait indefinitely until the user presses Enter in the terminal
  await promptEnter(`[LOGIN] When you have finished logging in, press [Enter] here to verify: `);
  isDone = true;
  clearInterval(monitorTimer);

  if (page.isClosed()) {
    console.error(`[LOGIN] Browser window was closed before verification.`);
    process.exit(1);
  }

  console.log(`\n[LOGIN] Verifying authentication status on ${config.url}...`);
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const stillHasSignIn = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, a"));
    return elements.some(
      (el) =>
        (el as HTMLElement).innerText?.trim() === "Sign in" &&
        (el as HTMLElement).offsetParent !== null,
    );
  });

  const verifiedScreenshot = path.join(calibrationDir, stillHasSignIn ? "login-unverified.png" : "login-verified.png");
  await page.screenshot({ path: verifiedScreenshot, fullPage: true }).catch(() => {});

  if (!stillHasSignIn) {
    console.log(`\n[LOGIN] SUCCESS! Verified login: user is authenticated on Gemini.`);
    console.log(`[LOGIN] Screenshot saved to: ${verifiedScreenshot}`);
    await adapter.shutdown();
    process.exit(0);
  } else {
    console.error(`\n[LOGIN] FAILED: Still not signed in. The 'Sign in' button remains visible.`);
    console.log(`[LOGIN] Screenshot saved to: ${verifiedScreenshot}`);
    await adapter.shutdown();
    process.exit(1);
  }
}

const site = process.argv[2] || "gemini";
runLogin(site).catch(console.error);
