import http from "node:http";
import fs from "node:fs";
import path from "node:path";

function getToken(): string {
  if (process.env.FREELLM_DAEMON_TOKEN) return process.env.FREELLM_DAEMON_TOKEN;
  const tokenPaths = [
    "C:\\Users\\malek\\.freellm-browser-profile\\token.txt",
    path.resolve(process.cwd(), ".browser-profile/token.txt"),
    path.resolve(process.cwd(), "server/.browser-profile/token.txt"),
  ];
  for (const p of tokenPaths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return "";
}

const token = getToken();
const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;

async function sendChatRequest(payload: any, onChunk?: (chunk: any) => void): Promise<{ text: string; chunks: any[] }> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: "/chat",
        method: "POST",
        headers: {
          "x-freellm-auth": token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let fullText = "";
        const chunks: any[] = [];
        let buffer = "";

        res.on("data", (d) => {
          buffer += d.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                chunks.push(data);
                if (onChunk) onChunk(data);
                if (data.type === "token" || data.type === "text") {
                  fullText += data.text;
                } else if (data.type === "replace") {
                  fullText = data.text;
                }
              } catch {}
            }
          }
        });

        res.on("end", () => {
          resolve({ text: fullText, chunks });
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function getSessions(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: "/sessions",
        method: "GET",
        headers: {
          "x-freellm-auth": token,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function cancelGeneration(sessionId?: string, platform?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ sessionId, platform });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: "/cancel",
        method: "POST",
        headers: {
          "x-freellm-auth": token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log("=== STARTING PHASE 1 VERIFICATION SUITE ===");
  console.log(`Daemon Target: http://127.0.0.1:${daemonPort}`);
  console.log(`Auth Token present: ${Boolean(token)}`);

  // --- TEST 1: Baseline assistant counting test (consecutive turns) ---
  console.log("\n[TEST 1] Testing Consecutive Turns (Baseline Counting) on Session 'phase1-test-turn'...");
  const t1Session = "phase1-test-turn";
  
  console.log("Turn 1: Sending 'Say only the word: PINEAPPLE'");
  const r1 = await sendChatRequest({
    sessionId: t1Session,
    platform: "gemini",
    prompt: "Say only the word: PINEAPPLE. Do not explain.",
  });
  console.log(`Turn 1 Response: "${r1.text.trim()}"`);

  console.log("Turn 2: Sending 'Say only the word: WATERMELON'");
  const r2 = await sendChatRequest({
    sessionId: t1Session,
    platform: "gemini",
    prompt: "Say only the word: WATERMELON. Do not explain.",
  });
  console.log(`Turn 2 Response: "${r2.text.trim()}"`);

  const turn2Clean = !r2.text.toLowerCase().includes("pineapple");
  console.log(`[TEST 1 RESULT] Turn 2 does not include Turn 1 content? ${turn2Clean ? "PASS (Isolated Turn)" : "FAIL (Contaminated)"}`);

  // --- TEST 2: Multi-agent isolation test ---
  console.log("\n[TEST 2] Testing Multi-Agent Isolation...");
  const t2Session1 = "agent-arch-01";
  const t2Session2 = "agent-dev-02";

  console.log(`Initializing Agent 1 (${t2Session1}) on Gemini with System Prompt...`);
  await sendChatRequest({
    sessionId: t2Session1,
    platform: "gemini",
    systemPrompt: "You are the Lead System Architect.",
    prompt: "Acknowledge in 5 words.",
  });

  console.log(`Initializing Agent 2 (${t2Session2}) on Gemini with System Prompt...`);
  await sendChatRequest({
    sessionId: t2Session2,
    platform: "gemini",
    systemPrompt: "You are the Senior QA Engineer.",
    prompt: "Acknowledge in 5 words.",
  });

  const sessions = await getSessions();
  console.log("Active Sessions in Daemon:", sessions);
  const hasSession1 = sessions.some((s) => s.sessionId === t2Session1);
  const hasSession2 = sessions.some((s) => s.sessionId === t2Session2);
  console.log(`[TEST 2 RESULT] Both distinct sessions tracked: ${hasSession1 && hasSession2 ? "PASS" : "FAIL"}`);

  // --- TEST 3: Cancellation test ---
  console.log("\n[TEST 3] Testing Generation Cancellation...");
  const t3Session = "phase1-test-cancel";
  let streamEndedBeforeComplete = false;

  const cancelPromise = new Promise(async (resolve) => {
    // Wait 1.5 seconds then cancel
    await new Promise((r) => setTimeout(r, 1500));
    console.log("Sending cancel request for session:", t3Session);
    const cancelRes = await cancelGeneration(t3Session);
    console.log("Cancel response:", cancelRes);
    resolve(cancelRes);
  });

  const generatePromise = sendChatRequest(
    {
      sessionId: t3Session,
      platform: "gemini",
      prompt: "Write a 500-word essay about the history of quantum computing. Write slowly and thoroughly.",
    },
    (chunk) => {
      // stream chunk
    }
  );

  const [cancelRes, genResult] = await Promise.all([cancelPromise, generatePromise]);
  console.log(`Cancelled response length: ${genResult.text.length} chars (Shortened output)`);
  console.log(`[TEST 3 RESULT] Cancel successfully received: ${cancelRes.success ? "PASS" : "FAIL"}`);

  console.log("\n=== ALL PHASE 1 TESTS COMPLETE ===");
}

runTests().catch((err) => {
  console.error("Test Suite Failed with error:", err);
  process.exit(1);
});
