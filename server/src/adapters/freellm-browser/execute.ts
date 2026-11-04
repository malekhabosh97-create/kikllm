import { freeLLMRuntime } from "./runtime-context.js";
import { issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { runAgentTurnLoop } from "./unified-engine.js";
export async function execute(context:AdapterExecutionContext):Promise<AdapterExecutionResult>{
  let issue=context.context?.paperclipIssue as any;
  const db=freeLLMRuntime().db;
  if(!issue&&db&&typeof context.context.issueId==="string"){[issue]=await db.select().from(issues).where(and(eq(issues.id,context.context.issueId),eq(issues.companyId,context.agent.companyId)));}
  const prompt=typeof context.context?.prompt==="string"?context.context.prompt:
    [issue?.title,issue?.description,context.context?.wakeReason?"Wake reason: "+context.context.wakeReason:null].filter(Boolean).join("\n\n");
  const workspace=String(((context.context?.paperclipWorkspace as any)?.source!=="agent_home"?(context.context?.paperclipWorkspace as any)?.cwd:undefined)||context.context?.executionWorkspaceCwd||context.config.cwd||(context.context?.paperclipWorkspace as any)?.cwd||"");
  if(!prompt)return {exitCode:1,signal:null,timedOut:false,errorMessage:"لا توجد مهمة أو رسالة فعلية للتنفيذ"};
  await context.onCancellationReady?.();
  context.onDispatch?.();
  const result=await runAgentTurnLoop({
    agentId:context.agent.id,agent:context.agent,config:context.config,companyId:context.agent.companyId,
    issueId:issue?.id||(typeof context.context?.issueId==="string"?context.context.issueId:undefined),
    projectId:issue?.projectId,projectWorkspaceId:issue?.projectWorkspaceId,executionWorkspaceId:typeof context.context.executionWorkspaceId==="string"?context.context.executionWorkspaceId:issue?.executionWorkspaceId,responsibleUserId:issue?.responsibleUserId||(typeof context.context.responsibleUserId==="string"?context.context.responsibleUserId:undefined),
    prompt,workspaceRoot:workspace,runId:context.runId,forceFreshSession:context.context?.forceFreshSession===true,signal:context.signal,
    onEvent:async event=>{
      if(event.type==="tool_call")await context.onLog("stdout","\n[أداة] "+event.tool+"\n");
      else if(event.type==="tool_result"){
        let outcome:any;try{outcome=JSON.parse(event.result||"{}");}catch{outcome={};}
        await context.onLog("stdout","[نتيجة] "+event.tool+": "+(outcome.ok?"تم":outcome.error||outcome.status||"تعذر")+"\n");
      }
      else if(event.type==="error")await context.onLog("stderr",(event.message||"")+"\n");
      else if(event.type==="status")await context.onLog("stdout","\n["+event.status+"]\n");
    }
  });
  if(result.fullResponse)await context.onLog("stdout","\n"+result.fullResponse+"\n");
  const cancelled=result.lastStatus==="cancelled";
  const success=["completed","waiting_children","waiting_review"].includes(result.lastStatus);
  return {exitCode:cancelled?130:success?0:1,signal:cancelled?"SIGINT":null,timedOut:false,
    errorMessage:success?undefined:result.errorMessage||result.lastStatus,
    summary:result.fullResponse.slice(0,500),resultJson:{freellmStatus:result.lastStatus,verified:result.verified,toolCalls:result.toolCallsCount},
    sessionParams:{model:context.config.model,agentId:context.agent.id,issueId:issue?.id},sessionDisplayId:context.agent.name};
}
