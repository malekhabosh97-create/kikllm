import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const root = process.cwd();
const require = createRequire(path.join(root, "server/package.json"));
const { _electron, chromium } = require("playwright");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freellm-desktop-smoke-"));
const connectionFile = path.join(temp, "desktop.json");
const fixture = http.createServer((_req,res) => {
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><title>Browser fixture</title><textarea aria-label="Message"></textarea><button onclick="document.querySelector(\'#reply\').textContent=document.querySelector(\'textarea\').value">Send</button><div id="reply"></div>');
});
await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
let desktop, browser;
try {
  desktop = await _electron.launch({
    executablePath:path.join(root,"packages/desktop/node_modules/electron/dist/electron.exe"),
    args:[path.join(root,"packages/desktop/main.cjs")],
    env:{...process.env,FREELLM_DESKTOP_TEST:"1",FREELLM_BROWSER_MAX_TABS:"2",FREELLM_DESKTOP_CDP_PORT:"9236",FREELLM_DESKTOP_CONNECTION_FILE:connectionFile,FREELLM_DESKTOP_USER_DATA:path.join(temp,"profile")},
    timeout:30000,
  });
  desktop.process().stderr.on("data",chunk=>{const text=chunk.toString();if(!text.includes("DevTools listening"))process.stderr.write(text.slice(-1200));});
  await desktop.firstWindow();
  for(let i=0;i<80&&!fs.existsSync(connectionFile);i++) await new Promise(r=>setTimeout(r,100));
  const connection=JSON.parse(fs.readFileSync(connectionFile,"utf8"));
  const request=async(action,body)=>{
    const res=await fetch("http://127.0.0.1:"+connection.port+"/"+action,{method:body?"POST":"GET",headers:{authorization:"Bearer "+connection.token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
    assert.equal(res.ok,true,action+": "+await res.clone().text());
    return res.json();
  };
  const unauthorized=await fetch("http://127.0.0.1:"+connection.port+"/status");
  assert.equal(unauthorized.status,401);
  const url="http://127.0.0.1:"+fixture.address().port;
  const first=await request("tabs/create",{provider:"fixture",url});
  const second=await request("tabs/create",{provider:"fixture",url});
  assert.notEqual(first.targetId,second.targetId);
  browser=await chromium.connectOverCDP("http://127.0.0.1:9236");
  const pages=browser.contexts().flatMap(c=>c.pages());
  console.log("CDP pages:",pages.map(p=>p.url()));
  const providerPages=pages.filter(p=>p.url().startsWith(url));
  assert.equal(providerPages.length,2,"Embedded views must be visible to Playwright");
  assert.ok(await providerPages[0].evaluate(()=>innerWidth>0&&innerHeight>0),"A hidden native tab must retain a usable viewport");
  await providerPages[0].getByRole("textbox").fill("FIRST");
  await providerPages[0].getByRole("button").click();
  assert.equal(await providerPages[0].locator("#reply").innerText(),"FIRST");
  assert.equal(await providerPages[1].locator("#reply").innerText(),"");
  await request("tabs/show",{id:first.id});
  await request("hide",{});
  assert.equal((await request("status")).tabs.length,2);
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  assert.equal((await request("status")).tabs.length,2,"Window close must retain browser sessions");
  await request("show",{});
  await request("tabs/close",{id:first.id});
  assert.equal((await request("status")).tabs.length,1);

  const a=await request("tabs/create",{provider:"fixture",purpose:"conversation",url:url+"/chat/a"});
  const b=await request("tabs/create",{provider:"fixture",purpose:"conversation",url:url+"/chat/b"});
  await request("tabs/state",{id:a.id,busy:true});
  const c=await request("tabs/create",{provider:"fixture",purpose:"conversation",url:url+"/chat/c"});
  const kept=(await request("status")).tabs;
  const newTargets=[];for(const context of browser.contexts())for(const page of context.pages()){const cdp=await context.newCDPSession(page);newTargets.push((await cdp.send("Target.getTargetInfo")).targetInfo.targetId);await cdp.detach();}
  assert.ok(newTargets.includes(c.targetId),"An existing Playwright connection must discover a newly created embedded tab");
  assert.ok(kept.some(tab=>tab.id===a.id),"An active agent tab must not be evicted");
  assert.ok(!kept.some(tab=>tab.id===b.id),"An idle resumable tab should be released at the memory limit");
  assert.ok(kept.some(tab=>tab.id===c.id));
  console.log("PASS: native embedded tabs, Playwright control, isolation, authenticated bridge, hide/reopen, close-to-background.");
} finally {
  if(desktop) await desktop.close().catch(()=>{});
  fixture.close();
}
