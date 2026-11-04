import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Globe, RefreshCw, Plus, EyeOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/context/CompanyContext";
import { freeLLMRequest } from "@/lib/freellm";

type Tab={id:string;provider:string;title:string;label?:string;url:string;visible:boolean;purpose?:string;busy?:boolean};
type Provider={id:string;state:string;message?:string;qualified:boolean};
type Status={connected:boolean;tabs:Tab[];providers:Provider[]};
type Session={key:string;agentId:string;provider:string;url:string;tabId?:string;status:string};
type Agent={id:string;name:string};
const names:Record<string,string>={gemini:"جيمناي",deepseek:"ديب سيك",chatgpt:"شات جي بي تي",claude:"كلود",qwen:"كوين",grok:"غروك",glm:"جي إل إم",arena:"أرينا",research:"البحث"};

export function BrowserManagerPage(){
  const [status,setStatus]=useState<Status>({connected:false,tabs:[],providers:[]});
  const [active,setActive]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[provider,setProvider]=useState("gemini");
  const [sessions,setSessions]=useState<Session[]>([]),[agents,setAgents]=useState<Agent[]>([]),[notice,setNotice]=useState("");
  const surface=useRef<HTMLDivElement>(null),activeRef=useRef(active);
  activeRef.current=active;
  const desktop=window.freellmDesktop;
  const {selectedCompanyId}=useCompany();

  async function refresh(){
    try{
      const next=await freeLLMRequest<Status>("/status");
      setStatus(next);
      setActive(previous=>next.tabs.some(tab=>tab.id===previous)?previous:next.tabs.find(tab=>tab.visible)?.id||"");
      if(selectedCompanyId){
        const [saved,response]=await Promise.all([
          freeLLMRequest<Session[]>("/sessions?companyId="+selectedCompanyId),
          fetch("/api/companies/"+selectedCompanyId+"/agents"),
        ]);
        if(!response.ok)throw new Error("تعذر قراءة أسماء الفريق");
        setSessions(saved);setAgents(await response.json());
      }
    }catch(reason){setError((reason as Error).message);}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),8000);return()=>clearInterval(timer);},[selectedCompanyId]);

  function updateBounds(){
    if(!desktop||!surface.current)return;
    const rect=surface.current.getBoundingClientRect();
    void desktop.setBrowserBounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height,visible:Boolean(activeRef.current)}).catch(reason=>setError((reason as Error).message));
  }
  useEffect(()=>{
    if(!desktop||!surface.current)return;
    const observer=new ResizeObserver(updateBounds);observer.observe(surface.current);
    if(surface.current.parentElement)observer.observe(surface.current.parentElement);
    window.addEventListener("resize",updateBounds);window.addEventListener("scroll",updateBounds,true);updateBounds();
    return()=>{observer.disconnect();window.removeEventListener("resize",updateBounds);window.removeEventListener("scroll",updateBounds,true);void desktop.hideBrowser();};
  },[desktop]);
  useLayoutEffect(()=>{const frame=requestAnimationFrame(updateBounds);return()=>cancelAnimationFrame(frame);});
  useEffect(()=>desktop?.onTabSelected(tab=>setActive(tab.id)),[desktop]);
  useEffect(()=>{
    if(!desktop)return;
    if(active)void freeLLMRequest("/tabs/"+active+"/show",{}).catch(reason=>setError((reason as Error).message));
    else void desktop.hideBrowser();
  },[active,desktop]);

  async function action(run:()=>Promise<void>){
    setBusy(true);setError("");
    try{await run();await refresh();}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}
  }
  async function open(){await action(async()=>{const tab=await freeLLMRequest<Tab>("/providers/"+provider+"/open",{});setActive(tab.id);});}
  const agentName=(id:string)=>agents.find(agent=>agent.id===id)?.name||"وكيل";
  const sessionFor=(tab:Tab)=>sessions.find(session=>session.tabId===tab.id)||
    (tab.purpose==="conversation"?sessions.find(session=>session.provider===tab.provider&&session.url===tab.url):undefined);
  const saved=sessions.filter(session=>session.url&&!status.tabs.some(tab=>tab.id===session.tabId||(tab.purpose==="conversation"&&tab.provider===session.provider&&tab.url===session.url)));
  return <div className="freellm-browser-layout flex flex-col gap-3 p-4" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Globe className="size-5"/>متصفح الفريق</h1>
      <p className="text-sm text-muted-foreground">افتح تبويب أي وكيل لمشاهدة محادثته. إخفاء المتصفح يبقي العمل في الخلفية.</p></div>
      <Badge variant="outline">{status.connected?"متصل بالتطبيق":"افتح تطبيق سطح المكتب"}</Badge>
    </div>

    <div className="flex min-h-0 shrink-0 items-center gap-2 overflow-x-auto rounded-lg border border-border p-2" role="tablist" aria-label="تبويبات المتصفح">
      {status.tabs.map(tab=>{
        const session=sessionFor(tab),title=tab.label||(session?agentName(session.agentId):tab.purpose==="conversation"?"محادثة وكيل":"حساب شخصي");
        return <div key={tab.id} className="flex shrink-0 items-center rounded-md border border-border">
          <Button role="tab" aria-selected={active===tab.id} variant={active===tab.id?"secondary":"ghost"} size="sm" disabled={busy}
            title={tab.label||tab.title} onClick={()=>setActive(tab.id)}>
            <span className="flex items-center gap-1.5 max-w-xs truncate">
              {tab.busy && <span className="inline-block size-2 rounded-full bg-amber-500 animate-pulse" title="قيد التنفيذ" />}
              <span>{title} · {names[tab.provider]||tab.provider}</span>
              {tab.busy ? <Badge variant="secondary" className="text-[10px] px-1 py-0">نشط</Badge> : null}
            </span>
          </Button>
          <Button variant="ghost" size="icon" aria-label={"إغلاق تبويب "+title} disabled={busy} onClick={()=>void action(async()=>{await freeLLMRequest("/tabs/"+tab.id+"/close",{});if(active===tab.id)setActive("");})}><X className="size-3"/></Button>
        </div>;
      })}
      {saved.map(session=><Button key={session.key} role="tab" aria-selected={false} variant="outline" size="sm" disabled={busy||!status.connected} className="shrink-0"
        onClick={()=>void action(async()=>{const tab=await freeLLMRequest<{id:string}>("/sessions/open",{companyId:selectedCompanyId,key:session.key});setActive(tab.id);})}>
        <span className="max-w-xs truncate">{agentName(session.agentId)} · {names[session.provider]||session.provider} · محفوظة</span>
      </Button>)}
      {!status.tabs.length&&!saved.length&&<span className="text-sm text-muted-foreground">لا توجد تبويبات بعد. افتح منصة للبدء.</span>}
    </div>

    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="المنصة" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={provider} onChange={event=>setProvider(event.target.value)}>
        {Object.entries(names).filter(([id])=>id!=="research").map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select>
      <Button onClick={()=>void open()} disabled={busy||!status.connected}><Plus className="size-4"/>فتح المنصة</Button>
      <Button variant="outline" disabled={busy||!status.connected} onClick={()=>void action(async()=>{setNotice("جارٍ اختبار إرسال وقراءة رد حقيقي…");const result=await freeLLMRequest<{passed:boolean;error?:string;capabilities?:{exactInstruction?:boolean}}>("/providers/"+provider+"/probe",{});setNotice(result.passed?(result.capabilities?.exactInstruction===false?"الاتصال يعمل، لكن النموذج لم يلتزم بصيغة الاختبار.":"نجح اختبار المحادثة الفعلي."):"لم ينجح الاختبار: "+result.error);})}>اختبار الاتصال</Button>
      <Button variant="outline" onClick={()=>void refresh()} disabled={busy}><RefreshCw className="size-4"/>تحديث</Button>
      <Button variant="ghost" onClick={()=>setActive("")}><EyeOff className="size-4"/>إخفاء العرض</Button>
    </div>
    {notice&&<p className="text-sm text-muted-foreground">{notice}</p>}
    {sessions.filter(session=>session.status==="unknown").map(session=><div key={session.key} className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"><span>نتيجة غير محسومة في {names[session.provider]}. افحص التبويب قبل بدء محادثة جديدة.</span><Button variant="outline" size="sm" onClick={()=>void action(async()=>{await freeLLMRequest("/sessions/reset",{companyId:selectedCompanyId,key:session.key});})}>بدء محادثة جديدة</Button></div>)}
    {error&&<div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</div>}
    <div ref={surface} className="freellm-browser-surface flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-muted/20">
      {!desktop?<div className="p-6 text-center text-muted-foreground">المتصفح المدمج يظهر داخل تطبيق سطح المكتب.</div>:!active?<div className="p-6 text-center text-muted-foreground">اختر تبويبًا من الأعلى لمشاهدة محادثته.</div>:null}
    </div>
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {status.providers.filter(item=>status.tabs.some(tab=>tab.provider===item.id)).map(item=><span key={item.id}>{names[item.id]||item.id}: {item.state==="READY"?"واجهة المحادثة جاهزة":item.message||"تحتاج فحصًا"} · {item.qualified?"اجتازت اختبار المحادثة":"لم تجتز اختبار المحادثة بعد"}</span>)}
    </div>
  </div>;
}
