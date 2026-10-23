import fs from "node:fs";
import path from "node:path";
import { GeminiSiteAdapter, DEFAULT_GEMINI_PROFILE_DIR, loadGeminiConfig } from "./gemini-adapter.js";
import { DeepSeekSiteAdapter, DEFAULT_DEEPSEEK_PROFILE_DIR, loadDeepSeekConfig } from "./deepseek-adapter.js";
import type { ReplyResult, LiveModelInfo } from "./types.js";

type StepStatus = "PASS" | "FAIL" | "SKIPPED";

interface StepResult {
  step: string;
  status: StepStatus;
  details: string;
  evidence?: any;
}

async function runCalibration(siteName: string) {
  console.log(`\n======================================================`);
  console.log(`[CALIBRATE] Strict Multi-Step Calibration for: ${siteName}`);
  console.log(`======================================================\n`);

  const calibrationDir = path.resolve(process.cwd(), "calibration", siteName);
  if (!fs.existsSync(calibrationDir)) {
    fs.mkdirSync(calibrationDir, { recursive: true });
  }

  const scratchDir = path.resolve(process.cwd(), "..", "scratch");
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  const SECRET_LINE = "CALIBRATE_SECRET_TOKEN_VERIFY_49172";
  const testFilePath = path.join(scratchDir, "calibration-sample.txt");
  fs.writeFileSync(
    testFilePath,
    `${SECRET_LINE}\nThis file is used to prove attachment reading comprehension.\n`,
    "utf8",
  );

  const isDeepSeek = siteName.toLowerCase().includes("deepseek");
  const config = isDeepSeek ? loadDeepSeekConfig() : loadGeminiConfig();
  const profileDir = isDeepSeek ? DEFAULT_DEEPSEEK_PROFILE_DIR : DEFAULT_GEMINI_PROFILE_DIR;
  console.log(`[CALIBRATE] Profile dir: ${profileDir}`);
  console.log(`[CALIBRATE] Config loaded: ${config.name} (${config.url})`);

  const adapter = isDeepSeek
    ? new DeepSeekSiteAdapter({
        config,
        profileDir,
        headless: false,
      })
    : new GeminiSiteAdapter({
        config,
        profileDir,
        headless: false,
      });

  const steps: Record<string, StepResult> = {};
  const recordStep = (name: string, status: StepStatus, details: string, evidence?: any) => {
    steps[name] = { step: name, status, details, evidence };
    const marker = status === "PASS" ? "✔ PASS" : status === "FAIL" ? "✘ FAIL" : "⚠ SKIPPED";
    console.log(`[CALIBRATE] [${marker}] ${name}: ${details}`);
  };

  const screenshots: string[] = [];
  const matchedSelectors: Record<string, string> = {};
  const startTime = Date.now();

  try {
    // -------------------------------------------------------------
    // Step 1: Site Health & Authentication
    // -------------------------------------------------------------
    console.log(`\n--- Step 1: Health & Authentication Verification ---`);
    const health = await adapter.health();
    const context = await (adapter as any).getContext();
    const pages = context.pages();
    const page = pages.find((p: any) => !p.isClosed()) || (await context.newPage());

    const initialScreenshot = path.join(calibrationDir, "01-health-landing.png");
    await page.screenshot({ path: initialScreenshot, fullPage: true }).catch(() => {});
    screenshots.push(initialScreenshot);

    const hasSignInBtn = await page.evaluate(() => {
      const isLoginUrl = window.location.href.includes("/sign_in") || window.location.href.includes("/login");
      if (isLoginUrl) return true;

      const elements = Array.from(document.querySelectorAll("button, a, div"));
      return elements.some(
        (el) =>
          ((el as HTMLElement).innerText?.trim() === "Sign in" ||
            (el as HTMLElement).innerText?.trim() === "Log in") &&
          (el as HTMLElement).offsetParent !== null,
      );
    });

    const isAuthenticated = health.ok && health.isLoggedIn && !hasSignInBtn;
    if (isAuthenticated) {
      recordStep(
        "authentication",
        "PASS",
        `User is authenticated. 'Sign in' button is absent on ${page.url()}`,
      );
    } else {
      recordStep(
        "authentication",
        "FAIL",
        `User is not logged in. 'Sign in' button is visible on ${page.url()}. Run 'npm run login' to authenticate manually.`,
      );
    }

    // -------------------------------------------------------------
    // Step 2: Live DOM Selector Fallbacks
    // -------------------------------------------------------------
    console.log(`\n--- Step 2: Live DOM Selectors Fallback Test ---`);
    let missingSelectors: string[] = [];
    for (const [key, selectors] of Object.entries({
      chatInput: config.chatInput,
      sendButton: config.sendButton,
      lastMessage: config.lastMessage,
      attachButton: config.attachButton,
      modelMenu: config.modelMenu || [],
    })) {
      let found = false;
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            matchedSelectors[key] = sel;
            found = true;
            break;
          }
        } catch {}
      }
      if (!found) {
        missingSelectors.push(key);
      }
    }

    if (missingSelectors.length === 0) {
      recordStep("selectors_fallback", "PASS", "All required selector groups matched live DOM elements", matchedSelectors);
    } else {
      recordStep("selectors_fallback", "FAIL", `Missing live selector matches for: ${missingSelectors.join(", ")}`, matchedSelectors);
    }

    // -------------------------------------------------------------
    // Step 3: Model Listing via Live UI (Requirement 3)
    // -------------------------------------------------------------
    console.log(`\n--- Step 3: Live Model Listing (listModels) ---`);
    let liveModels: LiveModelInfo[] = [];
    try {
      liveModels = await adapter.listModels();
      if (liveModels.length > 0) {
        recordStep(
          "model_listing",
          "PASS",
          `Discovered ${liveModels.length} models in live picker menu`,
          liveModels,
        );
      } else {
        recordStep(
          "model_listing",
          "FAIL",
          "listModels() returned 0 models from live UI picker",
        );
      }
    } catch (e: any) {
      recordStep("model_listing", "FAIL", `listModels() threw error: ${e.message}`);
    }

    // -------------------------------------------------------------
    // Step 4: Model Selection & Verification (Requirement 3)
    // -------------------------------------------------------------
    console.log(`\n--- Step 4: Model Selection & Verification ---`);
    // Determine which model to test based on what live UI actually showed
    const targetModelKey = isDeepSeek
      ? "deepseek-chat"
      : isAuthenticated
      ? "gemini-flash"
      : "gemini-flash-lite";
    let session: any;
    try {
      session = await adapter.newChat(targetModelKey);
      const observedLabel: string = session.observedModelLabel || "";
      const expectedLabel = config.modelOptions?.[targetModelKey]?.label || targetModelKey;

      if (observedLabel.toLowerCase().includes(expectedLabel.toLowerCase())) {
        recordStep(
          "model_selection",
          "PASS",
          `Requested '${targetModelKey}', UI actively displays observed label '${observedLabel}'`,
          { requested: targetModelKey, observed: observedLabel },
        );
      } else if (observedLabel) {
        recordStep(
          "model_selection",
          "FAIL",
          `Requested '${targetModelKey}' (${expectedLabel}), but UI displays observed label '${observedLabel}'`,
          { requested: targetModelKey, expected: expectedLabel, observed: observedLabel },
        );
      } else {
        recordStep(
          "model_selection",
          "FAIL",
          `Could not observe model label from live UI for '${targetModelKey}'`,
        );
      }
    } catch (e: any) {
      recordStep("model_selection", "FAIL", `newChat with model threw error: ${e.message}`);
    }

    const sessionPage = session?.getPage?.() || page;

    // -------------------------------------------------------------
    // Step 5: File Attachment & Chip Verification (Requirement 4)
    // -------------------------------------------------------------
    console.log(`\n--- Step 5: File Attachment & Chip Verification ---`);
    let attachmentPassed = false;
    if (session) {
      try {
        await session.attach([testFilePath]);
        attachmentPassed = true;
        recordStep(
          "file_attachment",
          "PASS",
          `Attachment chip for '${path.basename(testFilePath)}' confirmed in DOM before sending`,
        );
        const attachedScreenshot = path.join(calibrationDir, "04-file-attached.png");
        await sessionPage.screenshot({ path: attachedScreenshot, fullPage: true }).catch(() => {});
        screenshots.push(attachedScreenshot);
      } catch (attachErr: any) {
        recordStep(
          "file_attachment",
          "FAIL",
          `Attachment failed: ${attachErr.message}`,
        );
      }
    } else {
      recordStep("file_attachment", "SKIPPED", "Skipped because session initialization failed");
    }

    // -------------------------------------------------------------
    // Step 6: Comprehension Proof & Completion Detection (Requirement 4)
    // -------------------------------------------------------------
    console.log(`\n--- Step 6: Prompt Execution & Proof of Comprehension ---`);
    let replyResult: ReplyResult | null = null;
    if (session) {
      try {
        const prompt = attachmentPassed
          ? `What is the first line of the attached file? Quote it exactly, then say OK.`
          : `reply with exactly the word OK`;

        await session.send(prompt);
        const promptScreenshot = path.join(calibrationDir, "05-prompt-sent.png");
        await sessionPage.screenshot({ path: promptScreenshot, fullPage: true }).catch(() => {});
        screenshots.push(promptScreenshot);

        replyResult = await session.waitForReply({
          timeoutMs: 60000,
          onChunk: (chunk: string) => {
            process.stdout.write(chunk);
          },
        });

        if (!replyResult) {
          throw new Error("No reply result returned from session.");
        }

        console.log(`\n[CALIBRATE] Reply received: "${replyResult.text}"`);
        const replyScreenshot = path.join(calibrationDir, "06-reply-received.png");
        await sessionPage.screenshot({ path: replyScreenshot, fullPage: true }).catch(() => {});
        screenshots.push(replyScreenshot);

        if (replyResult.status === "ok") {
          recordStep("turn_completion", "PASS", "Turn completed with stable text and stop button absence");
        } else {
          recordStep("turn_completion", "FAIL", `Turn status was '${replyResult.status}', blocker: ${replyResult.blocker}`);
        }

        // Verify content comprehension
        if (attachmentPassed) {
          if (replyResult.text.includes(SECRET_LINE) && /\bOK\b/i.test(replyResult.text)) {
            recordStep(
              "comprehension_proof",
              "PASS",
              `Model quoted exact first line '${SECRET_LINE}' and confirmed 'OK'`,
            );
          } else {
            recordStep(
              "comprehension_proof",
              "FAIL",
              `Model response did not quote the first line '${SECRET_LINE}'. Reply was: "${replyResult.text}"`,
            );
          }
        } else {
          if (/\bOK\b/i.test(replyResult.text)) {
            recordStep(
              "comprehension_proof",
              "FAIL",
              "Model replied 'OK', but file attachment was NOT verified, so attachment comprehension could not be proven.",
            );
          } else {
            recordStep("comprehension_proof", "FAIL", `Unexpected response: "${replyResult.text}"`);
          }
        }
      } catch (err: any) {
        recordStep("turn_completion", "FAIL", `Error executing turn: ${err.message}`);
        recordStep("comprehension_proof", "FAIL", `Turn failed: ${err.message}`);
      }
    } else {
      recordStep("turn_completion", "SKIPPED", "Session was not available");
      recordStep("comprehension_proof", "SKIPPED", "Session was not available");
    }

    // -------------------------------------------------------------
    // Overall Evaluation (Requirement 2)
    // -------------------------------------------------------------
    console.log(`\n======================================================`);
    console.log(`[CALIBRATE] STEP EVALUATION SUMMARY:`);
    console.log(`======================================================`);

    const allSteps = Object.values(steps);
    for (const s of allSteps) {
      console.log(`- [${s.status}] ${s.step}: ${s.details}`);
    }

    const overallPassed = allSteps.length > 0 && allSteps.every((s) => s.status === "PASS");
    const overallStatus = overallPassed ? "PASSED" : "FAILED (NOT PASSED)";

    console.log(`\nOVERALL CALIBRATION RESULT: ${overallStatus}`);
    console.log(`======================================================\n`);

    const finalReport = {
      site: siteName,
      timestamp: new Date().toISOString(),
      profileDir: DEFAULT_GEMINI_PROFILE_DIR,
      overallStatus,
      steps,
      matchedSelectors: Object.assign(matchedSelectors, session?.matchedSelectors || {}),
      liveModels,
      replyText: replyResult?.text || "",
      durationMs: Date.now() - startTime,
      screenshots,
    };

    fs.writeFileSync(
      path.join(calibrationDir, "calibration-report.json"),
      JSON.stringify(finalReport, null, 2),
    );
    console.log(`Report written to: ${path.join(calibrationDir, "calibration-report.json")}`);

    await adapter.shutdown();
    process.exit(overallPassed ? 0 : 1);
  } catch (fatal: any) {
    console.error(`[CALIBRATE] Fatal error:`, fatal);
    await adapter.shutdown();
    process.exit(1);
  }
}

const site = process.argv[2] || "gemini";
runCalibration(site).catch(console.error);
