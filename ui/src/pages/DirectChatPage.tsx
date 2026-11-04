import { useEffect, useRef, useState } from "react";
import { Bot, FolderOpen, Send, Square, Plus, RefreshCw, Globe, FileText, ListTodo, Monitor } from "lucide-react";
import type { FreeLLMTurnEvent, ProjectWorkspace, WorkspaceFileContent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MarkdownBody } from "@/components/MarkdownBody";
import { WorkspaceFileBrowser } from "@/components/WorkspaceFileBrowser";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { WorkspaceRuntimeControls, buildWorkspaceRuntimeControlSections, type WorkspaceRuntimeControlRequest } from "@/components/WorkspaceRuntimeControls";
import { useCompany } from "@/context/CompanyContext";
import { projectsApi } from "@/api/projects";
import { fileResourcesApi } from "@/api/file-resources";
import { freeLLMRequest, readFreeLLMStream } from "@/lib/freellm";
import { Link } from "@/lib/router";
type Agent={id:string;name:string;role:string;title?:string;adapterConfig?:{model?:string}};
type Message={id:string;sender:string;text:string;timestamp?:string};
type Step={id:string;tool:string;result?:string};
type Binding={projectId:string;workspaceId:string;cwd:string;issueId?:string};
const providers=[["gemini-default","جيمناي — الوضع الحالي"],["deepseek-chat","ديب سيك — العادي"],["deepseek-reasoner","ديب سيك — التفكير"],["chatgpt-default","شات جي بي تي"],["claude-default","كلود"],["qwen-default","كوين"],["grok-default","غروك"],["glm-default","جي إل إم"],["arena-default","أرينا"]];
const statuses:Record<string,string>={running:"يعمل الآن",completed:"اكتمل",blocked:"يحتاج معالجة",failed:"تعذر التنفيذ",waiting_children:"ينتظر الفريق",waiting_review:"ينتظر المراجعة",cancelled:"أُلغي",limit_reached:"بلغ حد الخطوات"};
export function DirectChatPage(){
  const {selectedCompanyId}=useCompany();
  const [agents,setAgents]=useState<Agent[]>([]),[agentId,setAgentId]=useState("");
  const [messages,setMessages]=useState<Message[]>([]),[prompt,setPrompt]=useState(""),[error,setError]=useState("");
  const [cwd,setCwd]=useState(""),[binding,setBinding]=useState<Binding|null>(null),[issueId,setIssueId]=useState("");
  const [busy,setBusy]=useState(false),[runId,setRunId]=useState(""),[status,setStatus]=useState(""),[steps,setSteps]=useState<Step[]>([]);
  const [tab,setTab]=useState<"files"|"preview"|"tasks"|"team">("files"),[file,setFile]=useState<WorkspaceFileContent|null>(null),[filePath,setFilePath]=useState("");
  const [workspace,setWorkspace]=useState<ProjectWorkspace|null>(null),[tasks,setTasks]=useState<any[]>([]);
  const [previewUrl,setPreviewUrl]=useState(""),[newAgent,setNewAgent]=useState(false),[name,setName]=useState(""),[role,setRole]=useState("engineer"),[model,setModel]=useState("gemini-default"),[instructions,setInstructions]=useState("");
  const [intent,setIntent]=useState("auto"),[command,setCommand]=useState(""),[port,setPort]=useState("5173");
  const streamRef=useRef<AbortController|null>(null),selectedRef=useRef(agentId),tail=useRef<HTMLDivElement>(null);
  selectedRef.current=agentId;
  async function loadAgents(){
    if(!selectedCompanyId)return;
    const response=await fetch("/api/companies/"+selectedCompanyId+"/agents");if(!response.ok)throw new Error("تعذر قراءة الفريق");
    const rows:Agent[]=await response.json();setAgents(rows);setAgentId(previous=>rows.some(a=>a.id===previous)?previous:rows.find(a=>a.role==="ceo")?.id||rows[0]?.id||"");
  }
  async function refreshWorkspace(){
    if(!binding||!selectedCompanyId)return;
    const rows=await projectsApi.listWorkspaces(binding.projectId,selectedCompanyId);const current=rows.find(w=>w.id===binding.workspaceId)||null;setWorkspace(current);
    const service=current?.runtimeServices?.find(s=>s.status==="running"&&s.url);
    if(service?.url)setPreviewUrl(previous=>previous||service.url!);
  }
  async function refreshTasks(){if(!selectedCompanyId)return;const response=await fetch("/api/companies/"+selectedCompanyId+"/issues");if(response.ok)setTasks((await response.json()).filter((task:any)=>!binding||task.projectId===binding.projectId));}
  useEffect(()=>{let saved:Binding|null=null;try{saved=JSON.parse(localStorage.getItem("freellm-project:"+selectedCompanyId)||"null");}catch{}setBinding(saved);setCwd(saved?.cwd||"");setWorkspace(null);setMessages([]);setIssueId("");void loadAgents().catch(reason=>setError(reason.message));},[selectedCompanyId]);
  useEffect(()=>{
    streamRef.current?.abort();setBusy(false);setSteps([]);setStatus("");setFile(null);
    if(!agentId)return;
    let disposed=false;
    freeLLMRequest<any>("/agent-chat/history?agentId="+agentId).then(history=>{
      if(disposed)return;setMessages(history.messages);setIssueId(history.issueId||"");
      if(history.activeRuns?.[0])void resumeStream(history.activeRuns[0],agentId);
    }).catch(reason=>setError(reason.message));
    return()=>{disposed=true;streamRef.current?.abort();};
  },[agentId]);
  useEffect(()=>{void refreshWorkspace().catch(reason=>setError(reason.message));void refreshTasks();const timer=setInterval(()=>{void refreshWorkspace().catch(()=>{});void refreshTasks();},8000);return()=>clearInterval(timer);},[binding,selectedCompanyId]);
  useEffect(()=>{tail.current?.scrollIntoView({block:"nearest"});},[messages,steps]);
  function handleEvents(targetAgent:string,assistantId:string){
    let text="";
    return(event:FreeLLMTurnEvent)=>{
      if(selectedRef.current!==targetAgent)return;
      if(event.issueId)setIssueId(event.issueId);
      if(event.runId)setRunId(event.runId);
      if(event.type==="token"){text+=event.text||"";setMessages(previous=>previous.map(message=>message.id===assistantId?{...message,text:text.split("```tool_call")[0]}:message));}
      if(event.type==="replace"){text=event.text||"";setMessages(previous=>previous.map(message=>message.id===assistantId?{...message,text:text.split("```tool_call")[0]}:message));}
      if(event.type==="tool_call"){setSteps(previous=>[...previous,{id:event.callId!,tool:event.tool!}]);}
      if(event.type==="tool_result"){setSteps(previous=>previous.map(step=>step.id===event.callId?{...step,result:event.result}:step));text="";void loadAgents();void refreshTasks();}
      if(event.type==="status"){setStatus(event.status||"");if(event.status==="blocked"&&event.message)setError("مطلوب تدخل داخل المتصفح: "+event.message);else if(event.status==="running")setError("");}
      if(event.type==="error")setError(event.message||"تعذر التنفيذ");
    };
  }
  async function resumeStream(id:string,targetAgent:string){
    setRunId(id);setBusy(true);setStatus("running");
    const assistantId="resume-"+id;setMessages(previous=>[...previous,{id:assistantId,sender:"agent",text:""}]);
    const controller=new AbortController();streamRef.current=controller;
    try{await readFreeLLMStream(await fetch("/api/browser/runs/"+id+"/events",{signal:controller.signal}),handleEvents(targetAgent,assistantId));}
    catch(reason){if((reason as Error).name!=="AbortError")setError((reason as Error).message);}
    finally{if(selectedRef.current===targetAgent)setBusy(false);}
  }
  async function connectFolder(){
    setError("");
    try{
      const selected=window.freellmDesktop?await window.freellmDesktop.selectFolder():cwd;
      const target=selected||cwd||"C:\\Users\\malek\\Documents\\FreeLLM Projects";
      setCwd(target);
      const result=await freeLLMRequest<Binding>("/workspace/connect",{companyId:selectedCompanyId,cwd:target,agentId:agentId||undefined});
      setBinding(result);localStorage.setItem("freellm-project:"+selectedCompanyId,JSON.stringify(result));if(result.issueId)setIssueId(result.issueId);
    }catch(reason){setError((reason as Error).message);}
  }
  async function send(){
    if(!prompt.trim()||!agentId||busy)return;
    setError("");setSteps([]);
    try{
      let current=binding;
      if(!current){
        const target=cwd.trim()||"C:\\Users\\malek\\Documents\\FreeLLM Projects";
        current=await freeLLMRequest<Binding>("/workspace/connect",{companyId:selectedCompanyId,cwd:target,agentId});
        setBinding(current);setCwd(target);
      }
      const requestId=crypto.randomUUID(),assistantId="reply-"+requestId,text=prompt.trim(),target=agentId;
      setMessages(previous=>[...previous,{id:"user-"+requestId,sender:"user",text},{id:assistantId,sender:"agent",text:""}]);
      setPrompt("");setRunId(requestId);setBusy(true);setStatus("running");
      const controller=new AbortController();streamRef.current=controller;
      await readFreeLLMStream(await fetch("/api/browser/agent-chat",{method:"POST",headers:{"content-type":"application/json"},signal:controller.signal,
        body:JSON.stringify({agentId:target,prompt:text,workspaceRoot:current.cwd,projectId:current.projectId,requestId,intent})}),handleEvents(target,assistantId));
      void refreshWorkspace();void refreshTasks();
    }catch(reason){if((reason as Error).name!=="AbortError")setError((reason as Error).message);}
    finally{if(streamRef.current?.signal.aborted!==true)setBusy(false);}
  }
  async function stop(){try{await freeLLMRequest("/runs/"+runId+"/cancel",{});}catch(reason){setError((reason as Error).message);}}

  async function changeModel(next:string){
    try{await freeLLMRequest("/agents/"+agentId+"/model",{model:next});await loadAgents();}catch(reason){setError((reason as Error).message);}
  }
  async function createAgent(){
    try{
      await freeLLMRequest("/create-agent",{companyId:selectedCompanyId,name,role,model,systemPrompt:instructions.trim()||undefined});
      setNewAgent(false);setName("");setInstructions("");await loadAgents();
    }catch(reason){setError((reason as Error).message);}
  }
  async function openFile(reference:any){
    if(!issueId)return;
    try{setFilePath(reference.path);setFile(await fileResourcesApi.content(issueId,reference));}catch(reason){setError((reason as Error).message);}
  }
  async function runtimeAction(request:WorkspaceRuntimeControlRequest){
    if(!binding||!selectedCompanyId)return;
    try{await projectsApi.controlWorkspaceCommands(binding.projectId,binding.workspaceId,request.action,selectedCompanyId,request);await refreshWorkspace();}
    catch(reason){setError((reason as Error).message);}
  }
  async function configurePreview(){
    if(!binding||!selectedCompanyId||!command.trim())return;
    try{

      const current=workspace?.runtimeConfig;
      const previous=Array.isArray((current?.workspaceRuntime as any)?.services)?(current?.workspaceRuntime as any).services:[];
      const services=previous.filter((v:any)=>v.id!=="freellm-preview"&&!["FreeLLM Preview","معاينة المشروع"].includes(v.name));
      services.push({id:"freellm-preview",name:"FreeLLM Preview",command,port:Number(port),readiness:{type:"http",urlTemplate:"http://127.0.0.1:{{port}}",timeoutSec:30,intervalMs:250},expose:{type:"url",urlTemplate:"http://127.0.0.1:{{port}}"},lifecycle:"shared"});
      await projectsApi.updateWorkspace(binding.projectId,binding.workspaceId,{runtimeConfig:{...current,workspaceRuntime:{...(current?.workspaceRuntime as any),services}}},selectedCompanyId);

      await refreshWorkspace();
    }catch(reason){setError((reason as Error).message);}
  }
  const sections=buildWorkspaceRuntimeControlSections({runtimeConfig:workspace?.runtimeConfig?.workspaceRuntime,runtimeServices:workspace?.runtimeServices,canStartServices:true});
  const isLocalPreview=(()=>{try{const url=new URL(previewUrl);return ["http:","https:"].includes(url.protocol)&&["127.0.0.1","localhost"].includes(url.hostname)&&url.port!==window.location.port;}catch{return false;}})();
  return <div className="freellm-workbench flex min-h-0 flex-col gap-3 p-4" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">مساحة الفريق</h1><p className="text-sm text-muted-foreground">اشرح الهدف؛ يعرض المدير خطة مختصرة ثم يبدأ العمل.</p></div>
      <div className="flex items-center gap-2"><Badge variant="outline">{statuses[status]||"جاهز لاستقبال مهمة"}</Badge><Link to="/browser"><Button variant="outline" size="sm"><Globe className="size-4"/>المتصفح</Button></Link></div>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="الوكيل" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={agentId} disabled={busy} onChange={event=>setAgentId(event.target.value)}>
        {agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
      </select>
      <Button variant="outline" size="sm" onClick={()=>setNewAgent(!newAgent)}><Plus className="size-4"/>مختص جديد</Button>
      <Input aria-label="مجلد المشروع" className="min-w-0 flex-1 font-mono" dir="ltr" placeholder="اختر مجلد المشروع" value={cwd} disabled={busy} onChange={event=>{setCwd(event.target.value);setBinding(null);}}/>
      <Button variant="outline" onClick={()=>void connectFolder()} disabled={busy||!selectedCompanyId}><FolderOpen className="size-4"/>ربط المشروع</Button>

      {agentId&&<select aria-label="منصة الوكيل" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={agents.find(agent=>agent.id===agentId)?.adapterConfig?.model||"gemini-default"} disabled={busy} onChange={event=>void changeModel(event.target.value)}>
        {!providers.some(([id])=>id===agents.find(agent=>agent.id===agentId)?.adapterConfig?.model)&&<option value={agents.find(agent=>agent.id===agentId)?.adapterConfig?.model}>اختر وضعًا متاحًا للحساب</option>}
        {providers.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select>}
    </div>
    {newAgent&&<div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-2">
      <Input aria-label="اسم المختص" placeholder="اسم المختص" value={name} onChange={event=>setName(event.target.value)}/>
      <select aria-label="دور المختص" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={role} onChange={event=>setRole(event.target.value)}>{[["ceo","مدير"],["cto","مدير تقني"],["engineer","مطور"],["qa","مختبر ومراجع"],["researcher","باحث"],["designer","مصمم"],["cmo","تسويق"],["general","مختص"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="نموذج المختص" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={model} onChange={event=>setModel(event.target.value)}>{providers.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      <Input aria-label="تعليمات المختص" placeholder="تعليمات إضافية اختيارية؛ يُجهز الدور تلقائيًا" value={instructions} onChange={event=>setInstructions(event.target.value)}/>
      <div className="flex justify-between md:col-span-2"><Button variant="ghost" onClick={()=>setNewAgent(false)}>إلغاء</Button><Button onClick={()=>void createAgent()} disabled={!name||(instructions.length>0&&instructions.length<20)}>إنشاء المختص</Button></div>
    </div>}
    {error&&<div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</div>}
    <div className="freellm-workbench-columns grid min-h-0 flex-1 gap-3">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border">
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {messages.length===0&&<div className="space-y-3 py-6 text-muted-foreground"><Bot className="size-8"/><p>اختر مشروعًا، ثم اشرح ما تريد إنجازه. الملفات والمهام والنتائج تبقى مرتبطة بمشروعك.</p></div>}
          {messages.map(message=><div key={message.id} className="space-y-2"><div className="text-xs font-medium text-muted-foreground">{message.sender==="user"?"أنت":"الفريق"}</div><MarkdownBody>{message.text}</MarkdownBody></div>)}
          {steps.length>0&&<div className="space-y-2 rounded-lg bg-muted/30 p-3">{steps.map(step=><details key={step.id}><summary className="cursor-pointer text-sm">{step.result?(JSON.parse(step.result).ok?"✓":"×"):"…"} {({read_file:"قراءة ملف",get_project_context:"فهم المشروع",propose_file_mutation:"تعديل ملف",verify_task:"التحقق من التسليم",create_agent:"إنشاء مختص",delegate_task:"تفويض مهمة",create_task:"إنشاء مهمة",run_command:"تشغيل أمر",web_search:"البحث",start_preview:"تشغيل المعاينة",list_agents:"قراءة الفريق"} as Record<string,string>)[step.tool]||step.tool}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs" dir="ltr">{step.result||"قيد التنفيذ"}</pre></details>)}</div>}
          <div ref={tail}/>
        </div>
        <div className="space-y-2 border-t border-border p-3">
          <textarea aria-label="طلبك للفريق" className="freellm-composer w-full resize-none rounded-md border border-input bg-background p-3 text-sm" value={prompt} disabled={busy} placeholder="ماذا تريد من الفريق أن ينجز؟" onChange={event=>setPrompt(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void send();}}}/>
          <div className="flex items-center justify-between gap-2">
            <select aria-label="نوع الطلب" className="rounded-md border border-input bg-background px-2 py-1 text-xs" value={intent} onChange={event=>setIntent(event.target.value)}><option value="auto">تلقائي</option><option value="work">تنفيذ مشروع</option><option value="research">بحث</option><option value="answer">نقاش</option></select>
            {busy?<Button variant="outline" onClick={()=>void stop()}><Square className="size-4"/>إيقاف التشغيل</Button>:<Button onClick={()=>void send()} disabled={!agentId||!prompt.trim()}><Send className="size-4"/>إرسال</Button>}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex flex-wrap gap-1 border-b border-border p-2">
          {([["files","الملفات",FileText],["preview","المعاينة",Monitor],["tasks","المهام",ListTodo],["team","الفريق",Bot]] as const).map(([value,label,Icon])=><Button key={value} variant={tab===value?"secondary":"ghost"} size="sm" onClick={()=>setTab(value)}><Icon className="size-4"/>{label}</Button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {tab==="files"&&(!binding||!issueId?<p className="text-sm text-muted-foreground">اربط مشروعًا لعرض ملفاته.</p>:<div className="space-y-3">
            <WorkspaceFileBrowser key={binding.workspaceId} issueId={issueId} companyId={selectedCompanyId} initialProjectId={binding.projectId} initialWorkspaceId={binding.workspaceId} onOpen={reference=>void openFile(reference)} selectedPath={filePath} compact autoFocusSearch={false}/>
            {file&&<div className="space-y-2 border-t border-border pt-3"><div className="flex items-center justify-between"><span className="font-mono text-xs" dir="ltr">{filePath}</span><a className="text-xs text-primary underline" href={fileResourcesApi.downloadUrl(issueId,{path:filePath,projectId:binding.projectId,workspaceId:binding.workspaceId})}>تنزيل</a></div>
              {file.content.encoding==="utf8"?(filePath.endsWith(".html")?<div className="freellm-file-preview"><HtmlArtifactPreview html={file.content.data} title={filePath}/></div>:<pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs" dir="ltr">{file.content.data}</pre>):<p className="text-sm text-muted-foreground">ملف غير نصي؛ استخدم التنزيل أو عارض الملفات الأصلي.</p>}</div>}
          </div>)}
          {tab==="preview"&&<div className="space-y-3">
            {!binding?<p className="text-sm text-muted-foreground">اربط المشروع أولًا.</p>:<>
              <WorkspaceRuntimeControls sections={sections} onAction={request=>void runtimeAction(request)} serviceEmptyMessage="أضف أمر تشغيل المشروع أدناه." jobEmptyMessage="لا توجد اختبارات أو مهام تشغيل محفوظة."/>
              <details><summary className="cursor-pointer text-sm">إعداد أمر المعاينة</summary><div className="space-y-2 pt-2"><Input aria-label="أمر المعاينة" dir="ltr" placeholder="npm run dev -- --host 127.0.0.1 --port 5173" value={command} onChange={event=>setCommand(event.target.value)}/><Input aria-label="منفذ المعاينة" dir="ltr" value={port} onChange={event=>setPort(event.target.value)}/><Button variant="outline" onClick={()=>void configurePreview()}>حفظ أمر التشغيل</Button></div></details>
              <Input aria-label="رابط المعاينة" dir="ltr" placeholder="http://127.0.0.1:5173" value={previewUrl} onChange={event=>setPreviewUrl(event.target.value)}/>
              {isLocalPreview&&<iframe className="freellm-file-preview w-full rounded-md border border-border" title="معاينة المشروع" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer"/>}
            </>}
          </div>}
          {tab==="tasks"&&<div className="space-y-2"><Button variant="ghost" size="sm" onClick={()=>void refreshTasks()}><RefreshCw className="size-4"/>تحديث المهام</Button>{tasks.map(task=><Link key={task.id} to={"/issues/"+task.id} className="block rounded-md border border-border p-3"><div className="text-sm">{task.title}</div><div className="text-xs text-muted-foreground">{task.status}</div></Link>)}{tasks.length===0&&<p className="text-sm text-muted-foreground">ستظهر هنا المهام التي يوزعها المدير على الفريق.</p>}</div>}
          {tab==="team"&&<div className="space-y-2">{agents.map(agent=><button key={agent.id} className="block w-full rounded-md border border-border p-3 text-start hover:bg-muted" onClick={()=>setAgentId(agent.id)}><div className="text-sm font-medium">{agent.name}</div><div className="text-xs text-muted-foreground">{agent.role} · {agent.adapterConfig?.model}</div></button>)}</div>}
        </div>
      </div>
    </div>
  </div>;
}
