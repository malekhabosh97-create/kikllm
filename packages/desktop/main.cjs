const { app, BrowserWindow, WebContentsView, session, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

process.on("uncaughtException", (err) => {
  try {
    const errLog = path.join(os.homedir(), ".paperclip", "freellm", "desktop-error.log");
    fs.mkdirSync(path.dirname(errLog), { recursive: true });
    fs.appendFileSync(errLog, `[${new Date().toISOString()}] Uncaught: ${err?.stack || err}\n`);
  } catch {}
  console.error(err);
});

const ROOT = process.env.FREELLM_REPO_ROOT || path.resolve(__dirname, "../..");
const SERVER_PORT = Number(process.env.PORT || 3100);
function allocateDebugPort() {
  if (process.env.FREELLM_DESKTOP_CDP_PORT) {
    const value = Number(process.env.FREELLM_DESKTOP_CDP_PORT);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("Invalid browser control port");
    return value;
  }
  // Allocate a fresh local port so rapid restarts cannot collide with a
  // Chromium listener that Windows has not released from the previous run.
  const configuredNode = process.env.FREELLM_NODE || "C:\\Program Files\\nodejs\\node.exe";
  const node = fs.existsSync(configuredNode) ? configuredNode : "node";
  const result = spawnSync(node, ["-e", "const server=require('node:net').createServer();server.on('error',()=>process.exit(1));server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>console.log(port));});"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  const port = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Could not allocate browser control port");
  return port;
}
const CDP_PORT = allocateDebugPort();
const testMode = process.env.FREELLM_DESKTOP_TEST === "1";
const connectionFile = process.env.FREELLM_DESKTOP_CONNECTION_FILE || path.join(os.homedir(), ".paperclip", "freellm", "desktop.json");
const token = crypto.randomBytes(32).toString("hex");
const userData=process.env.FREELLM_DESKTOP_USER_DATA||path.join(os.homedir(),".paperclip","freellm","desktop-profile");
fs.mkdirSync(userData,{recursive:true});app.setPath("userData",userData);
app.setName("FreeLLM Work");app.setAppUserModelId("FreeLLM.Work");
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

let window, tray, bridge, ownedServer, quitting = false, shutdownComplete = false, activeId = null, paneVisible = false;
let paneBounds = { x: 0, y: 150, width: 800, height: 500 };
const tabs = new Map();
const MAX_CONVERSATION_TABS=Math.max(2,Number(process.env.FREELLM_BROWSER_MAX_TABS)||8);
const homes = {
  gemini: "https://gemini.google.com/app", deepseek: "https://chat.deepseek.com",
  chatgpt: "https://chatgpt.com", claude: "https://claude.ai/new",
  qwen: "https://chat.qwen.ai", grok: "https://grok.com", glm: "https://chat.z.ai",
  arena: "https://arena.ai", research: "https://www.google.com"
};
function safeUrl(raw) {
  const url = new URL(raw);
  if (url.protocol === "https:" || (testMode && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return url.href;
  throw new Error("عنوان المتصفح غير مسموح");
}
function validSender(event) {
  if (!window || event.sender !== window.webContents) return false;
  let url;try{url = new URL(event.sender.getURL());}catch{return false;}
  return (url.hostname === "127.0.0.1" && url.port === String(SERVER_PORT)) || (testMode && url.protocol === "file:");
}
function describe(tab) {
  return { id: tab.id, targetId: tab.targetId, provider: tab.provider, purpose: tab.purpose, label: tab.label, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), visible: tab.id === activeId && paneVisible, busy: Boolean(tab.busy) };
}
function layout() {
  for (const tab of tabs.values()) {
    tab.view.setVisible(tab.id === activeId && paneVisible);

    const shown=tab.id === activeId && paneVisible;
    const bounds=shown&&paneBounds.width>=320&&paneBounds.height>=240?paneBounds:{x:0,y:0,width:1280,height:800};
    tab.view.setBounds(bounds);
    tab.view.webContents.enableDeviceEmulation({screenPosition:"desktop",viewSize:{width:bounds.width,height:bounds.height},deviceScaleFactor:0,scale:1});

  }
}
async function createTab(provider, rawUrl, purpose = "manual", label = "") {
  if (!homes[provider] && !(testMode && provider === "fixture")) throw new Error("منصة غير معروفة");
  const url = safeUrl(rawUrl || homes[provider]);
  if(purpose==="conversation"){
    const conversations=[...tabs.values()].filter(tab=>tab.purpose==="conversation");
    if(conversations.length>=MAX_CONVERSATION_TABS){
      const idle=conversations.filter(tab=>!tab.busy&&!/^\/(?:app|new)?\/?$/.test(new URL(tab.view.webContents.getURL()).pathname)).sort((a,b)=>a.lastUsed-b.lastUsed);
      if(!idle.length)throw new Error("المتصفح مشغول بالجلسات النشطة؛ انتظر انتهاء إحدى المهام");
      closeTab(idle[0].id);
    }
  }
  const providerSession = session.fromPartition("persist:freellm-" + provider);
  const view = new WebContentsView({ webPreferences: {
    session: providerSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
    backgroundThrottling: false, webSecurity: true
  } });
  const id = crypto.randomUUID();
  const tab = { id, provider, view, purpose, label, busy:false, lastUsed:Date.now(), targetId: null };
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  view.setVisible(false);
  tabs.set(id, tab);
  view.webContents.on("will-navigate", (event, target) => {
    try { safeUrl(target); } catch { event.preventDefault(); }
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    createTab(provider, target, "manual").then(child => { activeId = child.id; layout(); window.webContents.send("freellm:tab-selected",{id:child.id}); }).catch(console.error);
    return { action: "deny" };
  });
  view.webContents.on("destroyed", () => {
    tabs.delete(id);
    if (activeId === id) activeId = null;
  });
  view.webContents.on("render-process-gone", () => { tab.crashed = true; });
  await view.webContents.loadURL(url).catch(error => {
    if (!view.webContents.getURL() || view.webContents.getURL() === "about:blank") throw error;
  });
  view.webContents.enableDeviceEmulation({screenPosition:"desktop",viewSize:{width:1280,height:800},deviceScaleFactor:0,scale:1});
  view.webContents.debugger.attach("1.3");
  tab.targetId = (await view.webContents.debugger.sendCommand("Target.getTargetInfo")).targetInfo.targetId;
  return describe(tab);
}
function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) throw new Error("التبويب غير موجود");
  window.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
}
async function startBridge() {
  bridge = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== "Bearer " + token) return reply(401, { error: "Unauthorized" });
    let body = "";
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("الطلب كبير جدًا"); }
      const data = body ? JSON.parse(body) : {};
      switch (req.url) {
        case "/quit": reply(200,{success:true});setImmediate(()=>app.quit());return;
        case "/status": return reply(200, { connected: true, embedded: true, tabs: [...tabs.values()].filter(tab=>tab.targetId).map(describe), cdpPort: CDP_PORT });
        case "/tabs/create": return reply(200, await createTab(data.provider, data.url, data.purpose, data.label));
        case "/tabs/state": {const tab=tabs.get(data.id);if(!tab)throw new Error("Tab not found");tab.busy=data.busy===true;tab.lastUsed=Date.now();return reply(200,{success:true});}
        case "/tabs/label": {const tab=tabs.get(data.id);if(!tab)throw new Error("Tab not found");tab.label=String(data.label||"").slice(0,120);return reply(200,describe(tab));}
        case "/tabs/show":
          if (!tabs.has(data.id)) throw new Error("التبويب غير موجود");
          activeId = data.id;tabs.get(data.id).lastUsed=Date.now(); paneVisible = true; layout();
          window.webContents.send("freellm:tab-selected", { id: data.id });
          return reply(200, { success: true });
        case "/tabs/close": closeTab(data.id); return reply(200, { success: true });
        case "/hide": paneVisible = false; layout(); return reply(200, { success: true });
        case "/show": showAppWindow(); return reply(200, { success: true });
        default: return reply(404, { error: "Unknown browser action" });
      }
    } catch (error) { reply(400, { error: error.message }); }
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.dirname(connectionFile), { recursive: true });
  fs.writeFileSync(connectionFile, JSON.stringify({ pid: process.pid, port: bridge.address().port, cdpPort: CDP_PORT, token }), { mode: 0o600 });
}
async function healthy() {
  try { return (await fetch("http://127.0.0.1:" + SERVER_PORT + "/api/health", { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}
async function startServer() {
  if(!testMode)await import(require("node:url").pathToFileURL(path.join(ROOT,"scripts/freellm-prepare-ui.mjs")).href);
  if (testMode || await healthy()) return;
  const node = process.env.FREELLM_NODE || "C:\\Program Files\\nodejs\\node.exe";
  ownedServer = spawn(fs.existsSync(node) ? node : "node", [path.join(ROOT, "cli/node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "server/src/index.ts")], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PORT: String(SERVER_PORT), PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_MIGRATION_PROMPT: "never" }
  });
  const logFile = path.join(path.dirname(connectionFile), "desktop-server.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  ownedServer.stdout.pipe(log, { end: false }); ownedServer.stderr.pipe(log, { end: false });
  ownedServer.on("error", error => log.write(error.message + "\n"));
  for (let i = 0; i < 90; i++) {
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("تعذر تشغيل الخادم. راجع سجل التشخيص.");
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 650, title: "FreeLLM Work",
    icon: path.join(__dirname, "app.ico"), show: !testMode, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") }
  });
  window.on("close", event => { if (!quitting) { event.preventDefault(); paneVisible = false; layout(); window.hide(); } });
  window.on("resize", () => { const [width, height] = window.getContentSize(); paneBounds.width = Math.min(paneBounds.width, width); paneBounds.height = Math.min(paneBounds.height, Math.max(0, height - paneBounds.y)); layout(); });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.key === "F5" || (input.control && input.key.toLowerCase() === "r"))) {
      window.webContents.reload();
    }
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith("http://127.0.0.1:" + SERVER_PORT + "/") && !(testMode && target.startsWith("file:"))) { event.preventDefault(); if (target.startsWith("https:")) shell.openExternal(target); }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("https:") || url.startsWith("http://127.0.0.1:")) shell.openExternal(url); return { action: "deny" }; });
  ipcMain.handle("freellm:browser-bounds", (event, data) => {
    if (!validSender(event)) throw new Error("Unauthorized");
    const [width, height] = window.getContentSize();
    for (const key of ["x", "y", "width", "height"]) if (!Number.isFinite(data[key])) throw new Error("Invalid bounds");
    paneBounds = { x: Math.max(0, Math.floor(data.x)), y: Math.max(0, Math.floor(data.y)), width: Math.max(0, Math.min(width, Math.floor(data.width))), height: Math.max(0, Math.min(height, Math.floor(data.height))) };
    paneVisible = data.visible !== false; layout(); return true;
  });
  ipcMain.handle("freellm:browser-hide", event => { if (!validSender(event)) throw new Error("Unauthorized"); paneVisible = false; layout(); return true; });
  ipcMain.handle("freellm:select-folder", async event => {
    if (!validSender(event)) throw new Error("Unauthorized");
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
}
function showAppWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.setAlwaysOnTop(true);
  window.focus();
  window.setAlwaysOnTop(false);
}
function createTray() {
  try {
    const icon = fs.existsSync(path.join(__dirname, "app.ico")) ? nativeImage.createFromPath(path.join(__dirname, "app.ico")) : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip("FreeLLM Work — العمل مستمر في الخلفية");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "فتح البرنامج", click: showAppWindow },
      { label: "إعادة تحميل الواجهة (F5)", click: () => { if (window && window.webContents) window.webContents.reload(); } },
      { label: "إنهاء البرنامج والخدمات بالكامل", click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on("double-click", showAppWindow);
  } catch (err) {
    console.error("Tray initialization warning:", err);
  }
}
if (!testMode && !app.requestSingleInstanceLock()) {console.error("Another FreeLLM Work instance owns this browser profile: "+userData);app.quit();}
else {
  app.on("second-instance", () => {
    showAppWindow();
    if (window && window.webContents) {
      window.webContents.reload();
    }
  });
  app.whenReady().then(async () => {
    createWindow(); if (!testMode) createTray();
    await startBridge();
    if (testMode) { await window.loadFile(path.join(__dirname, "splash.html")); return; }
    await window.loadFile(path.join(__dirname, "splash.html"));
    try { await startServer(); await window.loadURL("http://127.0.0.1:" + SERVER_PORT + "/"); }
    catch (error) { window.webContents.send("status-update", { status: error.message }); }
  }).catch((err) => {
    try {
      const errLog = path.join(os.homedir(), ".paperclip", "freellm", "desktop-error.log");
      fs.mkdirSync(path.dirname(errLog), { recursive: true });
      fs.appendFileSync(errLog, `[${new Date().toISOString()}] Startup error: ${err?.stack || err}\n`);
    } catch {}
    console.error(err);
  });
}

