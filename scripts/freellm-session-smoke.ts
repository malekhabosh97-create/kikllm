import assert from "node:assert/strict";
import path from "node:path";import {createRequire} from "node:module";
import {PlaywrightChatSession} from "../server/src/adapters/freellm-browser/browser-provider/chat-session.js";
import {parseToolCall} from "../server/src/adapters/freellm-browser/tool-executor.js";
const require=createRequire(path.resolve("server/package.json")),{chromium}=require("playwright");
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const call={callId:"real-dom-call",tool:"read_file",arguments:{path:"README.md"}};
 await page.setContent('<textarea id="chat"></textarea><button aria-label="Send">Send</button><button id="stop" hidden>Stop</button><div id="output"></div>');
 await page.evaluate((call)=>{
  document.querySelector("button[aria-label=Send]").addEventListener("click",()=>{
   const output=document.querySelector("#output"),stop=document.querySelector("#stop");stop.removeAttribute("hidden");
   output.innerHTML="<div class=assistant><p>First paragraph</p><p>Second paragraph</p><code-block><div>Code snippet</div><pre><code></code></pre></code-block></div>";
   output.querySelector("code").textContent=JSON.stringify(call);
   setTimeout(()=>stop.setAttribute("hidden",""),120);
  });
  document.querySelector("#stop").addEventListener("click",()=>{document.querySelector("#stop").setAttribute("hidden","");document.body.dataset.stopped="yes";});
 },call);
 const config:any={id:"fixture",name:"Fixture",url:"https://fixture.invalid",chatInput:["#chat"],sendButton:["button[aria-label=Send]"],stopButton:["#stop:not([hidden])"],lastMessage:[".assistant"],messageText:["p"],fileInput:[],attachButton:[],loginIndicators:[],blockers:[],completion:{stabilityMs:250,pollIntervalMs:50,maxTimeoutMs:5000}};
 const session=new PlaywrightChatSession({page,config});
 await session.send("Fixture tool action");
 const result=await session.waitForReply();
 assert.equal(result.status,"ok");assert.ok(result.text.includes("First paragraph"));assert.ok(result.text.includes("Second paragraph"));
 assert.deepEqual(parseToolCall(result.text),call,"Rendered code blocks must retain a valid tool envelope even when the website drops its language label.");
 await session.send("Cancel fixture");
 const controller=new AbortController();controller.abort();
 const cancelled=await session.waitForReply({signal:controller.signal});assert.equal(cancelled.status,"cancelled");
 const errorPage=await browser.newPage({viewport:{width:1280,height:800}});
 await errorPage.setContent('<textarea id="chat"></textarea><button aria-label="Send">Send</button><div id="output"></div>');
 await errorPage.evaluate(()=>{document.querySelector("button[aria-label=Send]").addEventListener("click",()=>{document.querySelector("#output").innerHTML="<div class=assistant>Sorry, something went wrong. Please try your request again.</div>";});});
 const errorSession=new PlaywrightChatSession({page:errorPage,config:{...config,id:"gemini"}});
 await errorSession.send("Fixture provider error");
 const errorReply=await errorSession.waitForReply();assert.equal(errorReply.status,"blocked");assert.equal(errorReply.blocker,"provider_error");
 const limitPage=await browser.newPage({viewport:{width:1280,height:800}});
 await limitPage.setContent('<textarea id="chat"></textarea><button aria-label="Send">Send</button><div id="output"></div>');
 await limitPage.evaluate(()=>{document.querySelector("button[aria-label=Send]").addEventListener("click",()=>{document.querySelector("#output").innerHTML="<div class=assistant>7</div><div class=quota-exceeded>Limit reached</div>";});});
 const limitSession=new PlaywrightChatSession({page:limitPage,config:{...config,blockers:[{type:"quota_exhausted",selector:".quota-exceeded"}]}});
 await limitSession.send("Fixture final answer with limit notice");
 const limitReply=await limitSession.waitForReply();assert.equal(limitReply.status,"ok");assert.equal(limitReply.text,"7");
 const blockedPage=await browser.newPage({viewport:{width:1280,height:800}});
 await blockedPage.setContent('<textarea id="chat"></textarea><button aria-label="Send">Send</button><div id="output"></div>');
 await blockedPage.evaluate(()=>{document.querySelector("button[aria-label=Send]").addEventListener("click",()=>{document.querySelector("#output").innerHTML="<div class=quota-exceeded>Limit reached</div>";});});
 const blockedSession=new PlaywrightChatSession({page:blockedPage,config:{...config,blockers:[{type:"quota_exhausted",selector:".quota-exceeded"}]}});
 await blockedSession.send("Fixture no answer with limit notice");
 const blockedReply=await blockedSession.waitForReply();assert.equal(blockedReply.status,"blocked");assert.equal(blockedReply.blocker,"quota_exhausted");
 console.log("PASS: DOM extraction, tool parsing, cancellation, provider errors and limit notices.");
}finally{await browser.close();}
