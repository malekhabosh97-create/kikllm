import type { FreeLLMTurnEvent } from "@paperclipai/shared";
declare global {
  interface Window {
    freellmDesktop?: {
      embedded: boolean;
      setBrowserBounds(bounds:{x:number;y:number;width:number;height:number;visible?:boolean}):Promise<boolean>;
      hideBrowser():Promise<boolean>;
      selectFolder():Promise<string|null>;
      onTabSelected(callback:(tab:{id:string})=>void):()=>void;
    };
  }
}
export async function freeLLMRequest<T>(url:string,body?:unknown):Promise<T>{
  const response=await fetch("/api/browser"+url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||value.message||"تعذر تنفيذ الطلب");
  return value as T;
}
export async function readFreeLLMStream(response:Response,onEvent:(event:FreeLLMTurnEvent&{sequence?:number})=>void){
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||error.message||"تعذر بدء التشغيل");}
  const reader=response.body?.getReader();if(!reader)throw new Error("البث غير متاح");
  const decoder=new TextDecoder();let pending="";
  const process=(line:string)=>{if(!line.startsWith("data:"))return;const raw=line.slice(5).trim();if(!raw)return;onEvent(JSON.parse(raw));};
  while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});const lines=pending.split(/\r?\n/);pending=lines.pop()||"";for(const line of lines)process(line);}
  pending+=decoder.decode();if(pending.trim())process(pending);
}
