import fs from "node:fs";
import path from "node:path";
import { GeminiSiteAdapter, DEFAULT_GEMINI_PROFILE_DIR, loadGeminiConfig } from "./gemini-adapter.js";
import type { ReplyResult } from "./types.js";

async function runCalibration(siteName: string) {
  console.log(`\n======================================================`);
  console.log(`[CALIBRATE] Starting Phase 1 Calibration (1a-1f) for: ${siteName}`);
  console.log(`======================================================\n`);

  const calibrationDir = path.resolve(process.cwd(), "calibration", siteName);
  if (!fs.existsSync(calibrationDir)) {
    fs.mkdirSync(calibrationDir, { recursive: true });
  }

  const scratchDir = path.resolve(process.cwd(), "..", "scratch");
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  const testFilePath = path.join(scratchDir, "test-attachment.txt");
  fs.writeFileSync(
    testFilePath,
    "Phase 1 Calibration Test File\nVerification-Code: CALIBRATE-VERIFIED-12345\n",
    "utf8",
  );

  const config = loadGeminiConfig();
  console.log(`[CALIBRATE] Profile dir: ${DEFAULT_GEMINI_PROFILE_DIR}`);
  console.log(`[CALIBRATE] Config loaded: ${config.name} (${config.url})`);

  const adapter = new GeminiSiteAdapter({
    config,
    profileDir: DEFAULT_GEMINI_PROFILE_DIR,
    headless: false, // headed window for user visibility and login
  });

  const report: {
    site: string;
    timestamp: string;
    profileDir: string;
    loginCheck: string;
    matchedSelectors: Record<string, string>;
    modelSelectionTest?: string;
    attachmentTest?: string;
    sendTest: string;
    replyText?: string;
    blocker?: string;
    durationMs: number;
    screenshots: string[];
  } = {
    site: siteName,
    timestamp: new Date().toISOString(),
    profileDir: DEFAULT_GEMINI_PROFILE_DIR,
    loginCheck: "pending",
    matchedSelectors: {},
    sendTest: "pending",
    durationMs: 0,
    screenshots: [],
  };

  const startTime = Date.now();

  try {
    console.log(`[CALIBRATE] Step 1: Checking site health and authentication status...`);
    const health = await adapter.health();
    console.log(`[CALIBRATE] Initial health:`, health);

    const context = await (adapter as any).getContext();
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());

    if (!page.url().includes("gemini.google.com")) {
      console.log(`[CALIBRATE] Navigating to ${config.url}...`);
      await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2000);
    }

    const initialScreenshot = path.join(calibrationDir, "01-initial-landing.png");
    await page.screenshot({ path: initialScreenshot, fullPage: true }).catch(() => {});
    report.screenshots.push(initialScreenshot);

    // Check if user is actually signed in to a Google account
    const hasSignInBtn = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("button, a"));
      return elements.some(
        (el) =>
          (el as HTMLElement).innerText?.trim() === "Sign in" &&
          (el as HTMLElement).offsetParent !== null,
      );
    });

    let isLoggedIn = health.isLoggedIn && !hasSignInBtn;
    let loginBlocked = false;

    if (!isLoggedIn) {
      console.log(`\n[CALIBRATE] ----------------------------------------------------------------`);
      console.log(`[CALIBRATE] User is not signed in to a Google account.`);
      console.log(`[CALIBRATE] Note: Basic chat works anonymously, but file attachments and`);
      console.log(`[CALIBRATE] advanced models require signing in.`);
      console.log(`[CALIBRATE] Attempting to navigate to Google sign-in...`);
      console.log(`[CALIBRATE] ----------------------------------------------------------------\n`);

      const signinBtn = await page.$('button:has-text("Sign in"), a:has-text("Sign in")');
      if (signinBtn) {
        await signinBtn.click().catch(() => {});
      } else {
        await page.goto(
          "https://accounts.google.com/ServiceLogin?service=mail&continue=https://gemini.google.com/app",
          { waitUntil: "domcontentloaded" },
        );
      }

      const loginPromptScreenshot = path.join(calibrationDir, "02-login-prompt.png");
      await page.screenshot({ path: loginPromptScreenshot, fullPage: true }).catch(() => {});
      report.screenshots.push(loginPromptScreenshot);

      console.log(`[CALIBRATE] Headed Chrome window is open. Waiting up to 120s for manual login...`);
      const loginStart = Date.now();

      while (Date.now() - loginStart < 120000) {
        if (page.isClosed()) {
          throw new Error("Browser window was closed during login.");
        }

        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");

        // CRITICAL: Check if Google explicitly blocks login in automated browser
        if (
          bodyText.includes("This browser or app may not be secure") ||
          bodyText.includes("Couldn't sign you in") ||
          currentUrl.includes("/rejected")
        ) {
          console.error(`\n[CALIBRATE] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
          console.error(`[CALIBRATE] GOOGLE BLOCKED SIGN-IN: Automated browser flagged as insecure.`);
          console.error(`[CALIBRATE] Detected message: "This browser or app may not be secure"`);
          console.error(`[CALIBRATE] Per user instruction 1: STOPPING IMMEDIATELY without evasion.`);
          console.error(`[CALIBRATE] Recommendation: Switch provider to DeepSeek.`);
          console.error(`[CALIBRATE] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);

          const blockedScreenshot = path.join(calibrationDir, "03-login-blocked.png");
          await page.screenshot({ path: blockedScreenshot, fullPage: true }).catch(() => {});
          report.screenshots.push(blockedScreenshot);
          report.loginCheck = "blocked: Google rejected automated browser login";
          report.blocker = "login_blocked";
          loginBlocked = true;
          break;
        }

        // Check if sign-in finished and we returned to gemini.google.com without "Sign in" button
        if (currentUrl.includes("gemini.google.com")) {
          const stillHasSignIn = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("button, a"));
            return elements.some(
              (el) =>
                (el as HTMLElement).innerText?.trim() === "Sign in" &&
                (el as HTMLElement).offsetParent !== null,
            );
          });

          if (!stillHasSignIn) {
            isLoggedIn = true;
            console.log(`[CALIBRATE] Login detected successfully!`);
            const loginSuccessScreenshot = path.join(calibrationDir, "03-login-success.png");
            await page.screenshot({ path: loginSuccessScreenshot, fullPage: true }).catch(() => {});
            report.screenshots.push(loginSuccessScreenshot);
            report.loginCheck = "passed";
            break;
          }
        }

        await page.waitForTimeout(2000);
      }

      if (loginBlocked) {
        fs.writeFileSync(
          path.join(calibrationDir, "calibration-report.json"),
          JSON.stringify(report, null, 2),
        );
        console.log(`[CALIBRATE] Exiting: Google sign-in blocked by anti-bot.`);
        process.exit(2);
      }

      if (!isLoggedIn) {
        console.warn(`[CALIBRATE] Login was not completed within 120s.`);
        console.warn(`[CALIBRATE] Proceeding with unauthenticated mode (Flash-Lite / standard turn).`);
        report.loginCheck = "timeout_unauthenticated";
        await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
      }
    } else {
      console.log(`[CALIBRATE] Authenticated session confirmed.`);
      report.loginCheck = "already_logged_in";
    }

    // Step 2: Test selector fallbacks on live DOM
    console.log(`[CALIBRATE] Step 2: Testing selector fallbacks on live DOM...`);
    for (const [key, selectors] of Object.entries({
      chatInput: config.chatInput,
      sendButton: config.sendButton,
      lastMessage: config.lastMessage,
      attachButton: config.attachButton,
      modelMenu: config.modelMenu || [],
    })) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            report.matchedSelectors[key] = sel;
            console.log(`[CALIBRATE] Matched selector for '${key}': ${sel}`);
            break;
          }
        } catch {}
      }
    }

    // Step 3: Phase 1f - Test Model Selection
    console.log(`[CALIBRATE] Step 3 (Phase 1f): Creating new ChatSession with model selection...`);
    const targetModel = isLoggedIn ? "gemini-flash" : "gemini-flash-lite";
    const session = await adapter.newChat(targetModel);
    const sessionPage = (session as any).getPage?.() || page;
    report.modelSelectionTest = `requested: ${targetModel}`;

    // Step 4: Phase 1e - Test File Attachment
    console.log(`[CALIBRATE] Step 4 (Phase 1e): Testing file attachment (${testFilePath})...`);
    try {
      await session.attach([testFilePath]);
      console.log(`[CALIBRATE] File attached successfully!`);
      report.attachmentTest = "passed";
      const fileAttachedScreenshot = path.join(calibrationDir, "04-file-attached.png");
      await sessionPage.screenshot({ path: fileAttachedScreenshot, fullPage: true }).catch(() => {});
      report.screenshots.push(fileAttachedScreenshot);
    } catch (attachErr: any) {
      console.warn(`[CALIBRATE] Attachment test notice:`, attachErr.message);
      report.attachmentTest = `skipped_or_failed: ${attachErr.message}`;
    }

    // Step 5: Send prompt and wait for reply
    console.log(`[CALIBRATE] Step 5: Sending test prompt and waiting for reply...`);
    const prompt = report.attachmentTest === "passed"
      ? "Reply with exactly the word OK"
      : "reply with exactly the word OK";

    await session.send(prompt);
    const promptSentScreenshot = path.join(calibrationDir, "05-prompt-sent.png");
    await sessionPage.screenshot({ path: promptSentScreenshot, fullPage: true }).catch(() => {});
    report.screenshots.push(promptSentScreenshot);

    console.log(`[CALIBRATE] Step 6: Waiting for completion (2500ms debounce + stop button)...`);
    const replyResult: ReplyResult = await session.waitForReply({
      timeoutMs: 60000,
      onChunk: (chunk) => {
        process.stdout.write(chunk);
      },
    });

    console.log(`\n[CALIBRATE] Reply status:`, replyResult.status);
    console.log(`[CALIBRATE] Reply text: "${replyResult.text}"`);

    const finalScreenshot = path.join(calibrationDir, "06-reply-received.png");
    await sessionPage.screenshot({ path: finalScreenshot, fullPage: true }).catch(() => {});
    report.screenshots.push(finalScreenshot);

    report.replyText = replyResult.text;
    Object.assign(report.matchedSelectors, (session as any).matchedSelectors || {});

    if (replyResult.status === "ok") {
      const isOk = /\bOK\b/i.test(replyResult.text);
      if (isOk) {
        console.log(`\n[CALIBRATE] SUCCESS! Reply contains 'OK'. Calibration PASSED.`);
        report.sendTest = "passed";
      } else {
        console.warn(`\n[CALIBRATE] Completed with text: "${replyResult.text}"`);
        report.sendTest = "passed_with_text";
      }
    } else {
      console.error(`\n[CALIBRATE] FAILED with status: ${replyResult.status}, blocker: ${replyResult.blocker}`);
      report.sendTest = `failed: ${replyResult.status}`;
      report.blocker = replyResult.blocker;
    }

    report.durationMs = Date.now() - startTime;
    fs.writeFileSync(
      path.join(calibrationDir, "calibration-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`[CALIBRATE] Calibration report saved at: ${path.join(calibrationDir, "calibration-report.json")}`);
  } catch (err: any) {
    console.error(`[CALIBRATE] Fatal error during calibration:`, err);
    report.sendTest = `error: ${err.message}`;
    report.durationMs = Date.now() - startTime;
    fs.writeFileSync(
      path.join(calibrationDir, "calibration-report.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    await new Promise((r) => setTimeout(r, 2000));
    await adapter.shutdown();
    console.log(`[CALIBRATE] Calibration finished.`);
  }
}

const site = process.argv[2] || "gemini";
runCalibration(site).catch(console.error);
