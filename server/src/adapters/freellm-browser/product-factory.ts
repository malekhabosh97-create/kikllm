import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueCreateIdempotencyKeys, projects, projectWorkspaces } from "@paperclipai/db";
import { z } from "zod";
import { issueService } from "../../services/issues.js";
import { projectService } from "../../services/projects.js";
import { getCatalogTeamOrThrow, listCatalogTeams, teamsCatalogService } from "../../services/teams-catalog.js";
import { logActivity } from "../../services/activity-log.js";
import { globalModelRouter } from "./browser-provider/model-router.js";
import { freeLLMRuntime } from "./runtime-context.js";

export const createProductSchema = z.object({
  companyId: z.string().uuid(), name: z.string().trim().min(2).max(100),
  goal: z.string().trim().min(10).max(20000), requestId: z.string().uuid(),
  agentId: z.string().uuid().optional(), kind: z.enum(["code", "research", "content"]).default("code"),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export function productDirectory(base: string, companyId: string, requestId: string, name: string) {
  z.string().uuid().parse(companyId); z.string().uuid().parse(requestId);
  const slug = name.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0,64) || "product";
  return path.join(path.resolve(base), companyId, slug + "-" + requestId);
}

export function productBrief(input: Pick<CreateProductInput,"name"|"goal"|"kind">) {
  return [
    "أنت مسؤول عن تسليم المنتج: " + input.name,
    "طلب المستخدم الأصلي:\n" + input.goal,
    "Delivery kind: " + input.kind,
    "Give the operator a short plan and begin actual execution. Inspect the workspace and relevant skills first.",
    "Create a persisted plan_project contract with concrete acceptance criteria before implementing a new product or delegating. Keep the original goal intact.",
    "For a small product, complete it directly. For large work, use bounded modules, explicit interfaces, file ownership and dependencies. Delegate only ready modules. Inspect and integrate isolated deliveries before accepting the whole product.",
    "Use search_connected_tools/list_skills only when useful. The browser supplies inference; local tools perform the actual work. Never invent tool or provider success.",
    "For code, deliver a runnable interface and meaningful tests. Run verify_task against the fixed project acceptance criteria. Obtain independent review when the contract requires it. Fix failures before claiming success.",
    "Preserve existing human changes. Return the actual deliverable location, verification evidence and any unresolved limitation in concise Arabic.",
  ].join("\n\n");
}

const creationLocks = new Map<string, Promise<unknown>>();
export function productFactoryService(db: Db, base = path.join(os.homedir(), "Documents", "FreeLLM Projects")) {
  const projectSvc = projectService(db), issueSvc = issueService(db), teams = teamsCatalogService(db);
  return {
    async overview(companyId: string) {
      const [catalog, installed, rows] = await Promise.all([
        listCatalogTeams(), teams.listInstalledCatalogTeams(companyId),
        db.select({ projectId:projects.id, name:projects.name, status:projects.status, workspaceId:projectWorkspaces.id, cwd:projectWorkspaces.cwd })
          .from(projects).innerJoin(projectWorkspaces, eq(projects.id,projectWorkspaces.projectId)).where(eq(projects.companyId,companyId)),
      ]);
      return { templates:catalog.map(t=>({id:t.id,key:t.key,name:t.name,description:t.description,category:t.category,agents:t.counts.agents})), installed, products:rows, baseDirectory:path.join(base,companyId) };
    },
    async installTeam(companyId:string, catalogId:string, model:string, userId:string) {
      globalModelRouter.resolveRoute(model);
      const team=await getCatalogTeamOrThrow(catalogId);
      const installed=await teams.listInstalledCatalogTeams(companyId);
      if(installed.some(entry=>entry.catalogId===team.id))return {alreadyInstalled:true,team};
      return teams.installCatalogTeam(companyId,catalogId,{
        adapterOverrides:Object.fromEntries(team.agentSlugs.map(slug=>[slug,{adapterType:"freellm_browser",adapterConfig:{model,maxToolIterations:32}}])),
        sourcePolicy:{allowExternalSources:false,allowLocalPathSources:false},
        actor:{actorType:"user",actorId:userId,userId},
      });
    },
    async createProduct(raw: CreateProductInput, userId:string) {
      const input=createProductSchema.parse(raw), key=input.companyId+":"+input.requestId;
      const current=creationLocks.get(key); if(current)return current;
      const operation=(async()=>{
        const wake=freeLLMRuntime().wake;
        if(!wake)throw new Error("مجدول تشغيل الفريق غير متصل؛ لم يبدأ إنشاء المنتج");
        const team=await db.select().from(agents).where(eq(agents.companyId,input.companyId));
        const manager=input.agentId?team.find(a=>a.id===input.agentId):team.find(a=>a.role==="ceo"&&a.adapterType==="freellm_browser")||team.find(a=>a.role==="cto"&&a.adapterType==="freellm_browser")||team.find(a=>!a.reportsTo&&a.adapterType==="freellm_browser");
        if(!manager||manager.adapterType!=="freellm_browser")throw new Error("جهّز فريق المتصفح واختر قائدًا لهذا المنتج أولًا");
        if(["paused","terminated","pending_approval"].includes(manager.status))throw new Error("قائد المنتج متوقف أو يحتاج موافقة؛ فعّله من صفحة الفريق");
        const cwd=productDirectory(base,input.companyId,input.requestId,input.name);
        fs.mkdirSync(path.dirname(cwd),{recursive:true});
        // Canonical containment also rejects pre-existing junctions in the company path.
        const canonicalBase=fs.realpathSync(base), parent=fs.realpathSync(path.dirname(cwd));
        const relative=path.relative(canonicalBase,parent);
        if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("مجلد الشركة خارج جذر المنتجات");
        fs.mkdirSync(cwd,{recursive:true});
        if(fs.realpathSync(cwd)!==path.join(parent,path.basename(cwd)))throw new Error("مجلد المنتج رابط خارج مساحة العمل");
        const allWorkspaces=await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.companyId,input.companyId));
        let workspace=allWorkspaces.find(w=>w.cwd===cwd), projectId=workspace?.projectId;
        if(!workspace){
          const project=await projectSvc.create(input.companyId,{name:input.name,description:input.goal,status:"in_progress"}); projectId=project.id;
          workspace=await projectSvc.createWorkspace(project.id,{name:input.name,cwd,isPrimary:true})||undefined;
          if(!workspace)throw new Error("تعذر ربط مجلد المنتج بالمشروع");
        }
        const idempotencyKey="freellm-product:"+input.requestId;
        const [existing]=await db
          .select({
            id: issues.id,
            title: issues.title,
            description: issues.description,
            identifier: issues.identifier,
          })
          .from(issueCreateIdempotencyKeys)
          .innerJoin(issues, eq(issueCreateIdempotencyKeys.issueId, issues.id))
          .where(and(eq(issueCreateIdempotencyKeys.companyId,input.companyId),eq(issueCreateIdempotencyKeys.idempotencyKey,idempotencyKey)));
        if(existing&&(existing.title!==input.name||existing.description!==productBrief(input)))throw new Error("معرّف الطلب مستخدم لمنتج مختلف");
        const task=existing||await issueSvc.create(input.companyId,{title:input.name,description:productBrief(input),projectId:projectId!,projectWorkspaceId:workspace.id,assigneeAgentId:manager.id,actorResponsibleUserId:userId,status:"todo",priority:"medium",idempotencyKey});
        let run:unknown=null;
        if(!existing)run=await wake(manager.id,{source:"assignment",reason:"issue_assigned",requestedByActorType:"user",requestedByActorId:userId,idempotencyKey:"freellm-product-start:"+task.id,payload:{issueId:task.id},contextSnapshot:{issueId:task.id,responsibleUserId:userId,executionWorkspaceCwd:cwd,prompt:task.description,source:"freellm.product_factory"}});
        await logActivity(db,{companyId:input.companyId,actorType:"user",actorId:userId,action:"freellm.product.started",entityType:"issue",entityId:task.id,details:{projectId,workspaceId:workspace.id,requestId:input.requestId,reused:Boolean(existing)}});
        return {projectId,workspaceId:workspace.id,cwd,issueId:task.id,identifier:task.identifier,agentId:manager.id,run,reused:Boolean(existing),queued:Boolean(run)||Boolean(existing)};
      })();
      creationLocks.set(key,operation);
      try{return await operation;}finally{if(creationLocks.get(key)===operation)creationLocks.delete(key);}
    },
  };
}
