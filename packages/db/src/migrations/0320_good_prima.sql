CREATE TABLE "freellm_tool_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_key" text NOT NULL,
	"call_id" text NOT NULL,
	"arguments_hash" text NOT NULL,
	"tool" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" ADD CONSTRAINT "freellm_tool_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" ADD CONSTRAINT "freellm_tool_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freellm_tool_receipts" ADD CONSTRAINT "freellm_tool_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "freellm_tool_receipts_run_call_uniq" ON "freellm_tool_receipts" USING btree ("company_id","run_key","call_id");--> statement-breakpoint
CREATE INDEX "freellm_tool_receipts_company_run_idx" ON "freellm_tool_receipts" USING btree ("company_id","run_key");