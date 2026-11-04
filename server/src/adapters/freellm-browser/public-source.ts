import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
export function isPublicAddress(address:string):boolean {
  const value=address.toLowerCase();
  if(isIP(value)===4){
    const [a,b,c]=value.split(".").map(Number);
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(value)===6)return /^[23]/.test(value)&&!value.startsWith("2001:db8:")&&!value.startsWith("2001:2:")&&!value.startsWith("2002:");
  return false;
}
export async function readPublicSource(raw:string,redirects=0):Promise<{url:string;content:string;retrievedAt:string;contentType:string}> {
  const url=new URL(raw),hostname=url.hostname.replace(/^\[|\]$/g,"");
  if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443")throw new Error("Only public HTTPS sources are allowed");
  const addresses=await lookup(hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new Error("The source resolves to a private or reserved network");
  const pinned=addresses.find(a=>a.family===4)||addresses[0];
  const result=await new Promise<{status:number;location?:string;type:string;body:string}>((resolve,reject)=>{
    const req=request(url,{headers:{"user-agent":"FreeLLM-Research/1.0",accept:"text/html,application/json,text/plain"},lookup:(_host,options,callback:any)=>(options as any).all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)},response=>{
      const status=response.statusCode||0,type=String(response.headers["content-type"]||"");
      if(status>=300&&status<400){response.resume();resolve({status,location:response.headers.location,type,body:""});return;}
      if(status!==200){response.resume();reject(new Error("Source HTTP "+status));return;}
      if(!/text|json|xml/.test(type)){response.resume();reject(new Error("The source is not textual"));return;}
      const chunks:Buffer[]=[];let bytes=0;
      response.on("data",chunk=>{bytes+=chunk.length;if(bytes>1024*1024){response.destroy(new Error("Source exceeds the 1 MB limit"));return;}chunks.push(chunk);});
      response.on("error",reject);response.on("end",()=>resolve({status,type,body:Buffer.concat(chunks).toString("utf8")}));
    });
    req.setTimeout(20000,()=>req.destroy(new Error("Source timed out")));req.on("error",reject);req.end();
  });
  if(result.location){if(redirects>=3)throw new Error("Too many redirects");return readPublicSource(new URL(result.location,url).href,redirects+1);}
  const content=result.type.includes("html")?result.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,32000):result.body;
  return {url:url.href,content,retrievedAt:new Date().toISOString(),contentType:result.type};
}
