import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BasePlaywrightSiteAdapter, type SiteAdapterOptions } from "./site-adapter.js";
import type { SiteConfig, ChatSession, LiveModelInfo } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadDeepSeekConfig(): SiteConfig {
  const configPath = path.resolve(__dirname, "sites", "deepseek.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as SiteConfig;
}

export const DEFAULT_DEEPSEEK_PROFILE_DIR =
  process.env.FREELLM_DEEPSEEK_PROFILE_DIR || "C:\\Users\\malek\\.freellm-deepseek-profile";

export class DeepSeekSiteAdapter extends BasePlaywrightSiteAdapter {
  constructor(options?: Partial<SiteAdapterOptions>) {
    const config = options?.config || loadDeepSeekConfig();
    const profileDir = options?.profileDir || DEFAULT_DEEPSEEK_PROFILE_DIR;
    const headless = options?.headless ?? false;

    super({
      config,
      profileDir,
      headless,
      chromePath: options?.chromePath,
      embedded: options?.embedded,
    });
  }


  private async thinkingButton(page:any){
    for(const selector of ["button:has-text('DeepThink')","[role='button']:has-text('DeepThink')","button:has-text('深度思考')","[aria-label*='DeepThink']"]){
      const candidate=page.locator(selector).first();if(await candidate.isVisible().catch(()=>false))return candidate;
    }
    return null;
  }
  override async listModels():Promise<LiveModelInfo[]> {
    return this.enqueue(async()=>{
      const page=await this.providerPage(),toggle=await this.thinkingButton(page);
      const modes:LiveModelInfo[]=[{id:"deepseek-chat",label:"الوضع العادي",locked:false}];
      if(toggle)modes.push({id:"deepseek-reasoner",label:(await toggle.innerText()).trim()||"DeepThink",locked:await toggle.getAttribute("aria-disabled")==="true"});
      return modes;
    });
  }
  override async newChat(modelId?:string):Promise<ChatSession>{
    const session=await super.newChat(modelId),page=(session as any).getPage();
    const wantsThinking=/reasoner|r1|thinking/.test(modelId||"");
    const button=await this.thinkingButton(page);
    if(!button){if(wantsThinking)throw new Error("Thinking mode is unavailable in this account");return session;}
    const active=()=>button.evaluate((el:HTMLElement)=>{
      for(const attr of ["aria-pressed","aria-checked","data-state"]){const value=el.getAttribute(attr);if(value!==null)return value==="true"||value==="on"||value==="checked"||value==="active";}
      return /(^|[ _-])(active|selected|checked)([ _-]|$)/.test(el.className);
    });
    if(await active()!==wantsThinking)await button.click();
    if(await active()!==wantsThinking)throw new Error("Could not confirm the requested thinking mode");
    (session as any).observedModelLabel=(await button.innerText()).trim()+" "+(wantsThinking?"ON":"OFF");
    return session;
  }

}
