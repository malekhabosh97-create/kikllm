ALTER TABLE "freellm_tool_receipts" DROP CONSTRAINT "freellm_tool_receipts_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" DROP CONSTRAINT "freellm_tool_receipts_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" ADD CONSTRAINT "freellm_tool_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" ADD CONSTRAINT "freellm_tool_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;