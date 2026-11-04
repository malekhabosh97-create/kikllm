import {describe,it,expect,vi} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {withGracefulWindowsPostgresStop} from "./embedded-postgres-windows.js";
(process.platform==="win32"?describe:describe.skip)("owned PostgreSQL shutdown safeguards",()=>{
 it("preserves the original stop for constructor fixtures without a native child",async()=>{
  const stop=vi.fn(async()=>{}),instance=withGracefulWindowsPostgresStop({stop},"unused");await instance.stop();expect(stop).toHaveBeenCalledOnce();
 });
 it("does not wait for an already exited process",async()=>{
  const stop=vi.fn(async()=>{}),instance=withGracefulWindowsPostgresStop({stop,process:{pid:123,spawnfile:"postgres.exe",exitCode:1}},"unused");await instance.stop();expect(stop).not.toHaveBeenCalled();expect(instance.process).toBeUndefined();
 });
 it("refuses a data directory whose owner differs from the native child",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"freellm-pg-owner-")),stop=vi.fn(async()=>{});
  try{
   fs.writeFileSync(path.join(root,"postmaster.pid"),"987654\n"+root+"\n");
   const instance=withGracefulWindowsPostgresStop({stop,process:{pid:123,spawnfile:path.join(root,"postgres.exe"),exitCode:null}},root);
   await expect(instance.stop()).rejects.toThrow(/does not identify the owned process/);expect(stop).not.toHaveBeenCalled();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
