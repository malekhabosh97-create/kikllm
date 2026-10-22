const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");

const REPO_ROOT = process.env.FREELLM_REPO_ROOT || "C:\\Users\\malek\\Documents\\freellm work";
const SERVER_PORT = 3100;
const DAEMON_PORT = 3150;
const CHROME_PORT = 9222;

let mainWindow = null;
const spawnedPids = new Set();
let isQuitting = false;

function log(msg) {
  console.log(`[FreeLLM Desktop] ${msg}`);
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function updateSplashStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send("status-update", payload);
    const code = `window.postMessage(${JSON.stringify(payload)}, '*');`;
    mainWindow.webContents.executeJavaScript(code).catch(() => {});
  }
}

function ensureChromeRunning() {
  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  let exePath = chromePaths.find((p) => fs.existsSync(p));
  if (!exePath) {
    log("No Chrome or Edge installation found in standard paths.");
    return null;
  }

  const profileDir = "C:\\Users\\malek\\.freellm-browser-profile";
  fs.mkdirSync(profileDir, { recursive: true });

  log(`Launching browser instance for AI sessions: ${exePath}`);
  const child = spawn(
    exePath,
    [
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chat.deepseek.com",
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();
  return child.pid;
}

function getNodeBin() {
  const possiblePaths = [
    "C:\\Program Files\\nodejs\\node.exe",
    process.env.NODE || "node",
  ];
  return possiblePaths.find((p) => fs.existsSync(p)) || "node";
}

function cleanupStalePostgresPid() {
  const pidFile = "C:\\Users\\malek\\.paperclip\\instances\\default\\db\\postmaster.pid";
  if (fs.existsSync(pidFile)) {
    try {
      const pidStr = fs.readFileSync(pidFile, "utf8").split("\n")[0]?.trim();
      const pid = Number(pidStr);
      let isAlive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }
      if (!isAlive) {
        log(`Removing stale postgres lock file for inactive PID ${pid}`);
        fs.unlinkSync(pidFile);
      }
    } catch {
      // ignore
    }
  }
}

function startPaperclipServer() {
  cleanupStalePostgresPid();
  log("Starting Paperclip Server (Port 3100)...");
  const nodeBin = getNodeBin();
  const tsxCli = path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const serverIndex = path.join(REPO_ROOT, "server", "src", "index.ts");
  
  const child = spawn(
    nodeBin,
    [tsxCli, serverIndex],
    {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        PAPERCLIP_MIGRATION_PROMPT: "never",
        NODE_ENV: "development",
      },
    }
  );

  if (child.pid) {
    spawnedPids.add(child.pid);
    log(`Paperclip Server process spawned with PID ${child.pid}`);
  }

  child.stdout.on("data", (data) => {
    const text = data.toString();
    if (text.includes("listening") || text.includes("3100")) {
      log(`[Server] ${text.trim()}`);
    }
  });

  child.stderr.on("data", (data) => {
    // suppress noisy logs
  });

  child.on("exit", (code, signal) => {
    log(`Server exited with code ${code}, signal ${signal}`);
  });

  return child;
}

function startBrowserDaemon() {
  log("Starting FreeLLM Browser Daemon (Port 3150)...");
  const nodeBin = getNodeBin();
  const tsxCli = path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const daemonRun = path.join(REPO_ROOT, "server", "src", "services", "freellm-browser-daemon", "run-daemon.ts");

  const child = spawn(
    nodeBin,
    [tsxCli, daemonRun],
    {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        FREELLM_DAEMON_PORT: String(DAEMON_PORT),
      },
    }
  );

  if (child.pid) {
    spawnedPids.add(child.pid);
    log(`Browser Daemon process spawned with PID ${child.pid}`);
  }

  child.stdout.on("data", (data) => {
    const text = data.toString();
    if (text.includes("running") || text.includes("3150")) {
      log(`[Daemon] ${text.trim()}`);
    }
  });

  child.on("exit", (code, signal) => {
    log(`Daemon exited with code ${code}, signal ${signal}`);
  });

  return child;
}

function killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Ignore errors if process already exited
  }
}

function cleanupServices() {
  if (isQuitting) return;
  isQuitting = true;
  log("Shutting down background services cleanly...");

  for (const pid of spawnedPids) {
    log(`Terminating process tree for PID ${pid}...`);
    killProcessTree(pid);
  }
  spawnedPids.clear();
}

async function orchestrateStartup() {
  // Step 1: Check Chrome CDP
  updateSplashStatus({
    status: "جاري التحقق من محرك متصفح النماذج (Chrome CDP)...",
    chrome: { className: "badge-running", text: "جاري الفحص" },
  });

  const chromeActive = await isPortOpen(CHROME_PORT);
  if (!chromeActive) {
    log("Chrome CDP not running on 9222. Launching AI browser session...");
    ensureChromeRunning();
    let retries = 15;
    while (retries > 0) {
      await new Promise((r) => setTimeout(r, 600));
      if (await isPortOpen(CHROME_PORT)) break;
      retries--;
    }
  }

  const chromeFinal = await isPortOpen(CHROME_PORT);
  updateSplashStatus({
    chrome: chromeFinal
      ? { className: "badge-ready", text: "متصل (9222)" }
      : { className: "badge-pending", text: "غير متصل" },
  });

  // Step 2: Check & Start FreeLLM Browser Daemon
  updateSplashStatus({
    status: "جاري التحقق من وسيط المتصفح الذكي (Browser Daemon)...",
    daemon: { className: "badge-running", text: "جاري البدء" },
  });

  const daemonActive = await isPortOpen(DAEMON_PORT);
  if (!daemonActive) {
    startBrowserDaemon();
  }

  // Step 3: Check & Start Paperclip Server
  updateSplashStatus({
    status: "جاري تشغيل خادم بيبركليب وقاعدة البيانات...",
    server: { className: "badge-running", text: "جاري البدء" },
  });

  const serverActive = await isPortOpen(SERVER_PORT);
  if (!serverActive) {
    startPaperclipServer();
  }

  // Step 4: Wait for services to be ready
  const startTime = Date.now();
  let serverHealthy = false;
  let daemonReady = false;

  while (Date.now() - startTime < 60000) {
    if (!serverHealthy) {
      serverHealthy = await checkServerHealth();
      if (serverHealthy) {
        updateSplashStatus({
          server: { className: "badge-ready", text: "جاهز (3100)" },
        });
      }
    }

    if (!daemonReady) {
      daemonReady = await isPortOpen(DAEMON_PORT);
      if (daemonReady) {
        updateSplashStatus({
          daemon: { className: "badge-ready", text: "جاهز (3150)" },
        });
      }
    }

    if (serverHealthy && daemonReady) {
      break;
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  if (serverHealthy) {
    log("Server is healthy! Transitioning to FreeLLM dashboard...");
    updateSplashStatus({
      status: "اكتمل التشغيل بنجاح! جاري فتح واجهة التطبيق...",
    });

    await new Promise((r) => setTimeout(r, 600));

    // Load full dashboard directly in desktop window
    mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/FRE/dashboard`);
  } else {
    log("Startup timeout reached, attempting to load dashboard anyway...");
    updateSplashStatus({
      status: "استغرق التشغيل وقتاً أطول من المتوقع. جاري فتح الواجهة على أي حال...",
    });
    mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/FRE/dashboard`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "FreeLLM Work",
    icon: path.join(__dirname, "app.ico"),
    backgroundColor: "#090d16",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log(`WebContents loaded: ${mainWindow.webContents.getURL()}`);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log(`WebContents failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
  });

  mainWindow.loadFile(path.join(__dirname, "splash.html"));

  // Handle external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  orchestrateStartup().catch((err) => {
    log(`Startup orchestration error: ${err}`);
  });
}

// Ensure single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log("Another instance of FreeLLM Work is already running. Quitting duplicate.");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  cleanupServices();
});

app.on("window-all-closed", () => {
  cleanupServices();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("SIGINT", () => {
  cleanupServices();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanupServices();
  process.exit(0);
});
