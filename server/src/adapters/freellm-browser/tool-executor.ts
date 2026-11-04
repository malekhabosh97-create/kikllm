import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueComments, freellmToolReceipts, workspaceRuntimeServices } from "@paperclipai/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FreeLLMToolOutcome } from "@paperclipai/shared";
import { stageFileMutation, applyFileMutation, assertSafeWorkspacePath } from "../../services/file-mutation.js";
import {roleInstructions} from "./role-instructions.js";
import { freeLLMRuntime } from "./runtime-context.js";
import { readPublicSource as readPublicUrl } from "./public-source.js";
import { projectContractInputSchema } from "./project-contract.js";

const schemas: Record<string, z.ZodType<any>> = {
  get_project_context: z.object({ path: z.string().optional() }),
  list_dir: z.object({ path: z.string().optional() }),
  read_file: z.object({ path: z.string(), startLine: z.number().int().positive().optional(), maxLines: z.number().int().min(1).max(600).optional() }),
  search_code: z.object({ query: z.string().min(1), path: z.string().optional() }),
  run_command: z.object({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(120000).optional() }),
  propose_file_mutation: z.object({ relativePath: z.string().min(1), operation: z.enum(["create","modify","delete"]), content: z.string().optional(),baseSha256:z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  list_agents: z.object({}),
  create_agent: z.object({ name: z.string().min(1).max(100), role: z.string().optional(), title: z.string().optional(), model: z.string().optional(), systemPrompt: z.string().min(20).optional(), reportsTo: z.string().uuid().optional(), canCreateAgents:z.boolean().optional() }),
  delegate_task: z.object({ agentId: z.string().uuid(), title: z.string().min(1), description: z.string().min(10), acceptanceCriteria: z.array(z.string().min(1)).min(1), parentId: z.string().uuid().optional(), priority: z.enum(["low","medium","high","urgent"]).optional() }),
  create_task:z.object({title:z.string().min(1),description:z.string().min(10),acceptanceCriteria:z.array(z.string().min(1)).min(1)}),
  list_providers:z.object({}),
  assign_model:z.object({agentId:z.string().uuid(),model:z.string().min(1),reason:z.string().min(10)}),
  start_preview:z.object({command:z.string().min(1),port:z.number().int().min(1024).max(65535)}),
  stop_preview:z.object({}),
  get_task: z.object({ taskId: z.string().uuid() }),
  list_tasks: z.object({}),
  send_agent_message: z.object({ targetAgentId: z.string().uuid(), message: z.string().min(1) }),
  verify_task: z.object({ expectedFiles: z.array(z.string()).optional(), deletedFiles:z.array(z.string()).optional(), testCommand: z.string().optional(), agentIds: z.array(z.string().uuid()).optional(), taskIds: z.array(z.string().uuid()).optional(), sources: z.array(z.string().url()).optional() }),
  fetch_url: z.object({ url: z.string().url() }),
  github_search: z.object({ query: z.string().min(1) }),
  huggingface_search: z.object({ query: z.string().min(1), type: z.enum(["models","datasets","spaces"]).optional() }),
  web_search: z.object({ query: z.string().min(1) }),
  save_project_note: z.object({ title: z.string().min(1), content: z.string().min(1) }),
  plan_project: projectContractInputSchema.extend({
    expectedRevision: z.number().int().min(1).optional(),
  }),
  run_project_acceptance: z.object({
    expectedRevision: z.number().int().min(1),
    moduleId: z.string().optional(),
  }),
  review_project_delivery: z.object({
    expectedRevision: z.number().int().min(1),
    moduleId: z.string().min(1),
    approved: z.boolean(),
    summary: z.string().min(1),
  }),
  prepare_task_workspace: z.object({
    taskId: z.string().uuid(),
  }),
  inspect_task_delivery: z.object({
    taskId: z.string().uuid(),
  }),
  integrate_task_delivery: z.object({
    taskId: z.string().uuid(),
    expectedDeliverySha256: z.string().regex(/^[a-f0-9]{64}$/),
    allowedPaths: z.array(z.string()).optional(),
  }),
  search_native_tools: z.object({
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    schemaTool: z.string().min(1).max(512).optional(),
    schemaOffset: z.number().int().min(0).optional(),
  }),
  call_native_tool: z.object({
    name: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).max(256),
  }),
  list_native_skills: z.object({
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  read_native_skill: z.object({
    key: z.string().min(1).max(512),
    offset: z.number().int().min(0).optional(),
  }),
};
export interface ParsedToolCall { callId: string; tool: string; arguments: Record<string, any>; }
export interface ToolContext {
  agent?: any; executionWorkspaceId?:string; responsibleUserId?:string; issueId?: string; projectId?: string; projectWorkspaceId?: string; runKey?: string; runId?: string; companyId?: string;
  signal?: AbortSignal; autonomousWrites?: boolean; allowCommands?: boolean; parentTaskId?:string; requiredFiles?:string[]; requireTestCommand?:boolean; requiredDeletedFiles?:string[]; readHashes?:Record<string,string>;
}
export const TOOL_INSTRUCTIONS = `
You are a working agent with local tools. Give a SHORT plan (2-4 steps) and start execution; do not wait for approval of routine authorized work.
For an action emit exactly one top-level fenced tool_call JSON block:
\`\`\`tool_call
{"callId":"unique-id","tool":"read_file","arguments":{"path":"README.md"}}
\`\`\`
Wait for TOOL_RESULT, inspect its ok/status fields, and continue in the SAME conversation.
Never execute or reproduce tool examples as real calls. Never claim a queued task finished.
Tools:
get_project_context {path?}; list_dir {path?}; read_file {path,startLine?,maxLines?}; search_code {query,path?};
run_command {command,timeoutMs?}; propose_file_mutation {relativePath,operation:"create"|"modify"|"delete",content?,baseSha256?};
list_agents {}; create_agent {name,role?,title?,model?,systemPrompt,reportsTo?,canCreateAgents?};
list_providers {}; assign_model {agentId,model,reason};
create_task {title,description,acceptanceCriteria:[...]}; start_preview {command,port}; stop_preview {};
delegate_task {agentId,title,description,acceptanceCriteria:[...],parentId?,priority?};
get_task {taskId}; list_tasks {}; send_agent_message {targetAgentId,message};
verify_task {expectedFiles?,deletedFiles?,testCommand?,agentIds?,taskIds?,sources?};
plan_project {goal,kind:"code"|"research"|"content",stack:[...],acceptanceCriteria:[{id,description,expectedFiles:[...],command?}],modules:[{id,title,role,allowedPaths:[...],acceptanceCriteriaIds:[...],dependencies:[...]}],reviewPolicy?:"independent"|"checks",expectedRevision?};
run_project_acceptance {expectedRevision,moduleId?}; review_project_delivery {expectedRevision,moduleId,approved,summary};
prepare_task_workspace {taskId,allowWorktree?}; inspect_task_delivery {taskId}; integrate_task_delivery {taskId,expectedDeliverySha256,allowedPaths?};
search_native_tools {query?,offset?,limit?,schemaTool?,schemaOffset?}; call_native_tool {name,arguments,idempotencyKey};
list_native_skills {query?,offset?,limit?}; read_native_skill {key,offset?};
web_search {query}; fetch_url {url}; github_search {query}; huggingface_search {query,type?};
save_project_note {title,content}.
Use relative file paths within the selected project. Read files before editing. Follow existing conventions.
For large work, use the existing assigned task as parent, or create one if needed, then delegate children.
If asked to build an application, deliver a usable interface as well as its logic and tests. Tell the operator the actual project location. Complete missing parts before claiming success.
Write the shared project contract to .freellm/project.md BEFORE delegation: goal, stack, module boundaries, interfaces, allowed files, dependency order, test commands and acceptance criteria.
Give managers canCreateAgents:true only when they need to build their team. Do not create duplicate specialists. Many logical agents are allowed; website turns queue per account.
Delegated tasks must include shared technical conventions, interfaces, allowed files, dependencies and acceptance criteria.
Use independent reviewers for complex changes and integrate children before verifying the parent. A vote or benchmark never substitutes for tests.
Call list_providers before choosing an account; select only available live modes. For benchmark claims retrieve official sources and dates, mark missing evidence; never invent rankings or model versions.
Use start_preview for preview services; do not leave unmanaged background commands. The local Windows shell supports PowerShell via powershell -NoProfile -Command. Commands run with the operator OS permissions, not in an OS sandbox.
Use existing specialists when suitable. New specialists need detailed role instructions. Respect manager/reporting relationships.
Search and read primary sources for research; cite URLs that were actually retrieved. Findings are proposals until tested.
Implementation work MUST pass verify_task after the last modification. Empty checks cannot pass.
If work is blocked, report the concrete blocker. Do not pretend model choice, tests, files or child work succeeded.
After verified completion give a concise summary and output references, without tool blocks.
`;
export function isIllustrativeContext(text: string, _start = 0, _end = text.length): boolean {
  return /(?:do not execute|illustrative example|example only|على سبيل المثال|نموذج توضيحي|لا تنفذ)/i.test(text);
}
function extractBalancedJsonObject(raw: string): any {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); }
          catch { return null; }
        }
      }
    }
  }
  return null;
}
export function parseToolCall(response: string): ParsedToolCall | null {
  const text = response.trim();
  if (!text) return null;
  const lines = text.split("\n");
  if (lines.length > 0 && lines.every(l => l.trim().startsWith(">"))) return null;

  const fenceRegex = /```(?:tool_call|json)?\s*\n([\s\S]*?)\n```/g;
  const matches = [...text.matchAll(fenceRegex)];
  if (matches.length > 0) {
    for (const match of matches) {
      const surrounding = text.slice(0, match.index) + text.slice((match.index || 0) + match[0].length);
      if (isIllustrativeContext(surrounding)) continue;
      let value: any = null;
      try { value = JSON.parse(match[1].trim()); }
      catch { value = extractBalancedJsonObject(match[1]); }
      if (!value || value.example || typeof value.callId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.callId) || !schemas[value.tool]) continue;
      if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) continue;
      return { callId: value.callId, tool: value.tool, arguments: value.arguments };
    }
    return null;
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    if (isIllustrativeContext(text)) return null;
    let value: any = null;
    try { value = JSON.parse(text); }
    catch { value = extractBalancedJsonObject(text); }
    if (!value || value.example || typeof value.callId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.callId) || !schemas[value.tool]) return null;
    if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) return null;
    return { callId: value.callId, tool: value.tool, arguments: value.arguments };
  }
  return null;
}
function safePath(root: string, relative: string) {
  if (path.isAbsolute(relative)) throw new Error("استخدم مسارًا نسبيًا داخل المشروع");
  if (relative.split(/[\\/]/).some(segment => [".git",".env",".browser-profile",".freellm-runtime"].includes(segment) || segment.startsWith(".env."))) throw new Error("هذا الملف خارج نطاق الأدوات");
  return assertSafeWorkspacePath(root, relative);
}
export async function runWorkspaceCommand(command: string, root: string, signal?: AbortSignal, timeout = 60000) {
  if (/\b(format|diskpart|shutdown|mkfs)\b|Remove-Item\s.*-Recurse|rm\s+-rf|del\s+\/s/i.test(command)) throw new Error("الأمر يتجاوز صلاحيات العمل على المشروع");
  return new Promise<{exitCode:number;stdout:string;stderr:string}>((resolve,reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("Cancelled"));
    const child = exec(command, { cwd: root, timeout, maxBuffer: 1024*1024, windowsHide:true }, (error,stdout,stderr) => {
      signal?.removeEventListener("abort", abort);
      resolve({exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout:stdout.slice(-16000), stderr:stderr.slice(-8000)});
    });
    const abort = () => {
      if (process.platform === "win32" && child.pid) {
        import("node:child_process").then(({spawn}) => spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}));
      } else child.kill("SIGTERM");
    };
    signal?.addEventListener("abort",abort,{once:true});
  });
}
function requireDatabase(db?: Db): Db { if (!db) throw new Error("قاعدة البيانات غير متصلة؛ لم يتم تنفيذ الإجراء"); return db; }
export async function executeToolOutcome(call: ParsedToolCall, root: string, context: ToolContext = {}, db?: Db, companyId?: string): Promise<FreeLLMToolOutcome> {
  const company = companyId || context.agent?.companyId;
  try {
    context.signal?.throwIfAborted();
    const schema=schemas[call.tool]; if(!schema) throw new Error("أداة غير معروفة");
    const args=schema.parse(call.arguments);
    switch(call.tool) {
      case "get_project_context": {
        const target=args.path?safePath(root,args.path):root;
        const names=fs.readdirSync(target,{withFileTypes:true}).filter(e=>!["node_modules",".git",".browser-profile",".freellm-runtime",".paperclip",".venv"].includes(e.name));
        let pkg:any={};try{pkg=JSON.parse(fs.readFileSync(path.join(target,"package.json"),"utf8"));}catch{}
        const scripts=pkg.scripts&&typeof pkg.scripts==="object"?pkg.scripts:{};
        const commands=Object.fromEntries(["dev","start","build","test","lint","typecheck","check","preview"].filter(name=>typeof scripts[name]==="string").map(name=>[name,scripts[name]]));
        return {ok:true,status:"executed",data:{root:target,name:pkg.name,commands,structure:names.slice(0,60).map(e=>e.name+(e.isDirectory()?"/":""))}};
      }
      case "list_dir": {
        const target=safePath(root,args.path||".");
        return {ok:true,status:"executed",data:{entries:fs.readdirSync(target,{withFileTypes:true}).filter(e=>!["node_modules",".git"].includes(e.name)).slice(0,250).map(e=>({name:e.name,directory:e.isDirectory()}))}};
      }
      case "read_file": {
        const file=safePath(root,args.path); const stat=fs.statSync(file);
        if(!stat.isFile()||stat.size>1024*1024)throw new Error("الملف غير نصي أو كبير جدًا");
        const content=fs.readFileSync(file,"utf8"), lines=content.split(/\r?\n/), start=args.startLine||1, count=args.maxLines||300;
        return {ok:true,status:"executed",data:{path:args.path,sha256:crypto.createHash("sha256").update(content).digest("hex"),totalLines:lines.length,content:lines.slice(start-1,start-1+count).map((line,i)=>(i+start)+": "+line).join("\n")}};
      }
      case "search_code": {
        const results:string[]=[]; let visited=0;
        const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(results.length>=50||visited++>5000)return;if(entry.name.startsWith(".")||["node_modules","dist","build"].includes(entry.name)||entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile()&&fs.statSync(file).size<300000){try{const text=fs.readFileSync(file,"utf8");for(const [i,line] of text.split(/\r?\n/).entries())if(line.includes(args.query)){results.push(path.relative(root,file)+":"+(i+1)+": "+line.slice(0,250));if(results.length>=50)break;}}catch{}}}};
        walk(safePath(root,args.path||".")); return {ok:true,status:"executed",data:{matches:results}};
      }
      case "run_command": {
        if(context.allowCommands===false)throw new Error("الطرفية غير مفعّلة لهذا التشغيل");
        const data=await runWorkspaceCommand(args.command,root,context.signal,args.timeoutMs);
        return {ok:data.exitCode===0,status:data.exitCode===0?"executed":"failed",data};
      }
      case "propose_file_mutation": {
        safePath(root,args.relativePath);
        const staged=stageFileMutation(root,args);
        if(args.operation!=="create"){const expected=args.baseSha256||context.readHashes?.[args.relativePath];if(context.runKey&&!expected)throw new Error("Read the file before editing and use its SHA-256");if(expected&&expected!==staged.baseSha256)throw new Error("File changed after it was read; read it again before editing");}
        if(context.autonomousWrites!==false) {
          const result=applyFileMutation(root,staged);
          return {ok:true,status:"executed",mutated:true,data:{...result,relativePath:staged.relativePath,diff:staged.diff,sha256:staged.stagedSha256}};
        }
        const database=requireDatabase(db);
        if(!company||!(context.executionWorkspaceId||context.projectWorkspaceId))throw new Error("الموافقة تحتاج مساحة عمل مرتبطة بالمشروع");
        const {approvalService}=await import("../../services/approvals.js");
        const approval=await approvalService(database).create(company,{type:"file_mutation",requestedByAgentId:context.agent?.id,payload:{...staged,workspaceId:context.executionWorkspaceId||context.projectWorkspaceId,issueId:context.issueId}});
        return {ok:true,status:"pending_approval",data:{approvalId:approval.id,diff:staged.diff}};
      }
      case "list_agents": {
        const database=requireDatabase(db); if(!company)throw new Error("شركة غير محددة");
        const rows=await database.select().from(agents).where(eq(agents.companyId,company));
        return {ok:true,status:"executed",data:{agents:rows.map(a=>({id:a.id,name:a.name,role:a.role,title:a.title,status:a.status,reportsTo:a.reportsTo,model:(a.adapterConfig as any)?.model}))}};
      }
      case "create_agent": {
        const database=requireDatabase(db); if(!company)throw new Error("شركة غير محددة");
        if(context.agent && context.agent.role!=="ceo" && !(context.agent.permissions as any)?.canCreateAgents)throw new Error("الوكيل غير مخوّل بإنشاء مختصين");
        const {globalModelRouter}=await import("./browser-provider/model-router.js");
        globalModelRouter.resolveRoute(args.model||"gemini-default");
        const {agentService}=await import("../../services/agents.js");
        const row=await agentService(database).create(company,{name:args.name,role:args.role||"engineer",title:args.title,reportsTo:args.reportsTo||context.agent?.id,adapterType:"freellm_browser",adapterConfig:{model:args.model||"gemini-default",systemPrompt:roleInstructions(args.role||"engineer",args.systemPrompt),cwd:root},status:"idle",permissions:{canCreateAgents:args.canCreateAgents===true}});
        return {ok:true,status:"executed",data:{agentId:row.id,name:row.name,model:(row.adapterConfig as any).model}};
      }

      case "list_providers": {
        const {globalModelRouter}=await import("./browser-provider/model-router.js");
        const providers=await Promise.all(["gemini","deepseek","chatgpt","claude","qwen","grok","glm","arena"].map(async id=>{
          const adapter=globalModelRouter.getAdapter(id),health=await adapter.health();
          return {provider:id,...health,defaultModel:id+"-default",models:health.ok?await adapter.listModels().catch(()=>[]):[],requiresTaskVerification:true};
        }));
        return {ok:true,status:"executed",data:{providers,concurrencyPerAccount:1,selectionRule:"Choose a ready account and an observed mode. Research official benchmark evidence for the specific task; benchmark rank does not prove this free account exposes that model."}};
      }
      case "assign_model": {
        const database=requireDatabase(db);if(!company)throw new Error("Company is required");
        if(context.agent&&context.agent.role!=="ceo"&&!(context.agent.permissions as any)?.canCreateAgents)throw new Error("Only a manager can assign provider routes");
        const [target]=await database.select().from(agents).where(and(eq(agents.id,args.agentId),eq(agents.companyId,company)));
        if(!target)throw new Error("Agent not found in this company");
        const {globalModelRouter}=await import("./browser-provider/model-router.js");
        const route=globalModelRouter.resolveRoute(args.model),adapter=globalModelRouter.getAdapter(route.siteId);
        const health=await adapter.health();if(!health.ok)throw new Error(health.reason||"Provider is not ready");
        if(!args.model.endsWith("-default")&&!["deepseek-chat","deepseek-reasoner"].includes(route.modelId)){
          const models=await adapter.listModels();if(!models.some(m=>m.id===route.modelId&&!m.locked))throw new Error("Requested model was not observed as available");
        }
        const {agentService}=await import("../../services/agents.js");
        await agentService(database).update(target.id,{adapterConfig:{...target.adapterConfig,model:args.model},adapterType:"freellm_browser"});
        return {ok:true,status:"executed",data:{agentId:target.id,model:args.model,reason:args.reason}};
      }
      case "create_task": {
        const database=requireDatabase(db);if(!company)throw new Error("Company is required");
        const {issueService}=await import("../../services/issues.js");
        const task=await issueService(database).create(company,{title:args.title,description:args.description+"\n\nAcceptance criteria:\n"+args.acceptanceCriteria.map((v:string)=>"- "+v).join("\n"),
          assigneeAgentId:context.agent?.id,actorResponsibleUserId:context.responsibleUserId,parentId:context.parentTaskId,projectId:context.projectId,projectWorkspaceId:context.projectWorkspaceId,status:"in_progress",priority:"medium",
          idempotencyKey:"freellm:"+context.runKey+":"+call.callId});
        context.parentTaskId=task.id;
        return {ok:true,status:"executed",data:{taskId:task.id,status:task.status}};
      }
      case "start_preview":
      case "stop_preview": {
        const database=requireDatabase(db);
        if(!company||!context.projectId||!context.projectWorkspaceId)throw new Error("Preview requires a bound project workspace");
        const {projectService}=await import("../../services/projects.js"),projects=projectService(database);
        const workspace=(await projects.listWorkspaces(context.projectId)).find(w=>w.id===context.projectWorkspaceId&&w.companyId===company);
        if(!workspace||!workspace.cwd||fs.realpathSync(workspace.cwd)!==fs.realpathSync(root))throw new Error("Preview workspace does not match");
        const runtime=await import("../../services/workspace-runtime.js");
        if(call.tool==="stop_preview"){const rows=await database.select().from(workspaceRuntimeServices).where(and(eq(workspaceRuntimeServices.companyId,company),eq(workspaceRuntimeServices.projectWorkspaceId,workspace.id)));for(const service of rows.filter(v=>["FreeLLM Preview","معاينة المشروع"].includes(v.serviceName)))await runtime.stopRuntimeServicesForProjectWorkspace({db:database,projectWorkspaceId:workspace.id,runtimeServiceId:service.id});return {ok:true,status:"executed",data:{stopped:true}};}
        if(context.allowCommands===false)throw new Error("Commands are disabled for this agent");
        const previousServices=Array.isArray((workspace.runtimeConfig as any)?.workspaceRuntime?.services)?(workspace.runtimeConfig as any).workspaceRuntime.services:[];
        const keptServices=previousServices.filter((v:any)=>v.id!=="freellm-preview"&&!["FreeLLM Preview","معاينة المشروع"].includes(v.name));
        const config={...(workspace.runtimeConfig||{}),workspaceRuntime:{...((workspace.runtimeConfig as any)?.workspaceRuntime||{}),services:[...keptServices,{id:"freellm-preview",name:"FreeLLM Preview",command:args.command,port:args.port,readiness:{type:"http",urlTemplate:"http://127.0.0.1:{{port}}",timeoutSec:30,intervalMs:250},expose:{type:"url",urlTemplate:"http://127.0.0.1:{{port}}"},lifecycle:"shared"}]},desiredState:"running" as const};
        await projects.updateWorkspace(context.projectId,workspace.id,{runtimeConfig:config});
        const services=await runtime.startRuntimeServicesForWorkspaceControl({db:database,actor:{id:context.agent?.id||null,name:context.agent?.name||"FreeLLM",companyId:company},issue:null,
          workspace:{baseCwd:root,source:"project_primary",projectId:context.projectId,workspaceId:workspace.id,repoUrl:null,repoRef:null,strategy:"project_primary",cwd:root,branchName:null,worktreePath:null,warnings:[],created:false,branchCreatedByRuntime:false},
          config,serviceIndex:keptServices.length,adapterEnv:{}});
        return {ok:services.some(v=>v.status==="running"),status:services.some(v=>v.status==="running")?"executed":"failed",data:{services}};
      }
      case "delegate_task": {
        const database=requireDatabase(db); if(!company)throw new Error("شركة غير محددة");
        const [target]=await database.select().from(agents).where(and(eq(agents.id,args.agentId),eq(agents.companyId,company)));
        if(!target)throw new Error("الوكيل المستلم غير موجود في هذه الشركة");
        const {issueService}=await import("../../services/issues.js");
        let parentId=args.parentId||context.parentTaskId;
        if(parentId){const parent=await issueService(database).getById(parentId);if(!parent||parent.companyId!==company||parent.originKind==="conversation")throw new Error("المهمة الأم غير مناسبة");}
        const task=await issueService(database).create(company,{
          title:args.title,description:args.description+"\n\nمعايير القبول:\n"+args.acceptanceCriteria.map((v:string)=>"- "+v).join("\n")+"\n\nمجلد المشروع: "+root,
          assigneeAgentId:target.id,actorResponsibleUserId:context.responsibleUserId,parentId,projectId:context.projectId,projectWorkspaceId:context.projectWorkspaceId,priority:args.priority||"medium",status:"todo",
          idempotencyKey:"freellm:"+context.runKey+":"+call.callId,
        });
        const wake=freeLLMRuntime().wake;if(!wake)throw new Error("المهمة سُجلت لكن مجدول التشغيل غير متصل. رقم المهمة: "+task.id);
        const run=await wake(target.id,{source:"assignment",reason:"issue_assigned",requestedByActorType:"agent",requestedByActorId:context.agent?.id,
          idempotencyKey:"freellm-delegate:"+task.id, payload:{issueId:task.id},contextSnapshot:{issueId:task.id,responsibleUserId:context.responsibleUserId,prompt:task.description,executionWorkspaceCwd:root,source:"freellm.delegate"}});
        if(!run)throw new Error("المجدول لم يؤكد تشغيل المهمة "+task.id);
        return {ok:true,status:"executed",data:{taskId:task.id,agentId:target.id,run,status:"queued"}};
      }
      case "get_task":
      case "list_tasks": {
        const database=requireDatabase(db); if(!company)throw new Error("شركة غير محددة");
        const rows=await database.select().from(issues).where(call.tool==="get_task"?and(eq(issues.companyId,company),eq(issues.id,args.taskId)):and(eq(issues.companyId,company),context.projectId?eq(issues.projectId,context.projectId):undefined)).limit(100);

        let delivery:any[]=[];
        if(call.tool==="get_task"&&rows[0])delivery=await database.select({body:issueComments.body,createdAt:issueComments.createdAt}).from(issueComments).where(and(eq(issueComments.companyId,company),eq(issueComments.issueId,rows[0].id),isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(8);
        return {ok:true,status:"executed",data:{tasks:rows.map(v=>({id:v.id,title:v.title,description:v.description,status:v.status,parentId:v.parentId,assigneeAgentId:v.assigneeAgentId,projectId:v.projectId,projectWorkspaceId:v.projectWorkspaceId,executionWorkspaceId:v.executionWorkspaceId})),delivery:delivery.reverse()}};

      }
      case "send_agent_message": {
        const database=requireDatabase(db); if(!company)throw new Error("شركة غير محددة");
        const [target]=await database.select().from(agents).where(and(eq(agents.id,args.targetAgentId),eq(agents.companyId,company)));
        if(!target)throw new Error("الوكيل المستلم غير موجود في هذه الشركة");
        const wake=freeLLMRuntime().wake;if(!wake)throw new Error("المجدول غير متصل");
        const result=await wake(target.id,{source:"on_demand",reason:"agent_message",requestedByActorType:"agent",requestedByActorId:context.agent?.id,idempotencyKey:"freellm-message:"+context.runKey+":"+call.callId,payload:{message:args.message},contextSnapshot:{responsibleUserId:context.responsibleUserId,prompt:"رسالة من "+(context.agent?.name||"الفريق")+":\n"+args.message,executionWorkspaceCwd:root,source:"freellm.message"}});
        if(!result)throw new Error("تعذر تأكيد تسليم الرسالة للمجدول");
        return {ok:true,status:"executed",data:{agentId:target.id,delivery:"queued",run:result}};
      }
      case "verify_task": {
        const checks:any[]=[];
        for(const relative of args.expectedFiles||[]) {
          try{const file=safePath(root,relative),stat=fs.statSync(file);checks.push({type:"file",path:relative,passed:stat.isFile()&&stat.size>0,sha256:stat.isFile()?crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"):undefined});}
          catch(error){checks.push({type:"file",path:relative,passed:false,error:String(error)});}
        }
        if(args.testCommand){if(context.allowCommands===false)throw new Error("Commands are disabled for this run");const result=await runWorkspaceCommand(args.testCommand,root,context.signal);checks.push({type:"tests",passed:result.exitCode===0,...result});}
        for(const id of args.agentIds||[]){const database=requireDatabase(db);const [row]=await database.select().from(agents).where(and(eq(agents.id,id),eq(agents.companyId,company!)));checks.push({type:"agent",id,passed:Boolean(row)});}
        for(const id of args.taskIds||[]){const database=requireDatabase(db);const [row]=await database.select().from(issues).where(and(eq(issues.id,id),eq(issues.companyId,company!)));checks.push({type:"task",id,passed:row?.status==="done",status:row?.status});}
        for(const url of args.sources||[]){try{const source=await readPublicUrl(url);checks.push({type:"source",url,passed:source.content.length>100});}catch(error){checks.push({type:"source",url,passed:false,error:String(error)});}}

        for(const relative of args.deletedFiles||[]){const file=safePath(root,relative);checks.push({type:"deleted_file",path:relative,passed:!fs.existsSync(file)});}
        for(const relative of context.requiredDeletedFiles||[]){if(!checks.some(c=>c.type==="deleted_file"&&c.path===relative))checks.push({type:"coverage",path:relative,passed:false,error:"Deleted file is missing from deletedFiles"});}
        for(const changed of context.requiredFiles||[]){
          if(!checks.some(c=>c.type==="file"&&c.path===changed))checks.push({type:"coverage",path:changed,passed:false,error:"Changed file is missing from expectedFiles"});
        }
        if(context.requireTestCommand&&!args.testCommand)checks.push({type:"tests",passed:false,error:"Implementation changes require a real test command"});
        const passed=checks.length>0&&checks.every(c=>c.passed);

        return {ok:passed,status:passed?"executed":"failed",verified:passed,data:{checks},error:checks.length?undefined:"لا يمكن اعتماد تسليم دون فحوص فعلية"};
      }
      case "fetch_url": return {ok:true,status:"executed",data:await readPublicUrl(args.url)};
      case "github_search": {
        const source=await readPublicUrl("https://api.github.com/search/repositories?q="+encodeURIComponent(args.query)+"&per_page=8");
        const parsed=JSON.parse(source.content);return {ok:true,status:"executed",data:{source:source.url,repositories:parsed.items?.map((v:any)=>({name:v.full_name,url:v.html_url,description:v.description,updatedAt:v.updated_at,license:v.license?.spdx_id}))}};
      }
      case "huggingface_search": {
        const source=await readPublicUrl("https://huggingface.co/api/"+(args.type||"models")+"?search="+encodeURIComponent(args.query)+"&limit=8");
        return {ok:true,status:"executed",data:{source:source.url,items:JSON.parse(source.content).map((v:any)=>({id:v.id,author:v.author,downloads:v.downloads,likes:v.likes,private:v.private,updatedAt:v.lastModified,tags:v.tags?.slice(0,15)}))}};
      }
      case "web_search": {
        const {desktopRequest,desktopPage}=await import("./browser-provider/desktop-client.js");
        const tab=await desktopRequest<any>("tabs/create",{provider:"research",url:"https://www.google.com/search?q="+encodeURIComponent(args.query)});
        const page=await desktopPage(tab.targetId);
        const results=await page.locator("a:has(h3)").evaluateAll(links=>links.map(a=>({title:a.textContent,url:(a as HTMLAnchorElement).href})).filter(v=>v.url.startsWith("https:")).slice(0,10));
        if(!results.length)throw new Error("لم تظهر نتائج البحث؛ افتح تبويب البحث لفحص تسجيل الدخول أو التحقق البشري");
        return {ok:true,status:"executed",data:{results}};
      }
      case "save_project_note": {
        const directory=safePath(root,".freellm/notes");fs.mkdirSync(directory,{recursive:true});
        const file=path.join(directory,crypto.randomUUID()+".md");
        fs.writeFileSync(file,"# "+args.title+"\n\n"+args.content+"\n");
        return {ok:true,status:"executed",data:{path:path.relative(root,file)}};
      }
      case "plan_project": {
        const { loadProjectContract, createProjectContract, reviseProjectContract } = await import("./project-contract.js");
        if (!company) throw new Error("شركة غير محددة لتخطيط العقد");
        const scope = { companyId: company, projectId: context.projectId };
        const actor = {
          agentId: context.agent?.id || "freellm-manager",
          role: context.agent?.role || "ceo",
          canManage: true,
        };
        const { expectedRevision, ...input } = args;
        const current = loadProjectContract(root, scope);
        let contract;
        if (!current) {
          contract = await createProjectContract(root, scope, actor, input as any);
        } else {
          contract = await reviseProjectContract(root, scope, actor, {
            expectedRevision: expectedRevision ?? current.revision,
            input: input as any,
          });
        }
        return { ok: true, status: "executed", data: { contract } };
      }
      case "run_project_acceptance": {
        const { runProjectAcceptance } = await import("./project-contract.js");
        if (!company) throw new Error("شركة غير محددة");
        const scope = { companyId: company, projectId: context.projectId };
        const actor = {
          agentId: context.agent?.id || "freellm-manager",
          role: context.agent?.role || "engineer",
          canManage: ["ceo", "cto", "lead"].includes(context.agent?.role || ""),
        };
        const result = await runProjectAcceptance(
          root,
          scope,
          actor,
          async (cmd) => runWorkspaceCommand(cmd, root, context.signal),
          { expectedRevision: args.expectedRevision, moduleId: args.moduleId }
        );
        return {
          ok: result.evidence.passed,
          status: result.evidence.passed ? "executed" : "failed",
          data: result,
          error: result.evidence.passed ? undefined : "فحوص قبول المشروع لم تنجح بالكامل",
        };
      }
      case "review_project_delivery": {
        const { reviewProjectDelivery } = await import("./project-contract.js");
        if (!company) throw new Error("شركة غير محددة");
        const scope = { companyId: company, projectId: context.projectId };
        const actor = {
          agentId: context.agent?.id || "freellm-reviewer",
          role: context.agent?.role || "reviewer",
          canManage: ["ceo", "cto"].includes(context.agent?.role || ""),
        };
        const contract = await reviewProjectDelivery(root, scope, actor, {
          expectedRevision: args.expectedRevision,
          moduleId: args.moduleId,
          approved: args.approved,
          summary: args.summary,
        });
        return { ok: true, status: "executed", data: { contract } };
      }
      case "prepare_task_workspace": {
        const { prepareTaskWorkspace } = await import("./task-workspace.js");
        if (!company || !context.projectId) throw new Error("شركة ومشروع مرتبطان مطلوبان لعزل مساحة العمل");
        const workspace = await prepareTaskWorkspace({
          companyId: company,
          projectId: context.projectId,
          taskId: args.taskId,
          agentId: context.agent?.id || "freellm-specialist",
          projectRoot: root,
        });
        return { ok: true, status: "executed", data: { workspace } };
      }
      case "inspect_task_delivery": {
        const { inspectTaskDelivery } = await import("./task-workspace.js");
        if (!company || !context.projectId) throw new Error("شركة ومشروع مرتبطان مطلوبان لعزل مساحة العمل");
        const inspection = inspectTaskDelivery({
          companyId: company,
          projectId: context.projectId,
          taskId: args.taskId,
          projectRoot: root,
        });
        return { ok: true, status: "executed", data: { inspection } };
      }
      case "integrate_task_delivery": {
        const { stageTaskIntegration } = await import("./task-workspace.js");
        if (!company || !context.projectId) throw new Error("شركة ومشروع مرتبطان مطلوبان لدمج مساحة العمل");
        const staged = stageTaskIntegration({
          companyId: company,
          projectId: context.projectId,
          taskId: args.taskId,
          projectRoot: root,
          expectedDeliverySha256: args.expectedDeliverySha256,
          allowedPaths: args.allowedPaths || ["."],
        });
        const applied: any[] = [];
        if (context.autonomousWrites !== false) {
          for (const mutation of staged.mutations) {
            const res = applyFileMutation(root, mutation);
            applied.push(res);
          }
          return { ok: true, status: "executed", data: { deliverySha256: staged.deliverySha256, applied } };
        }
        return { ok: true, status: "pending_approval", data: { deliverySha256: staged.deliverySha256, mutations: staged.mutations } };
      }
      case "search_native_tools": {
        const { searchNativeTools } = await import("./native-capabilities.js");
        const database = requireDatabase(db);
        if (!company || !context.agent?.id) throw new Error("شركة ووكيل مطلوبان للوصول إلى أدوات النظام الأصلية");
        const binding = {
          db: database,
          companyId: company,
          agentId: context.agent.id,
          runId: context.runId || context.agent?.currentRunId,
          issueId: context.issueId,
          projectId: context.projectId,
          signal: context.signal,
        };
        return searchNativeTools(binding, args);
      }
      case "call_native_tool": {
        const { callNativeTool } = await import("./native-capabilities.js");
        const database = requireDatabase(db);
        if (!company || !context.agent?.id) throw new Error("شركة ووكيل مطلوبان للوصول إلى أدوات النظام الأصلية");
        const binding = {
          db: database,
          companyId: company,
          agentId: context.agent.id,
          runId: context.runId || context.agent?.currentRunId,
          issueId: context.issueId,
          projectId: context.projectId,
          signal: context.signal,
        };
        return callNativeTool(binding, args);
      }
      case "list_native_skills": {
        const { listNativeSkills } = await import("./native-capabilities.js");
        const database = requireDatabase(db);
        if (!company || !context.agent?.id) throw new Error("شركة ووكيل مطلوبان للوصول إلى مهارات النظام الأصلية");
        const binding = {
          db: database,
          companyId: company,
          agentId: context.agent.id,
          runId: context.runId || context.agent?.currentRunId,
          issueId: context.issueId,
          projectId: context.projectId,
          signal: context.signal,
        };
        return listNativeSkills(binding, args);
      }
      case "read_native_skill": {
        const { readNativeSkill } = await import("./native-capabilities.js");
        const database = requireDatabase(db);
        if (!company || !context.agent?.id) throw new Error("شركة ووكيل مطلوبان للوصول إلى مهارات النظام الأصلية");
        const binding = {
          db: database,
          companyId: company,
          agentId: context.agent.id,
          runId: context.runId || context.agent?.currentRunId,
          issueId: context.issueId,
          projectId: context.projectId,
          signal: context.signal,
        };
        return readNativeSkill(binding, args);
      }
      default: throw new Error("أداة غير متاحة");
    }
  } catch(error) { return {ok:false,status:"failed",error:(error as Error).message}; }
}
export async function executeTool(call:ParsedToolCall,root:string,context:ToolContext={},db?:Db,companyId?:string):Promise<string>{
  return JSON.stringify(await executeToolOutcome(call,root,context,db,companyId),null,2);
}
