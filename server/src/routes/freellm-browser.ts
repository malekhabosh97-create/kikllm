import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueComments, projectWorkspaces } from "@paperclipai/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { runAgentTurnLoop } from "../adapters/freellm-browser/unified-engine.js";
import { executeToolOutcome } from "../adapters/freellm-browser/tool-executor.js";
import { desktopConnection, desktopRequest, type DesktopTab } from "../adapters/freellm-browser/browser-provider/desktop-client.js";
import { browserSessionHub } from "../adapters/freellm-browser/browser-provider/session-hub.js";
import { globalModelRouter } from "../adapters/freellm-browser/browser-provider/model-router.js";
import { classifyProviderProbe } from "../adapters/freellm-browser/browser-provider/probe.js";
import { WEB_PROVIDERS } from "../adapters/freellm-browser/browser-provider/generic-adapter.js";
import { projectService } from "../services/projects.js";

const providerIds=["gemini","deepseek",...WEB_PROVIDERS.map(p=>p.id)];
export const DEFAULT_FREELLM_PROJECTS_DIR = path.join(os.homedir(), "Documents", "FreeLLM Projects");

function resolveTargetWorkspace(cwd: string, prompt?: string): string {
  const platformRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const isPlatform = samePath(cwd, platformRoot);
  const explicitInside = prompt ? /(?:داخل|في)\s+(?:هذا|نفس|المشروع الحالي)\s*(?:المشروع|المستودع)?/i.test(prompt) : false;
  const isNewProject = prompt ? /(?:اصنع|أنشئ|انشئ|اعمل|ابن|ابني|صمم|build|create|make)\s*(?:لي\s*)?(?:تطبيق|موقع|مشروع|برنامج|الة|آلة|حاسبة|حاسبه|لعبة|website|application|app|project|calculator)/i.test(prompt) : false;

  if (isPlatform && isNewProject && !explicitInside) {
    fs.mkdirSync(DEFAULT_FREELLM_PROJECTS_DIR, { recursive: true });
    let slug = "calculator";
    if (/calculator|حاسب/i.test(prompt || "")) slug = "calculator";
    else if (/game|لعب/i.test(prompt || "")) slug = "game";
    else if (/app|تطبيق/i.test(prompt || "")) slug = "app";
    const target = path.join(DEFAULT_FREELLM_PROJECTS_DIR, slug);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
  return cwd;
}

const jobs=new Map<string,{controller:AbortController;listeners:Set<(event:any)=>void>;meta:any;settled?:Promise<unknown>}>();
const runRoot=()=>path.join(os.homedir(),".paperclip","freellm","runs");
const runFile=(id:string,suffix:string)=>{if(!z.string().uuid().safeParse(id).success)throw new Error("معرف تشغيل غير صالح");return path.join(runRoot(),id+suffix);};
function events(id:string){try{return fs.readFileSync(runFile(id,".jsonl"),"utf8").split("\n").filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}catch{return [];}}
function metadata(id:string){const live=jobs.get(id);if(live)return live.meta;try{return JSON.parse(fs.readFileSync(runFile(id,".json"),"utf8"));}catch{return null;}}
export async function closeFreeLLMJobs(){const current=[...jobs.values()];for(const job of current)job.controller.abort(new Error("Application is shutting down"));await Promise.allSettled(current.map(job=>job.settled));}
export function freellmBrowserRouter(db:Db):Router {
  const router=Router();
  router.use((req,_res,next)=>{assertBoard(req);next();});
  const control=(req:any)=>assertInstanceAdmin(req);
  async function getAgent(req:any,id:string){
    const [agent]=await db.select().from(agents).where(eq(agents.id,id));
    if(!agent)throw new Error("الوكيل غير موجود");assertCompanyAccess(req,agent.companyId);return agent;
  }
  async function connectWorkspace(companyId:string,cwd:string,projectId?:string,prompt?:string) {
    const candidate = resolveTargetWorkspace(cwd || DEFAULT_FREELLM_PROJECTS_DIR, prompt);
    if (!fs.existsSync(candidate)) {
      if (path.resolve(candidate).startsWith(path.resolve(DEFAULT_FREELLM_PROJECTS_DIR))) {
        fs.mkdirSync(candidate, { recursive: true });
      } else {
        throw new Error("اختر مجلد مشروع موجودًا");
      }
    }
    if(!path.isAbsolute(candidate)||!fs.statSync(candidate).isDirectory())throw new Error("اختر مجلد مشروع موجودًا");
    const root=fs.realpathSync(candidate),service=projectService(db);
    if(projectId){
      const project=await service.getById(projectId);
      if(!project||project.companyId!==companyId)throw new Error("المشروع لا يتبع الشركة");
      const workspaces=await service.listWorkspaces(projectId);
      const matching=workspaces.find(w=>w.cwd&&path.resolve(w.cwd)===root);
      if(matching)return {projectId,workspaceId:matching.id,cwd:root};
      const workspace=await service.createWorkspace(projectId,{name:path.basename(root),cwd:root,isPrimary:true});
      if(!workspace)throw new Error("تعذر ربط مساحة العمل");return {projectId,workspaceId:workspace.id,cwd:root};
    }
    const existing=await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.companyId,companyId));
    const found=existing.find(w=>w.cwd&&path.resolve(w.cwd)===root);
    if(found)return {projectId:found.projectId,workspaceId:found.id,cwd:root};
    const project=await service.create(companyId,{name:path.basename(root),description:"مشروع محلي مُدار بواسطة FreeLLM Work",status:"in_progress"});
    const workspace=await service.createWorkspace(project.id,{name:path.basename(root),cwd:root,isPrimary:true});
    if(!workspace)throw new Error("تعذر إنشاء مساحة العمل");
    return {projectId:project.id,workspaceId:workspace.id,cwd:root};
  }
  async function conversation(agent:any,userId:string,binding?:any,create=true){
    const [existing]=await db.select().from(issues).where(and(eq(issues.companyId,agent.companyId),eq(issues.conversationAgentId,agent.id),eq(issues.conversationUserId,userId))).limit(1);
    if(existing||!create)return existing;
    const [created]=await db.insert(issues).values({companyId:agent.companyId,conversationAgentId:agent.id,conversationUserId:userId,conversationState:"active",assigneeAgentId:agent.id,
      title:"محادثة: "+agent.name,responsibleUserId:userId,status:"todo",priority:"medium",originKind:"conversation",projectId:binding?.projectId,projectWorkspaceId:binding?.workspaceId}).returning();
    return created;
  }
  router.get("/status",async(req,res)=>{
    control(req);
    if(!desktopConnection()){res.json({connected:false,embedded:true,tabs:[],providers:providerIds.map(id=>({id,state:"DISCONNECTED",message:"افتح تطبيق سطح المكتب"}))});return;}
    const status=await desktopRequest<{tabs:DesktopTab[]}>("status");
    let qualifications:Record<string,any>={};try{qualifications=JSON.parse(fs.readFileSync(path.join(runRoot(),"provider-checks.json"),"utf8"));}catch{}
    const providers=await Promise.all(providerIds.map(async id=>{
      if(!status.tabs.some(tab=>tab.provider===id))return {id,state:"NOT_OPEN",message:"لم يتم فتح المنصة",qualified:false};
      const health=await globalModelRouter.getAdapter(id).health();
      return {id,state:health.ok?"READY":health.isLoggedIn===false?"NEEDS_LOGIN":"NEEDS_ATTENTION",message:health.reason,qualified:Boolean(health.ok&&qualifications[id]?.passed),checkedAt:qualifications[id]?.checkedAt};
    }));
    res.json({connected:true,embedded:true,tabs:status.tabs,providers,isGenerating:[...jobs.values()].some(job=>job.meta.status==="running")});
  });
  router.get("/sessions",(req,res)=>{control(req);const company=String(req.query.companyId||"");assertCompanyAccess(req,company);res.json(browserSessionHub.list(company));});

  router.post("/sessions/open",async(req,res)=>{
    control(req);const input=z.object({companyId:z.string().uuid(),key:z.string().min(1)}).parse(req.body);
    assertCompanyAccess(req,input.companyId);res.json(await browserSessionHub.open(input.companyId,input.key));
  });
  router.post("/sessions/reset",(req,res)=>{
    control(req);const input=z.object({companyId:z.string().uuid(),key:z.string().min(1)}).parse(req.body);
    assertCompanyAccess(req,input.companyId);browserSessionHub.reset(input.companyId,input.key);res.json({status:"reset"});
  });
  router.post("/providers/:provider/probe",async(req,res)=>{
    control(req);const provider=String(req.params.provider);if(!providerIds.includes(provider))throw new Error("Unknown provider");
    if(browserSessionHub.isProviderBusy(provider)){res.status(409).json({error:"المنصة مشغولة بعمل أحد الوكلاء"});return;}
    const adapter=globalModelRouter.getAdapter(provider),health=await adapter.health();
    if(!health.ok){res.status(422).json({error:health.reason||"سجّل الدخول أولًا"});return;}
    const model=provider==="deepseek"?"deepseek-chat":provider+"-default",nonce="FREELLM_"+crypto.randomBytes(8).toString("hex");
    const session=await adapter.newChat(model);
    try{
      await session.send("Connection test. Reply with exactly this token and nothing else: "+nonce);
      const reply=await session.waitForReply({timeoutMs:60000,signal:AbortSignal.timeout(60000)});
      const {passed,exactInstruction,error}=classifyProviderProbe(reply,nonce);
      const file=path.join(runRoot(),"provider-checks.json");let checks:Record<string,unknown>={};try{checks=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
      const result={provider,passed,checkedAt:new Date().toISOString(),mode:model,capabilities:{textRoundTrip:passed,exactInstruction,attachments:false,modelSwitching:false},error};
      checks[provider]=result;fs.mkdirSync(runRoot(),{recursive:true});fs.writeFileSync(file,JSON.stringify(checks),{mode:0o600});res.json(result);
    }finally{if(session.tabId)await desktopRequest("tabs/close",{id:session.tabId}).catch(()=>{});else await session.close().catch(()=>{});}
  });
  router.get("/models/:provider",async(req,res)=>{control(req);res.json(await globalModelRouter.getAdapter(String(req.params.provider)).listModels());});
  async function open(req:any,res:any){
    control(req);const provider=String(req.params.provider||req.body.platform);
    if(!providerIds.includes(provider))throw new Error("منصة غير معروفة");
    const status=await desktopRequest<{tabs:DesktopTab[]}>("status");
    const tab=status.tabs.find(v=>v.id===req.body.tabId&&v.provider===provider)||status.tabs.find(v=>v.provider===provider&&v.purpose!=="conversation")||
      await desktopRequest<DesktopTab>("tabs/create",{provider});
    await desktopRequest("tabs/show",{id:tab.id});res.json(tab);
  }
  router.post("/providers/:provider/open",open);
  router.post("/tab/open",open);
  router.post("/tabs/:id/show",async(req,res)=>{control(req);res.json(await desktopRequest("tabs/show",{id:req.params.id}));});
  router.post("/tabs/:id/close",async(req,res)=>{control(req);res.json(await desktopRequest("tabs/close",{id:req.params.id}));});
  router.post("/show",async(req,res)=>{control(req);res.json(await desktopRequest("show",{}));});
  router.post("/minimize",async(req,res)=>{control(req);res.json(await desktopRequest("hide",{}));});
  router.post("/workspace/connect",async(req,res)=>{
    const input=z.object({companyId:z.string().uuid(),cwd:z.string().min(1),projectId:z.string().uuid().optional(),agentId:z.string().uuid().optional()}).parse(req.body);
    assertCompanyAccess(req,input.companyId);control(req);
    const agent=input.agentId?await getAgent(req,input.agentId):null;
    if(agent&&agent.companyId!==input.companyId)throw new Error("الوكيل لا يتبع الشركة");
    const binding=await connectWorkspace(input.companyId,input.cwd,input.projectId);
    const thread=agent?await conversation(agent,req.actor.userId||"local-board",binding):null;
    res.json({...binding,issueId:thread?.id});
  });
  router.get("/agent-chat/history",async(req,res)=>{
    const agent=await getAgent(req,String(req.query.agentId||""));
    const thread=await conversation(agent,req.actor.userId||"local-board",undefined,false);
    if(!thread){res.json({issueId:null,messages:[],activeRuns:[]});return;}
    const comments=await db.select().from(issueComments).where(and(eq(issueComments.companyId,agent.companyId),eq(issueComments.issueId,thread.id),isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(400);
    res.json({issueId:thread.id,messages:comments.reverse().filter(c=>!(c.authorAgentId&&/^أداة [a-z_]+\n\{/.test(c.body))).map(c=>({id:c.id,sender:c.authorAgentId?"agent":"user",text:c.body,timestamp:c.createdAt.toISOString()})),
      activeRuns:[...jobs.values()].filter(j=>j.meta.agentId===agent.id).map(j=>j.meta.id)});
  });
  router.post("/create-agent",async(req,res)=>{
    const input=z.object({companyId:z.string().uuid(),name:z.string().min(1),role:z.string().optional(),title:z.string().optional(),model:z.string().optional(),systemPrompt:z.string().min(20).optional()}).parse(req.body);
    assertCompanyAccess(req,input.companyId);control(req);
    const result=await executeToolOutcome({callId:crypto.randomUUID(),tool:"create_agent",arguments:input},process.cwd(),{},db,input.companyId);
    if(!result.ok){res.status(422).json({error:result.error});return;}
    const [agent]=await db.select().from(agents).where(eq(agents.id,String(result.data!.agentId)));res.status(201).json(agent);
  });

  router.post("/agents/:id/model",async(req,res)=>{
    control(req);const agent=await getAgent(req,String(req.params.id));
    const {model}=z.object({model:z.string().min(1)}).parse(req.body);
    const route=globalModelRouter.resolveRoute(model);
    if(!model.endsWith("-default")&&!["deepseek-chat","deepseek-reasoner"].includes(route.modelId)){
      const observed=await globalModelRouter.getAdapter(route.siteId).listModels();
      if(!observed.some(mode=>mode.id===route.modelId&&!mode.locked))throw new Error("النموذج غير متاح في الحساب");
    }
    const {agentService}=await import("../services/agents.js");
    const updated=await agentService(db).update(agent.id,{adapterType:"freellm_browser",adapterConfig:{...agent.adapterConfig,model}});
    const {logActivity}=await import("../services/activity-log.js");
    await logActivity(db,{companyId:agent.companyId,actorType:"user",actorId:req.actor.userId||"local-board",action:"agent.updated",entityType:"agent",entityId:agent.id,details:{model,source:"freellm.workbench"}});
    res.json(updated);
  });
  router.post("/agent-chat",async(req,res)=>{
    const input=z.object({agentId:z.string().uuid(),prompt:z.string().min(1).max(100000),workspaceRoot:z.string().min(1),projectId:z.string().uuid().optional(),requestId:z.string().uuid().optional(),intent:z.enum(["auto","work","research","answer"]).optional()}).parse(req.body);
    control(req);
    const agent=await getAgent(req,input.agentId),binding=await connectWorkspace(agent.companyId,input.workspaceRoot,input.projectId,input.prompt);
    const thread=await conversation(agent,req.actor.userId||"local-board",binding),id=input.requestId||crypto.randomUUID();
    const promptHash=crypto.createHash("sha256").update(JSON.stringify({prompt:input.prompt,projectId:binding.projectId,cwd:binding.cwd,intent:input.intent||"auto"})).digest("hex");
    let job=jobs.get(id);const old=metadata(id);
    if(old&&(old.companyId!==agent.companyId||old.agentId!==agent.id||old.promptHash!==promptHash))throw new Error("معرف التشغيل مستخدم في سياق آخر");
    res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"});
    let connected=true;
    const stream=(event:any)=>{if(connected&&!res.writableEnded){res.write("data: "+JSON.stringify(event)+"\n\n");if(event.type==="done")res.end();}};
    res.on("close",()=>{connected=false;job?.listeners.delete(stream);});
    if(old){for(const event of events(id))stream(event);if(old.status!=="running"){if(!res.writableEnded)res.end();return;}}
    if(!job){
      fs.mkdirSync(runRoot(),{recursive:true});
      const controller=new AbortController(),meta={id,companyId:agent.companyId,agentId:agent.id,issueId:thread.id,projectId:binding.projectId,workspaceId:binding.workspaceId,cwd:binding.cwd,promptHash,status:"running",createdAt:new Date().toISOString()};
      job={controller,listeners:new Set(),meta};jobs.set(id,job);
      fs.writeFileSync(runFile(id,".json"),JSON.stringify(meta),{mode:0o600});
      if(!old)await db.insert(issueComments).values({companyId:agent.companyId,issueId:thread.id,authorType:"user",body:input.prompt});
      const currentJob=job;
      let sequence=events(id).length;
      currentJob.listeners.add(stream);
      const onEvent=async(event:any)=>{
        const enriched={...event,runId:id,issueId:thread.id,sequence:++sequence};
        fs.appendFileSync(runFile(id,".jsonl"),JSON.stringify(enriched)+"\n",{mode:0o600});
        if(event.type==="status"){meta.status=event.status||meta.status;fs.writeFileSync(runFile(id,".json"),JSON.stringify(meta),{mode:0o600});}
        for(const listener of currentJob.listeners)listener(enriched);
      };
      currentJob.settled=runAgentTurnLoop({agentId:agent.id,prompt:input.prompt,workspaceRoot:binding.cwd,projectId:binding.projectId,projectWorkspaceId:binding.workspaceId,
        db,companyId:agent.companyId,responsibleUserId:req.actor.userId||"local-board",issueId:thread.id,runId:id,intent:input.intent,signal:controller.signal,onEvent}).catch(async error=>{
          meta.status="failed";await onEvent({type:"error",message:(error as Error).message});await onEvent({type:"status",status:"failed"});await onEvent({type:"done",status:"failed"});
        }).finally(()=>{currentJob.listeners.clear();jobs.delete(id);});
    }else job.listeners.add(stream);
  });
  router.get("/runs/:id/events",(req,res)=>{
    const id=String(req.params.id),meta=metadata(id);if(!meta){res.status(404).json({error:"التشغيل غير موجود"});return;}
    assertCompanyAccess(req,meta.companyId);
    res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"});
    const after=Number(req.query.after)||0;
    const stream=(event:any)=>{if(!res.writableEnded){res.write("data: "+JSON.stringify(event)+"\n\n");if(event.type==="done")res.end();}};
    for(const event of events(id).filter(v=>v.sequence>after))stream(event);
    const job=jobs.get(id);if(job){job.listeners.add(stream);res.on("close",()=>job.listeners.delete(stream));}else if(!res.writableEnded)res.end();
  });
  router.post("/runs/:id/cancel",(req,res)=>{
    const id=String(req.params.id),meta=metadata(id);if(!meta){res.status(404).json({error:"التشغيل غير موجود"});return;}
    assertCompanyAccess(req,meta.companyId);control(req);const job=jobs.get(id);
    if(!job){res.status(409).json({error:"التشغيل غير نشط"});return;}
    job.controller.abort(new Error("أُلغي التشغيل بواسطة المستخدم"));res.json({status:"cancelling"});
  });
  return router;
}
