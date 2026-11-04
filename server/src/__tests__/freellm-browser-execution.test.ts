import { describe,it,expect,afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { parseToolCall, executeToolOutcome } from "../adapters/freellm-browser/tool-executor.js";
import { runAgentTurnLoop } from "../adapters/freellm-browser/unified-engine.js";
import { roleInstructions, ROLE_INSTRUCTIONS } from "../adapters/freellm-browser/role-instructions.js";
import { BrowserSessionHub } from "../adapters/freellm-browser/browser-provider/session-hub.js";
import { isProviderErrorReply } from "../adapters/freellm-browser/browser-provider/chat-session.js";
import { classifyProviderProbe } from "../adapters/freellm-browser/browser-provider/probe.js";
import { globalModelRouter } from "../adapters/freellm-browser/browser-provider/model-router.js";
import { stageFileMutation,applyFileMutation } from "../services/file-mutation.js";
const roots:string[]=[];
function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"freellm-runtime-"));roots.push(root);return root;}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const agent={id:"10000000-0000-4000-8000-000000000001",companyId:"20000000-0000-4000-8000-000000000001",name:"Developer",role:"engineer",adapterConfig:{model:"gemini-default"}};
const call=(tool:string,args:Record<string,unknown>,id=crypto.randomUUID())=>({callId:id,tool,arguments:args});
const reply=(tool:string,args:Record<string,unknown>,id?:string)=>"\`\`\`tool_call\n"+JSON.stringify(call(tool,args,id))+"\n\`\`\`";
describe("FreeLLM isolated tool and graph regressions",()=>{
  it("does not duplicate a saved role definition",()=>{
    const initial=roleInstructions("ceo"),next=roleInstructions("ceo",initial);
    expect(next).toBe(initial);expect(next.split(ROLE_INSTRUCTIONS.ceo)).toHaveLength(2);
  });
  it("returns only useful project commands",async()=>{
    const root=temp();fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({name:"fixture",scripts:{test:"node --test",dev:"node app.js",release:"unrelated",unused:"unrelated"}}));
    const result=await executeToolOutcome(call("get_project_context",{}),root);
    expect(result.data?.commands).toEqual({dev:"node app.js",test:"node --test"});
  });
  it("prevents a new calculator from being created in the platform source folder",async()=>{
    const root=path.resolve(import.meta.dirname,"../../..");
    await expect(runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:root,prompt:"اصنع لي الة حاسبة",intent:"work",transport:async()=>{throw new Error("must not dispatch");}})).rejects.toThrow(/مجلدًا مستقلًا/);
  });
  it("identifies provider-generated error replies without blocking normal text",()=>{
    expect(isProviderErrorReply("gemini","Sorry, something went wrong. Please try your request again.")).toBe(true);
    expect(isProviderErrorReply("gemini","I encountered an error doing what you asked. Could you try again?")).toBe(true);
    expect(isProviderErrorReply("gemini","The tests found something wrong; here is the fix.")).toBe(false);
    expect(isProviderErrorReply("deepseek","The server is busy. Please try again later.")).toBe(true);
    expect(isProviderErrorReply("deepseek","Too many requests, please try again in 5s.")).toBe(true);
    expect(isProviderErrorReply("deepseek","Here is the requested code implementation.")).toBe(false);
  });
  it("distinguishes connectivity from exact instruction following",()=>{
    const nonce="FREELLM_fixture";
    expect(classifyProviderProbe({status:"ok",text:nonce},nonce)).toMatchObject({passed:true,exactInstruction:true});
    expect(classifyProviderProbe({status:"ok",text:"The requested token is "+nonce},nonce)).toMatchObject({passed:true,exactInstruction:false});
    expect(classifyProviderProbe({status:"blocked",text:"",blocker:"provider_error",blockerDetails:"Provider failed"},nonce)).toMatchObject({passed:false,error:"Provider failed"});
  });
  it("rejects empty verification",async()=>{const result=await executeToolOutcome(call("verify_task",{}),temp());expect(result.ok).toBe(false);expect(result.verified).toBe(false);});
  it("rejects missing deliverables",async()=>{const result=await executeToolOutcome(call("verify_task",{expectedFiles:["missing.txt"]}),temp());expect(result.ok).toBe(false);});
  it("propagates a failing check",async()=>{const result=await executeToolOutcome(call("verify_task",{testCommand:'node -e "process.exit(1)"'}),temp());expect(result.ok).toBe(false);});
  it("does not pretend a disconnected database created an agent",async()=>{const result=await executeToolOutcome(call("create_agent",{name:"Specialist",systemPrompt:"A detailed role instruction for testing."}),temp());expect(result.ok).toBe(false);});
  it("does not pretend a disconnected database delegated work",async()=>{const result=await executeToolOutcome(call("delegate_task",{agentId:agent.id,title:"Task",description:"Implement a bounded task",acceptanceCriteria:["test passes"]}),temp());expect(result.ok).toBe(false);});
  it("does not pretend a disconnected database sent a message",async()=>{const result=await executeToolOutcome(call("send_agent_message",{targetAgentId:agent.id,message:"review"}),temp());expect(result.ok).toBe(false);});
  it("validates tool arguments",async()=>{const result=await executeToolOutcome(call("read_file",{}),temp());expect(result.ok).toBe(false);});
  it("contains get_project_context within its selected root",async()=>{const result=await executeToolOutcome(call("get_project_context",{path:".."}),temp());expect(result.ok).toBe(false);});
  it("contains file reads within their selected root",async()=>{const result=await executeToolOutcome(call("read_file",{path:"../outside.txt"}),temp());expect(result.ok).toBe(false);});
  it("writes real changes and real diffs",async()=>{const root=temp();fs.writeFileSync(path.join(root,"note.txt"),"before\n");const result=await executeToolOutcome(call("propose_file_mutation",{relativePath:"note.txt",operation:"modify",content:"after\n"}),root);expect(result.ok).toBe(true);expect(result.data?.diff).toContain("-before");expect(result.data?.diff).toContain("+after");expect(fs.readFileSync(path.join(root,"note.txt"),"utf8")).toBe("after\n");});
  it("rejects a stale staged edit",()=>{const root=temp();fs.writeFileSync(path.join(root,"note.txt"),"before");const staged=stageFileMutation(root,{relativePath:"note.txt",operation:"modify",content:"after"});fs.writeFileSync(path.join(root,"note.txt"),"human edit");expect(()=>applyFileMutation(root,staged)).toThrow(/conflict/i);expect(fs.readFileSync(path.join(root,"note.txt"),"utf8")).toBe("human edit");});
  it("rejects foreign staging files",()=>{const root=temp(),other=temp();const staged=stageFileMutation(other,{relativePath:"other.txt",operation:"create",content:"content"});expect(()=>applyFileMutation(root,{...staged,relativePath:"note.txt"})).toThrow(/owned|boundary/);});
  it("rejects a new file under a junction outside the workspace",()=>{
    const root=temp(),other=temp();fs.symlinkSync(other,path.join(root,"outside"),"junction");
    expect(()=>stageFileMutation(root,{relativePath:"outside/new.txt",operation:"create",content:"no"})).toThrow(/outside/);
  });
  it("accepts an explicit completed tool envelope",()=>{expect(parseToolCall(reply("list_dir",{}))?.tool).toBe("list_dir");});
  it("accepts legitimate code containing illustrative language",()=>{expect(parseToolCall(reply("propose_file_mutation",{relativePath:"readme.txt",operation:"create",content:"على سبيل المثال: لا تنفذ هذا الأمر"}))?.tool).toBe("propose_file_mutation");});
  it("ignores quoted tool examples",()=>{expect(parseToolCall("> "+reply("list_dir",{}).replaceAll("\n","\n> "))).toBeNull();});
  it("ignores explanatory examples",()=>{expect(parseToolCall("على سبيل المثال\n"+reply("list_dir",{}))).toBeNull();});
  it("ignores tool-looking JSON embedded in prose",()=>{expect(parseToolCall("Documentation: "+JSON.stringify(call("list_dir",{})))).toBeNull();});
  it("rejects an unknown model provider",()=>{expect(()=>globalModelRouter.resolveRoute("unknown-model")).toThrow();});
  it("routes DeepThink to the thinking mode",()=>{expect(globalModelRouter.resolveRoute("deepseek-deepthink").modelId).toBe("deepseek-reasoner");});
  it("routes all registered web providers without silent fallback",()=>{for(const id of ["chatgpt","claude","qwen","grok","glm","arena"])expect(globalModelRouter.resolveRoute(id+"-default").siteId).toBe(id);});
  it("does not call a narrative completion successful execution",async()=>{
    let calls=0;const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:temp(),prompt:"Implement the task",intent:"work",transport:async()=>{calls++;return {status:"ok",text:"Done."};}});
    expect(result.lastStatus).toBe("blocked");expect(calls).toBe(2);
  });
  it("propagates provider failure",async()=>{const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:temp(),prompt:"Question",transport:async()=>({status:"timeout",text:"partial"})});expect(result.lastStatus).toBe("failed");});
  it("propagates cancellation",async()=>{const controller=new AbortController();controller.abort();const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:temp(),prompt:"Question",signal:controller.signal,transport:async()=>{throw new Error("Must not call");}});expect(result.lastStatus).toBe("cancelled");});
  it("executes read-edit-test and completion through the real graph with a model fixture",async()=>{
    const root=temp();fs.writeFileSync(path.join(root,"math.mjs"),"export const multiply=(a,b)=>a+b;\n");
    fs.writeFileSync(path.join(root,"math.test.mjs"),'import assert from "node:assert/strict";import {multiply} from "./math.mjs";assert.equal(multiply(3,4),12);');
    const responses=[reply("read_file",{path:"math.mjs"}),reply("propose_file_mutation",{relativePath:"math.mjs",operation:"modify",content:"export const multiply=(a,b)=>a*b;\n"}),reply("verify_task",{expectedFiles:["math.mjs"],testCommand:"node --test math.test.mjs"}),"Fixed and verified."];
    const events:any[]=[];const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:root,prompt:"Fix multiplication",intent:"work",transport:async()=>({status:"ok",text:responses.shift()}),onEvent:event=>{events.push(event);}});
    expect(result.lastStatus).toBe("completed");expect(result.verified).toBe(true);expect(result.toolCallsCount).toBe(3);
    expect(events.filter(event=>event.type==="tool_result")).toHaveLength(3);expect(events.at(-1).status).toBe("completed");
  });
  it("continues after a provider error with partial work and avoids echoing a large diff",async()=>{
    const root=temp(),marker="SOURCE_MARKER_".repeat(120);
    const responses=[reply("propose_file_mutation",{relativePath:"app.js",operation:"create",content:"// "+marker+"\nconsole.log(1);"}),"I encountered an error doing what you asked. Could you try again?",reply("propose_file_mutation",{relativePath:"index.html",operation:"create",content:"<h1>Calculator</h1>"}),reply("verify_task",{expectedFiles:["app.js","index.html"],testCommand:"node --check app.js"}),"Completed and verified."];
    const prompts:string[]=[],events:any[]=[];
    const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:root,prompt:"Build an application",intent:"work",transport:async(params)=>{prompts.push(params.prompt);return {status:"ok",text:responses.shift()};},onEvent:event=>{events.push(event);}});
    expect(result.lastStatus).toBe("completed");expect(result.verified).toBe(true);
    expect(prompts[1]).not.toContain(marker);expect(prompts[1]).toContain("diffOmitted");
    expect(prompts[2]).toContain("Do not repeat completed actions");
    const write=events.find(event=>event.type==="tool_call"&&event.tool==="propose_file_mutation");
    expect(write.args.content).not.toContain(marker);
    expect(events.find(event=>event.type==="tool_result"&&event.tool==="propose_file_mutation").result).not.toContain(marker);
  });
  it("bounds recovery when a provider repeatedly fails",async()=>{
    const root=temp(),responses=[reply("propose_file_mutation",{relativePath:"app.js",operation:"create",content:"console.log(1)"}),"Provider error","Still unavailable"];
    let calls=0;const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:root,prompt:"Build an application",intent:"work",transport:async()=>{calls++;return {status:"ok",text:responses.shift()};}});
    expect(result.lastStatus).toBe("blocked");expect(calls).toBe(3);expect(fs.existsSync(path.join(root,"app.js"))).toBe(true);
  });
  it("does not mark a failed verification complete",async()=>{
    const responses=[reply("verify_task",{expectedFiles:["missing.txt"]}),"All done."];
    const result=await runAgentTurnLoop({agentId:agent.id,agent,workspaceRoot:temp(),prompt:"Implement",intent:"work",transport:async()=>({status:"ok",text:responses.shift()})});expect(result.lastStatus).toBe("blocked");
  });
  it("reuses a completed checkpoint without repeating tools",async()=>{
    const checkpoint=new MemorySaver(),root=temp();let toolCalls=0;
    const responses=[reply("verify_task",{expectedFiles:["README.md"]}),"Verified."];fs.writeFileSync(path.join(root,"README.md"),"fixture");
    const options={agentId:agent.id,agent,workspaceRoot:root,runId:crypto.randomUUID(),prompt:"Read project",intent:"work" as const,checkpointer:checkpoint,
      transport:async()=>({status:"ok",text:responses.shift()}),execute:async()=>{toolCalls++;return {ok:true,status:"executed" as const,verified:true};}};
    expect((await runAgentTurnLoop(options)).lastStatus).toBe("completed");expect((await runAgentTurnLoop(options)).lastStatus).toBe("completed");expect(toolCalls).toBe(1);
  });
});
describe("Browser session isolation and recovery with provider fixtures",()=>{
  function setup(){
    const sessions:any[]=[];const adapter:any={
      async newChat(){const value={tabId:crypto.randomUUID(),closed:false,sent:[] as string[],isClosed(){return this.closed;},url(){return "https://gemini.google.com/app/"+this.tabId;},async send(text:string){this.sent.push(text);},async waitForReply(){return {status:"ok",text:"response"};},async stop(){return true;}};sessions.push(value);return value;},
      async resumeChat(){return this.newChat();},
    };
    const root=temp(),hub=new BrowserSessionHub(root,()=>adapter);
    const params={companyId:agent.companyId,agentId:agent.id,model:"gemini-default",prompt:"task",instructions:"Role instructions",requestId:"one"};
    return {hub,root,adapter,sessions,params};
  }
  it("starts a fresh conversation only when requested and preserves the previous one",async()=>{
    const {hub,sessions,params}=setup();await hub.turn(params);
    await hub.turn({...params,prompt:"Resume verified work",requestId:"two",forceFreshSession:true});
    expect(sessions).toHaveLength(2);expect(sessions[1].sent[0]).toContain("Role instructions");
    expect(hub.list(agent.companyId)).toHaveLength(2);
    await hub.turn({...params,prompt:"Continue",requestId:"three"});
    expect(sessions).toHaveLength(2);expect(sessions[1].sent[1]).not.toContain("Role instructions");
  });
  it("does not reopen an uncertain submission by forcing a fresh session",async()=>{
    const {hub,sessions,params}=setup();await hub.turn(params);
    sessions[0].waitForReply=async()=>({status:"timeout",text:"partial"});
    await hub.turn({...params,prompt:"second",requestId:"two"});
    await expect(hub.turn({...params,prompt:"third",requestId:"three",forceFreshSession:true})).rejects.toThrow(/غير محسومة/);
  });
  it("reopens an existing saved conversation without submitting a message",async()=>{
    const {hub,root,adapter,sessions,params}=setup();await hub.turn(params);
    const records=hub.list(agent.companyId),shown:string[]=[];
    const restarted=new BrowserSessionHub(root,()=>adapter,async id=>{shown.push(id);});
    const tab=await restarted.open(agent.companyId,records[0].key);
    expect(shown).toEqual([tab.id]);expect(sessions).toHaveLength(2);expect(sessions[1].sent).toHaveLength(0);
    expect(restarted.list(agent.companyId)[0].tabId).toBe(tab.id);
    await expect(restarted.open("another-company",records[0].key)).rejects.toThrow();
  });
  it("initializes once and caches a confirmed request",async()=>{
    const {hub,sessions,params}=setup();await hub.turn(params);await hub.turn(params);expect(sessions[0].sent).toHaveLength(1);
    await hub.turn({...params,prompt:"next",requestId:"two"});expect(sessions[0].sent[1]).not.toContain("Role instructions");
  });
  it("separates agents and projects on the same provider",async()=>{
    const {hub,sessions,params}=setup();await hub.turn(params);await hub.turn({...params,agentId:crypto.randomUUID()});await hub.turn({...params,projectId:crypto.randomUUID()});expect(sessions).toHaveLength(3);
  });
  it("restores a closed tab and retains successful initialization",async()=>{
    const {hub,root,adapter,sessions,params}=setup();await hub.turn(params);sessions[0].closed=true;
    const restarted=new BrowserSessionHub(root,()=>adapter);await restarted.turn({...params,prompt:"next",requestId:"two"});expect(sessions).toHaveLength(2);expect(sessions[1].sent[0]).not.toContain("Role instructions");
  });
  it("does not retry an uncertain submitted message",async()=>{
    const {hub,sessions,params}=setup();await hub.turn(params);
    sessions[0].waitForReply=async()=>({status:"timeout",text:"partial"});
    await hub.turn({...params,prompt:"second",requestId:"two"});
    await expect(hub.turn({...params,prompt:"third",requestId:"three"})).rejects.toThrow(/غير محسومة/);expect(sessions[0].sent).toHaveLength(2);
  });
  it("creates, inspects, and integrates isolated task workspace delivery", async () => {
    const root = temp();
    const companyId = "20000000-0000-4000-8000-000000000001";
    const projectId = "30000000-0000-4000-8000-000000000001";
    const taskId = "40000000-0000-4000-8000-000000000001";
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    
    // Prepare workspace
    const prepResult = await executeToolOutcome(
      call("prepare_task_workspace", { taskId }),
      root,
      { agent, companyId, projectId }
    );
    expect(prepResult.ok).toBe(true);
    const wsCwd = prepResult.data?.workspace?.cwd;
    expect(wsCwd).toBeDefined();
    expect(fs.existsSync(wsCwd)).toBe(true);

    // Make a file change in the isolated workspace
    fs.writeFileSync(path.join(wsCwd, "src.js"), 'console.log("hello");\n');

    // Inspect delivery
    const inspectResult = await executeToolOutcome(
      call("inspect_task_delivery", { taskId }),
      root,
      { agent, companyId, projectId }
    );
    expect(inspectResult.ok).toBe(true);
    expect(inspectResult.data?.inspection?.changes).toHaveLength(1);
    expect(inspectResult.data?.inspection?.changes[0].relativePath).toBe("src.js");
    const deliverySha256 = inspectResult.data?.inspection?.deliverySha256;

    // Integrate delivery
    const integrateResult = await executeToolOutcome(
      call("integrate_task_delivery", { taskId, expectedDeliverySha256: deliverySha256, allowedPaths: ["src.js"] }),
      root,
      { agent, companyId, projectId, autonomousWrites: true }
    );
    expect(integrateResult.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "src.js"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "src.js"), "utf8")).toBe('console.log("hello");\n');
  });
  it("plans a project and enforces contract validation", async () => {
    const root = temp();
    const companyId = "20000000-0000-4000-8000-000000000001";
    const projectId = "30000000-0000-4000-8000-000000000001";

    const contractInput = {
      goal: "Build a modular calculator web app",
      kind: "code",
      stack: ["vanilla", "html", "css", "js"],
      acceptanceCriteria: [
        { id: "crit-1", description: "Calculator UI renders and buttons work", expectedFiles: ["index.html"], command: "node -e \"require('node:fs').existsSync('index.html')\"" }
      ],
      modules: [
        {
          id: "ui",
          title: "UI module",
          role: "frontend",
          allowedPaths: ["index.html"],
          acceptanceCriteriaIds: ["crit-1"],
          dependencies: []
        }
      ],
      reviewPolicy: "independent"
    };

    const planResult = await executeToolOutcome(
      call("plan_project", contractInput),
      root,
      { agent: { ...agent, role: "ceo" }, companyId, projectId }
    );
    expect(planResult.ok).toBe(true);
    expect(planResult.data?.contract?.modules[0].id).toBe("ui");
    expect(planResult.data?.contract?.revision).toBe(1);

    // Verify contract is persisted
    const contractsDir = path.join(root, ".freellm", "contracts");
    expect(fs.existsSync(contractsDir)).toBe(true);
    const files = fs.readdirSync(contractsDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith(".json")).toBe(true);
  });
});
