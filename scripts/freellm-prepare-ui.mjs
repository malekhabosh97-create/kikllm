import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const source=path.join(root,"ui","dist"),target=path.join(root,"server","ui-dist");
if(!fs.existsSync(path.join(source,"index.html")))throw new Error("Build the UI first: pnpm --filter @paperclipai/ui build");
const current=fs.existsSync(path.join(target,"index.html"))?fs.readFileSync(path.join(target,"index.html"),"utf8"):"";
if(current!==fs.readFileSync(path.join(source,"index.html"),"utf8")){fs.mkdirSync(target,{recursive:true});fs.cpSync(source,target,{recursive:true,force:true});console.log("FreeLLM desktop UI synchronized.");}
