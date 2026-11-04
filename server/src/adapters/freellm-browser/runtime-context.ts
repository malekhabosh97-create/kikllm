import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { WakeupOptions } from "../../services/heartbeat/run-preparation.js";
interface FreeLLMRuntime {
  db?: Db;
  databaseUrl?: string;
  transport?: (params:any)=>Promise<any>;
  wake?: (agentId: string, options: WakeupOptions) => Promise<unknown>;
}
let runtime: FreeLLMRuntime = {};
let saverPromise: Promise<PostgresSaver> | undefined;
export function configureFreeLLMRuntime(next: FreeLLMRuntime) { runtime = { ...runtime, ...next }; }
export function freeLLMRuntime() { return runtime; }
export async function freeLLMCheckpointer(): Promise<PostgresSaver | undefined> {
  if (!runtime.databaseUrl || !runtime.db) return undefined;
  if (!saverPromise) saverPromise = (async () => {
    await runtime.db!.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS freellm_graph"));
    const saver = PostgresSaver.fromConnString(runtime.databaseUrl!, { schema: "freellm_graph" });
    await saver.setup(); return saver;
  })();
  try { return await saverPromise; } catch (error) { saverPromise = undefined; throw error; }
}
export async function closeFreeLLMRuntime() { if (saverPromise) await (await saverPromise).end(); saverPromise = undefined; }
