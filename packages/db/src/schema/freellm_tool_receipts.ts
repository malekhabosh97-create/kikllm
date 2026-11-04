import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
export const freellmToolReceipts = pgTable("freellm_tool_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id,{onDelete:"cascade"}),
  agentId: uuid("agent_id").notNull().references(() => agents.id,{onDelete:"cascade"}),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  runKey: text("run_key").notNull(),
  callId: text("call_id").notNull(),
  argumentsHash: text("arguments_hash").notNull(),
  tool: text("tool").notNull(),
  status: text("status").notNull().default("started"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  callUnique: uniqueIndex("freellm_tool_receipts_run_call_uniq").on(table.companyId, table.runKey, table.callId),
  companyRun: index("freellm_tool_receipts_company_run_idx").on(table.companyId, table.runKey),
}));
