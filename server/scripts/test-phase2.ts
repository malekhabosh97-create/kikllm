import http from "node:http";

async function runPhase2Verification() {
  console.log("=== STARTING PHASE 2 VERIFICATION ===");
  const agentId = "bb7515be-ffac-42bf-8fb7-12aa8c0fce47"; // CEO - Gemini Argon 4
  const serverPort = 3100;

  console.log(`\n1. Checking existing history for agent: ${agentId}`);
  const hist1 = await fetch(`http://127.0.0.1:${serverPort}/api/browser/agent-chat/history?agentId=${agentId}`).then((r) => r.json());
  console.log("Existing history count:", hist1.messages?.length, "Issue ID:", hist1.issueId);

  console.log("\n2. Sending chat message via /api/browser/agent-chat...");
  const prompt = "Please state in exactly 4 words: CEO IS READY NOW.";
  
  const streamResult = await new Promise<{ text: string; events: any[] }>((resolve, reject) => {
    const postData = JSON.stringify({ agentId, prompt });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: serverPort,
        path: "/api/browser/agent-chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let fullText = "";
        const events: any[] = [];
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
                events.push(data);
                if (data.type === "token" || data.type === "text") {
                  fullText += data.text;
                  process.stdout.write(data.text);
                } else if (data.type === "replace") {
                  fullText = data.text;
                }
              } catch {}
            }
          }
        });

        res.on("end", () => {
          resolve({ text: fullText, events });
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  console.log("\n\nStream completed. Full text received:", streamResult.text.trim());

  console.log("\n3. Verifying that the turns are now permanently stored in Paperclip DB...");
  const hist2 = await fetch(`http://127.0.0.1:${serverPort}/api/browser/agent-chat/history?agentId=${agentId}`).then((r) => r.json());
  console.log("Updated history count from DB:", hist2.messages?.length);
  console.log("Persisted Messages in PostgreSQL:");
  for (const msg of hist2.messages || []) {
    console.log(` - [${msg.sender.toUpperCase()}]: ${msg.text.slice(0, 100)}... (${msg.timestamp})`);
  }

  const hasUserMsg = hist2.messages?.some((m: any) => m.sender === "user" && m.text.includes("CEO IS READY NOW"));
  const hasAgentMsg = hist2.messages?.some((m: any) => m.sender === "agent" && m.text.length > 0);

  console.log(`\n[PHASE 2 VERIFICATION RESULT]: ${hasUserMsg && hasAgentMsg ? "PASS (Centralized DB Verified)" : "FAIL"}`);
}

runPhase2Verification().catch((err) => {
  console.error("Phase 2 test failed:", err);
  process.exit(1);
});
