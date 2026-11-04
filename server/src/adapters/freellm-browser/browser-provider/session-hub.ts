import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatSession, ReplyResult, SiteAdapter } from "./types.js";
import { globalModelRouter } from "./model-router.js";
import { desktopRequest } from "./desktop-client.js";
export interface BrowserBinding {
  key: string; companyId: string; agentId: string; issueId?: string; provider: string; model: string;
  url: string; tabId?: string; lastRequestId?: string; lastRequestHash?: string; lastReply?: ReplyResult; initializedHash?: string; contextHash?:string; status: string; updatedAt: string;
}
export class BrowserSessionHub {
  private sessions = new Map<string, ChatSession>();
  private locks = new Map<string, Promise<void>>();
  private accountLocks = new Map<string, Promise<void>>();
  private lastProviderRequestTime = new Map<string, number>();
  constructor(private root = path.join(os.homedir(), ".paperclip", "freellm", "sessions"),
    private adapterFor: (provider: string) => SiteAdapter = provider => globalModelRouter.getAdapter(provider),
    private showTab: (id:string) => Promise<unknown> = id => desktopRequest("tabs/show",{id})) {}
  private file(key: string) { return path.join(this.root, crypto.createHash("sha256").update(key).digest("hex") + ".json"); }
  private read(key: string): BrowserBinding | undefined {
    try {
      const record = JSON.parse(fs.readFileSync(this.file(key), "utf8"));
      if (record && ["rate_limit", "provider_error"].includes(record.status)) {
        const ageMs = Date.now() - new Date(record.updatedAt || 0).getTime();
        if (ageMs > 5 * 60 * 1000) {
          record.status = "idle";
          this.save(record);
        }
      }
      return record;
    } catch { return undefined; }
  }
  private save(record: BrowserBinding) {
    fs.mkdirSync(this.root, { recursive: true });
    const target = this.file(record.key), temporary = target + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temporary, target);
  }
  list(companyId: string): BrowserBinding[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter(name => name.endsWith(".json")).flatMap(name => {
      try { const record = JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8")); return record.companyId === companyId ? [record] : []; } catch { return []; }
    });
  }
  private async exclusive<T>(map: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
    const previous = map.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    map.set(key, current); await previous;
    try { return await action(); }
    finally { release(); if (map.get(key) === current) map.delete(key); }
  }
  async turn(params: {
    companyId: string; agentId: string; projectId?: string; issueId?: string; model: string; prompt: string; instructions: string; context?:string;
    requestId?: string; agentName?: string; issueTitle?: string; forceFreshSession?:boolean; signal?: AbortSignal; onSnapshot?: (text: string) => void; onBlocker?:(message:string|null)=>void;
  }): Promise<ReplyResult & { binding: BrowserBinding }> {
    const { siteId, modelId } = globalModelRouter.resolveRoute(params.model);
    const key = [params.companyId, params.agentId, params.projectId || "projectless", params.issueId || "conversation", siteId, modelId].join(":");
    return this.exclusive(this.locks, key, () => this.exclusive(this.accountLocks, siteId, async () => {
      params.signal?.throwIfAborted();
      const minPacingMs = siteId === "deepseek" ? 2500 : 300;
      const lastRequestTime = this.lastProviderRequestTime.get(siteId) || 0;
      const elapsedSinceLast = Date.now() - lastRequestTime;
      if (elapsedSinceLast < minPacingMs) {
        const delayMs = minPacingMs - elapsedSinceLast;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      let stored = this.read(key);
      const requestHash = crypto.createHash("sha256").update(params.prompt).digest("hex");
      if (params.requestId && stored?.lastRequestId === params.requestId && stored.lastReply?.status === "ok") {
        if (stored.lastRequestHash !== requestHash) throw new Error("معرف طلب مكرر بمحتوى مختلف");
        params.onSnapshot?.(stored.lastReply.text);
        return { ...stored.lastReply, binding: stored };
      }
      if (stored && ["sending", "awaiting_reply", "unknown"].includes(stored.status)) {
        throw new Error("نتيجة الطلب السابق غير محسومة. افتح محادثته وافحصها قبل إعادة الإرسال.");
      }
      if(params.forceFreshSession&&stored){
        this.save({...stored,key:key+":previous:"+crypto.randomUUID(),status:"archived"});
        this.sessions.delete(key);stored=undefined;
      }
      const adapter = this.adapterFor(siteId);
      let session = this.sessions.get(key);
      let restored = false;
      if (!session || session.isClosed()) {
        const canResume = stored?.url && stored.url !== new URL(stored.url).origin + "/" && !/\/(app|new)\/?$/.test(stored.url);
        session = canResume ? await adapter.resumeChat(stored!.url, modelId) : await adapter.newChat(modelId);
        restored = Boolean(canResume); this.sessions.set(key, session);
      }
      if(session.tabId&&params.agentName)await desktopRequest("tabs/label",{id:session.tabId,label:params.agentName+(params.issueTitle?" · "+params.issueTitle:"")}).catch(()=>{});
      const hash = crypto.createHash("sha256").update(params.instructions).digest("hex");
      const contextHash=crypto.createHash("sha256").update(params.context||"").digest("hex");
      const binding: BrowserBinding = {
        key, companyId: params.companyId, agentId: params.agentId, issueId: params.issueId,
        provider: siteId, model: modelId, url: session.url(), tabId: session.tabId,
        initializedHash: stored?.initializedHash, contextHash:stored?.contextHash, status: "sending", updatedAt: new Date().toISOString()
      };
      const initialized = stored?.initializedHash === hash && (restored || stored?.tabId === session.tabId);

      const sameConversation=restored||Boolean(stored?.tabId&&stored.tabId===session.tabId);
      const identity=initialized?"":(stored?.initializedHash&&sameConversation?"[تحديث تعليمات الدور]\n":"[تعريف الوكيل وسياق العمل]\n")+params.instructions+"\n\n";
      const updateContext=!initialized||stored?.contextHash!==contextHash;
      const prefix=identity+(updateContext&&params.context?"[سياق المشروع]\n"+params.context+"\n\n":"");

      this.save(binding);
      try {
        await session.setBusy?.(true);
        await session.waitUntilReady?.({signal:params.signal,onBlocker:params.onBlocker});
        params.signal?.throwIfAborted();
        await session.send(prefix + "[الطلب الحالي]\n" + params.prompt);
        binding.url = session.url(); binding.status = "awaiting_reply"; this.save(binding);
        let reply = await session.waitForReply({ signal: params.signal, onSnapshot: params.onSnapshot, onBlocker: params.onBlocker });
        const maxRetries = siteId === "deepseek" ? 3 : 1;
        let retryCount = 0;
        while (reply.status === "blocked" && reply.blocker === "provider_error" && retryCount < maxRetries) {
          retryCount++;
          const waitMs = retryCount * 2500;
          params.onBlocker?.(`مزود الخدمة مشغول (Rate Limit / Busy). إعادة المحاولة التلقائية رقم ${retryCount}/${maxRetries} بعد ${waitMs / 1000} ثوانٍ...`);
          await new Promise(r => setTimeout(r, waitMs));
          params.signal?.throwIfAborted();
          await session.send("[إعادة محاولة بعد الانتظار]\n" + params.prompt);
          reply = await session.waitForReply({ signal: params.signal, onSnapshot: params.onSnapshot, onBlocker: params.onBlocker });
        }
        if (params.requestId) { binding.lastRequestId = params.requestId; binding.lastRequestHash = requestHash; binding.lastReply = reply; }
        binding.url = session.url(); binding.updatedAt = new Date().toISOString();
        binding.status = reply.status === "ok" ? "idle" : reply.status === "cancelled" ? "cancelled" : reply.status === "timeout" ? "unknown" : reply.blocker || "blocked";
        if (reply.status === "ok") {binding.initializedHash = hash;binding.contextHash=contextHash;}
        this.save(binding); return { ...reply, binding };
      } catch (error) {
        binding.status = params.signal?.aborted ? "cancelled" : (error as any)?.beforeSubmit ? ((error as any).blocker || "blocked") : /login|Authentication|تسجيل الدخول/.test(String(error)) ? "login" : "unknown";
        this.save(binding); throw error;
      } finally {
        this.lastProviderRequestTime.set(siteId, Date.now());
        await session.setBusy?.(false).catch(()=>{});
      }
    }));
  }

  async open(companyId:string,key:string):Promise<{id:string}>{
    const record=this.read(key);
    if(!record||record.companyId!==companyId)throw new Error("المحادثة لا تتبع الشركة");
    const route=globalModelRouter.resolveRoute(record.model);
    if(route.siteId!==record.provider)throw new Error("منصة المحادثة غير متطابقة");
    let session=this.sessions.get(key);
    if(!session||session.isClosed()){
      if(!record.url)throw new Error("لا يوجد رابط محفوظ لهذه المحادثة");
      session=await this.adapterFor(record.provider).resumeChat(record.url,route.modelId);
      this.sessions.set(key,session);
    }
    if(!session.tabId)throw new Error("تعذر فتح تبويب المحادثة المدمج");
    this.save({...record,tabId:session.tabId});
    await this.showTab(session.tabId);
    return {id:session.tabId};
  }
  isProviderBusy(provider:string):boolean{return this.accountLocks.has(provider);}
  reset(companyId:string,key:string):void{
    if(this.locks.has(key))throw new Error("الجلسة تعمل الآن؛ أوقف التشغيل أولًا");
    const record=this.read(key);if(!record||record.companyId!==companyId)throw new Error("الجلسة لا تتبع الشركة");
    const archive=path.join(this.root,"archive");fs.mkdirSync(archive,{recursive:true});
    fs.renameSync(this.file(key),path.join(archive,path.basename(this.file(key))+"."+Date.now()));
    this.sessions.delete(key);
  }
  async cancel(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    const stopped = session && !session.isClosed() ? await session.stop() : false;
    const record = this.read(key);
    if (record) { record.status = stopped ? "cancelled" : "unknown"; this.save(record); }
    return Boolean(stopped);
  }
}
export const browserSessionHub = new BrowserSessionHub();
