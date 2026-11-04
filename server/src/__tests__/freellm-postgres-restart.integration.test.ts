import {describe,it,expect} from "vitest";
import fs from "node:fs";import net from "node:net";
import {sql} from "drizzle-orm";
import {createDb} from "@paperclipai/db";
import {__startEmbeddedPostgresWithRetryForTests as startCluster} from "../../../packages/db/src/test-embedded-postgres.js";
const enabled=process.platform==="win32"&&process.env.FREELLM_INTEGRATION==="1";
(enabled?describe:describe.skip)("Windows PostgreSQL lifecycle",()=>{
 it("stops and reopens the same persistent cluster twice without orphaned listeners or lost data",async()=>{
  const started=await startCluster("freellm-restart-"),url="postgres://paperclip:paperclip@127.0.0.1:"+started.port+"/postgres";
  let db:ReturnType<typeof createDb>|undefined;
  const portIsFree=()=>new Promise<boolean>(resolve=>{const server=net.createServer();server.once("error",()=>resolve(false));server.listen(started.port,"127.0.0.1",()=>server.close(()=>resolve(true)));});
  let stopped=false;
  try{
   db=createDb(url);await db.execute(sql.raw("CREATE TABLE freellm_restart_proof(value text NOT NULL)"));await db.execute(sql.raw("INSERT INTO freellm_restart_proof VALUES ('preserved')"));await db.$client.end({timeout:0});db=undefined;
   await started.instance.stop();stopped=true;expect(await portIsFree()).toBe(true);
   await started.instance.start();stopped=false;
   db=createDb(url);const rows=await db.execute(sql.raw("SELECT value FROM freellm_restart_proof"));expect(rows[0].value).toBe("preserved");await db.$client.end({timeout:0});db=undefined;
   await started.instance.stop();stopped=true;expect(await portIsFree()).toBe(true);
  }finally{await db?.$client.end({timeout:0});if(!stopped){await started.instance.stop();stopped=true;}if(stopped)fs.rmSync(started.dataDir,{recursive:true,force:true});}
 },90000);
});