app.on("before-quit",event=>{
  if(shutdownComplete)return;
  event.preventDefault();if(quitting)return;quitting=true;
  void(async()=>{
    if(ownedServer?.pid&&ownedServer.exitCode===null){
      const stopped=new Promise(resolve=>ownedServer.once("exit",()=>resolve(true)));
      if(ownedServer.connected)ownedServer.send({type:"freellm:shutdown"});
      else ownedServer.kill("SIGTERM");
      const graceful=await Promise.race([stopped,new Promise(resolve=>setTimeout(()=>resolve(false),30000))]);
      if(!graceful&&process.platform==="win32")spawn("taskkill",["/pid",String(ownedServer.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
    }
    const sessions=new Set([...tabs.values()].map(tab=>tab.view.webContents.session));
    await Promise.allSettled([...sessions].map(provider=>provider.cookies.flushStore()));
    for(const tab of tabs.values())if(!tab.view.webContents.isDestroyed())tab.view.webContents.close();
    try{if(JSON.parse(fs.readFileSync(connectionFile,"utf8")).pid===process.pid)fs.unlinkSync(connectionFile);}catch{}
    bridge?.close();shutdownComplete=true;app.quit();
  })().catch(error=>{console.error(error);shutdownComplete=true;app.quit();});
});
app.on("window-all-closed", () => {});
