import {beforeAll,afterAll,describe,it,expect} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";import crypto from "node:crypto";
import {companies,agents,issues,issueComments,heartbeatRuns,freellmToolReceipts,createDb,startEmbeddedPostgresTestDatabase} from "@paperclipai/db";
import {eq} from "drizzle-orm";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {executeToolOutcome} from "../adapters/freellm-browser/tool-executor.js";
import {runAgentTurnLoop} from "../adapters/freellm-browser/unified-engine.js";
import {configureFreeLLMRuntime,closeFreeLLMRuntime} from "../adapters/freellm-browser/runtime-context.js";
import {projectService} from "../services/projects.js";
import {resolveWorkspaceDirectory} from "../services/file-mutation-approval.js";
import {stageFileMutation} from "../services/file-mutation.js";
const enabled=process.env.FREELLM_INTEGRATION==="1";
(enabled?describe:describe.skip)("FreeLLM native database integration",()=>{
  let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>,root:string,companyId:string,ceo:any,binding:any;
  const wakes:any[]=[];
  beforeAll(async()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),"freellm-native-integration-"));
    database=await startEmbeddedPostgresTestDatabase("freellm-native-pg-");db=createDb(database.connectionString);companyId=crypto.randomUUID();
    await db.insert(companies).values({id:companyId,name:"FreeLLM integration fixture",issuePrefix:"FLT",requireBoardApprovalForNewAgents:false});
    [ceo]=await db.insert(agents).values({companyId,name:"Fixture Director",role:"ceo",status:"idle",adapterType:"freellm_browser",adapterConfig:{model:"gemini-default",cwd:root}}).returning();
    const projects=projectService(db),project=await projects.create(companyId,{name:"Fixture project",status:"in_progress"});
    const workspace=await projects.createWorkspace(project.id,{name:"Local",cwd:root,isPrimary:true});binding={projectId:project.id,projectWorkspaceId:workspace!.id};
    configureFreeLLMRuntime({db,databaseUrl:database.connectionString,wake:async(id,options)=>{wakes.push({id,...options});return {status:"queued",id:crypto.randomUUID()};}});
  },90000);
  afterAll(async()=>{await closeFreeLLMRuntime();configureFreeLLMRuntime({db:undefined,databaseUrl:undefined,wake:undefined,transport:undefined});await db?.$client.end({timeout:0});await database?.cleanup();if(root)fs.rmSync(root,{recursive:true,force:true});},30000);
  const call=(tool:string,args:any)=>({callId:crypto.randomUUID(),tool,arguments:args});
  it("creates a specialist, parent and child through native services and requests a real scheduled wake",async()=>{
    const context:any={agent:ceo,responsibleUserId:"fixture-board",runKey:crypto.randomUUID(),...binding};
    console.info("native integration: create specialist");
    const specialist=await executeToolOutcome(call("create_agent",{name:"Fixture developer",role:"engineer",model:"gemini-default"}),root,context,db,companyId);
    expect(specialist,JSON.stringify(specialist)).toMatchObject({ok:true});
    console.info("native integration: create parent");
    const parent=await executeToolOutcome(call("create_task",{title:"Build project",description:"Implement and integrate a small module",acceptanceCriteria:["Tests pass"]}),root,context,db,companyId);expect(parent,JSON.stringify(parent)).toMatchObject({ok:true});
    console.info("native integration: delegate child");
    const child=await executeToolOutcome(call("delegate_task",{agentId:specialist.data!.agentId,title:"Module",description:"Implement a compatible module in module.mjs",acceptanceCriteria:["Module test passes"]}),root,context,db,companyId);
    expect(child,JSON.stringify(child)).toMatchObject({ok:true});const [row]=await db.select().from(issues).where(eq(issues.id,String(child.data!.taskId)));
    expect(row.parentId).toBe(parent.data!.taskId);expect(row.projectWorkspaceId).toBe(binding.projectWorkspaceId);expect(wakes.at(-1).contextSnapshot.issueId).toBe(row.id);
    await db.insert(issueComments).values(Array.from({length:110},(_,index)=>({companyId,issueId:row.id,authorAgentId:ceo.id,authorType:"agent" as const,body:"Delivery "+index,createdAt:new Date(1700000000000+index*1000)})));
    await db.insert(issueComments).values({companyId,issueId:row.id,authorAgentId:ceo.id,authorType:"agent",body:"Deleted delivery",deletedAt:new Date(),createdAt:new Date(1800000000000)});
    const inspected=await executeToolOutcome(call("get_task",{taskId:row.id}),root,context,db,companyId);
    expect(inspected.data!.delivery.map((entry:any)=>entry.body)).toEqual(Array.from({length:8},(_,index)=>"Delivery "+(102+index)));

  },90000);
  it("retains previously changed files in verification after a task retry",async()=>{
    const {issueService}=await import("../services/issues.js");
    const issue=await issueService(db).create(companyId,{title:"Resume task",description:"Finish and verify the application.",assigneeAgentId:ceo.id,actorResponsibleUserId:"fixture-board",projectId:binding.projectId,projectWorkspaceId:binding.projectWorkspaceId,status:"todo"});
    fs.writeFileSync(path.join(root,"prior.js"),"console.log(1)");fs.writeFileSync(path.join(root,"later.html"),"<h1>done</h1>");
    await db.insert(freellmToolReceipts).values({companyId,agentId:ceo.id,issueId:issue.id,runKey:"old-run",callId:"old-call",argumentsHash:"hash",tool:"propose_file_mutation",status:"executed",result:{ok:true,mutated:true,data:{relativePath:"prior.js",targetPath:path.join(root,"prior.js"),operation:"create"}}});
    const responses=[call("verify_task",{expectedFiles:["later.html"],testCommand:"node --check prior.js"})];
    const prompts:string[]=[],events:any[]=[];
    const result=await runAgentTurnLoop({agentId:ceo.id,agent:ceo,db,companyId,issueId:issue.id,workspaceRoot:root,prompt:"Finish the application",intent:"work",...binding,
      transport:async({prompt}:any)=>{prompts.push(prompt);const next=responses.shift(),fence=String.fromCharCode(96).repeat(3);return {status:"ok",text:next?fence+"tool_call\n"+JSON.stringify(next)+"\n"+fence:"Done."};},onEvent:event=>{events.push(event);}});
    expect(result.lastStatus).toBe("blocked");expect(prompts[0]).toContain("prior.js");
    const verification=events.find(event=>event.type==="tool_result"&&event.tool==="verify_task");
    expect(JSON.parse(verification.result).data.checks).toContainEqual(expect.objectContaining({type:"coverage",path:"prior.js",passed:false}));
  },90000);
  it("runs persistent graph tools once, records receipts, verifies files and replays without side effects",async()=>{
    const id=crypto.randomUUID(),responses=[
      {callId:"create-deliverable",tool:"propose_file_mutation",arguments:{relativePath:"delivery.txt",operation:"create",content:"Verified delivery"}},
      {callId:"verify-deliverable",tool:"verify_task",arguments:{expectedFiles:["delivery.txt"]}},
    ];let modelCalls=0;
    const options={agentId:ceo.id,db,companyId,agent:ceo,workspaceRoot:root,runId:id,prompt:"Create delivery",intent:"work" as const,...binding,
      transport:async()=>{const next=responses.shift();modelCalls++;return {status:"ok",text:next?"```tool_call\n"+JSON.stringify(next)+"\n```":"Delivery verified."};}};
    const first=await runAgentTurnLoop(options);expect(first,JSON.stringify(first)).toMatchObject({lastStatus:"completed",verified:true});
    const second=await runAgentTurnLoop(options);expect(second.lastStatus).toBe("completed");expect(modelCalls).toBe(3);
    const receipts=await db.select().from(freellmToolReceipts).where(eq(freellmToolReceipts.runKey,ceo.id+":"+id));expect(receipts).toHaveLength(2);
    expect(fs.readFileSync(path.join(root,"delivery.txt"),"utf8")).toBe("Verified delivery");
  },30000);

  it("dispatches a real heartbeat through the browser adapter and produces a verified file",async()=>{
    const {heartbeatService}=await import("../services/heartbeat.js");
    const {issueService}=await import("../services/issues.js");
    const runtime=heartbeatService(db),responses=[
      {callId:"scheduled-write",tool:"propose_file_mutation",arguments:{relativePath:"scheduled.txt",operation:"create",content:"Scheduled agent delivery"}},
      {callId:"scheduled-verify",tool:"verify_task",arguments:{expectedFiles:["scheduled.txt"]}},
    ];
    configureFreeLLMRuntime({transport:async()=>{const next=responses.shift(),fence=String.fromCharCode(96).repeat(3);return {status:"ok",text:next?fence+"tool_call\n"+JSON.stringify(next)+"\n"+fence:"The scheduled delivery is verified."};}});
    const [worker]=await db.insert(agents).values({companyId,name:"Scheduled worker",role:"engineer",status:"idle",adapterType:"freellm_browser",adapterConfig:{model:"gemini-default",cwd:root}}).returning();
    const task=await issueService(db).create(companyId,{title:"Produce scheduled delivery",description:"Create scheduled.txt and verify its content.",assigneeAgentId:worker.id,actorResponsibleUserId:"fixture-board",projectId:binding.projectId,projectWorkspaceId:binding.projectWorkspaceId,status:"todo"});
    const run=await runtime.wakeup(worker.id,{source:"assignment",reason:"issue_assigned",requestedByActorType:"agent",requestedByActorId:ceo.id,payload:{issueId:task.id},contextSnapshot:{issueId:task.id,executionWorkspaceCwd:root,prompt:task.description}});
    expect(run).not.toBeNull();
    let final:any;
    for(let i=0;i<200;i++){
      [final]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run!.id));
      if(["succeeded","failed","cancelled","timed_out"].includes(final.status))break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    await runtime.waitForRunExecutionDrain(run!.id);
    configureFreeLLMRuntime({transport:undefined});
    expect(final,JSON.stringify(final)).toMatchObject({status:"succeeded"});
    expect(fs.readFileSync(path.join(root,"scheduled.txt"),"utf8")).toBe("Scheduled agent delivery");
    const [completed]=await db.select().from(issues).where(eq(issues.id,task.id));expect(completed.status).toBe("done");
  },90000);

  it("starts and stops a real project preview through the native runtime",async()=>{
    const net=await import("node:net");
    const port=await new Promise<number>((resolve,reject)=>{const server=net.createServer();server.on("error",reject);server.listen(0,"127.0.0.1",()=>{const value=server.address() as import("node:net").AddressInfo;server.close(()=>resolve(value.port));});});
    fs.writeFileSync(path.join(root,"preview.mjs"),'import http from "node:http";http.createServer((req,res)=>{res.setHeader("content-type","text/html");res.end("<h1>Verified preview</h1>");}).listen('+port+',"127.0.0.1");');
    const context:any={agent:ceo,responsibleUserId:"fixture-board",runKey:crypto.randomUUID(),...binding};
    await projectService(db).updateWorkspace(binding.projectId,binding.projectWorkspaceId,{runtimeConfig:{workspaceRuntime:{services:[{id:"existing-service",name:"Existing service",command:"node -e process.exit(27)",port:33334}]}}});
    try{
      const result=await executeToolOutcome(call("start_preview",{command:"node preview.mjs",port}),root,context,db,companyId);
      expect(result,JSON.stringify(result)).toMatchObject({ok:true});
      const response=await fetch("http://127.0.0.1:"+port);expect(await response.text()).toContain("Verified preview");
      const saved=(await projectService(db).listWorkspaces(binding.projectId)).find(w=>w.id===binding.projectWorkspaceId);expect((saved?.runtimeConfig?.workspaceRuntime as any).services.some((v:any)=>v.id==="existing-service")).toBe(true);
    }finally{
      const result=await executeToolOutcome(call("stop_preview",{}),root,context,db,companyId);expect(result,JSON.stringify(result)).toMatchObject({ok:true});
    }
  },30000);
  it("does not resolve another company's approval workspace",async()=>{
    const payload={...stageFileMutation(root,{relativePath:"pending.txt",operation:"create",content:"pending"}),workspaceId:binding.projectWorkspaceId};
    await expect(resolveWorkspaceDirectory(db,crypto.randomUUID(),payload)).rejects.toThrow(/company/);
  });
});
