import http from "node:http";

const body = JSON.stringify({
  agentId: "bb7515be-ffac-42bf-8fb7-12aa8c0fce47",
  prompt: "أكمل تطبيق الآلة الحاسبة: اكتب ملف public/app.js لربط الواجهة بالمنطق، وملف tests/calculator.test.js لاختبار جميع الدوال، ثم شغّل اختبار التحقق verify_task.",
  workspaceRoot: "C:\\Users\\malek\\Documents\\FreeLLM Projects\\calculator",
  projectId: "5906d187-2777-4749-9b42-c97058d923e2",
  intent: "work"
});

console.log("Sending agent-chat request...");

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 3100,
    path: "/api/browser/agent-chat",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  },
  (res) => {
    console.log(`Status: ${res.statusCode}`);
    res.setEncoding("utf8");
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            console.log(`[EVENT] ${data.type || "unknown"}:`, JSON.stringify(data).slice(0, 160));
          } catch (e) {
            console.log("[RAW]", line.slice(0, 100));
          }
        }
      }
    });

    res.on("end", () => {
      console.log("Stream ended.");
    });
  }
);

req.on("error", (e) => {
  console.error("Request error:", e.message);
});

req.write(body);
req.end();
