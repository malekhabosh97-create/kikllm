import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { desktopConnection } from "./browser-provider/desktop-client.js";
import { globalModelRouter } from "./browser-provider/model-router.js";
export async function testEnvironment(context:AdapterEnvironmentTestContext):Promise<AdapterEnvironmentTestResult>{
  const checks:any[]=[];
  if(!desktopConnection())checks.push({code:"desktop_offline",level:"error",message:"متصفح التطبيق المدمج غير متصل",hint:"افتح تطبيق سطح المكتب ثم تبويب المتصفح."});
  else{
    const model=String(context.config?.model||"gemini-default");
    try{
      const route=globalModelRouter.resolveRoute(model),health=await globalModelRouter.getAdapter(route.siteId).health();
      checks.push({code:health.ok?"browser_ready":"browser_needs_attention",level:health.ok?"info":"warn",message:health.ok?"واجهة المحادثة جاهزة":health.reason||"تحتاج تدخلًا"});
    }catch(error){checks.push({code:"provider_error",level:"error",message:(error as Error).message});}
  }
  return {adapterType:"freellm_browser",status:checks.some(c=>c.level==="error")?"fail":checks.some(c=>c.level==="warn")?"warn":"pass",checks,testedAt:new Date().toISOString()};
}
