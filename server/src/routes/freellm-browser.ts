import { Router } from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, companies, issues, issueComments } from "@paperclipai/db";
import { eq, and, asc } from "drizzle-orm";
import { runAgentTurnLoop } from "../adapters/freellm-browser/unified-engine.js";

export function freellmBrowserRouter(db?: Db): Router {
  const router = Router();

  function getDaemonToken(): string {
    if (process.env.FREELLM_DAEMON_TOKEN) return process.env.FREELLM_DAEMON_TOKEN;
    const tokenPaths = [
      "C:\\Users\\malek\\.freellm-browser-profile\\token.txt",
      path.resolve(process.cwd(), "server/.browser-profile/token.txt"),
      path.resolve(process.cwd(), ".browser-profile/token.txt"),
    ];
    for (const p of tokenPaths) {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    }
    return "";
  }

  function forwardToDaemon(pathName: string, method: string, res: any, reqBody?: any) {
    const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
    const token = getDaemonToken();
    const payload = reqBody ? JSON.stringify(reqBody) : undefined;
    const headers: Record<string, string> = {
      "x-freellm-auth": token,
      "Content-Type": "application/json",
    };
    if (payload) {
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: pathName,
        method,
        headers,
      },
      (daemonRes) => {
        res.writeHead(daemonRes.statusCode || 200, daemonRes.headers);
        daemonRes.pipe(res);
      },
    );
    req.setTimeout(0);
    res.on("close", () => {
      req.destroy();
    });
    req.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "Browser Daemon unreachable", message: err.message });
      }
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  }

  router.get("/status", (_req, res) => forwardToDaemon("/status", "GET", res));
  router.get("/sessions", (_req, res) => forwardToDaemon("/sessions", "GET", res));
  router.post("/show", (_req, res) => forwardToDaemon("/window/show", "POST", res));
  router.post("/minimize", (_req, res) => forwardToDaemon("/window/minimize", "POST", res));
  router.post("/tab/open", (req, res) => forwardToDaemon("/tab/open", "POST", res, req.body));
  router.post("/cancel", (req, res) => forwardToDaemon("/cancel", "POST", res, req.body));
  router.post("/chat", (req, res) => forwardToDaemon("/chat", "POST", res, req.body));

  async function getOrCreateAgentConversationIssue(
    database: Db,
    companyId: string,
    agentId: string,
    agentName: string,
  ): Promise<string> {
    const [existing] = await database
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.conversationAgentId, agentId),
        ),
      )
      .limit(1);

    if (existing) {
      return existing.id;
    }

    const [created] = await database
      .insert(issues)
      .values({
        companyId,
        conversationAgentId: agentId,
        conversationUserId: "local-board",
        conversationState: "active",
        assigneeAgentId: agentId,
        title: `Direct Chat: ${agentName}`,
        description: `Standing conversation thread for agent ${agentName}`,
        status: "todo",
        priority: "medium",
        originKind: "conversation",
      })
      .returning({ id: issues.id });

    return created.id;
  }

  router.get("/agent-chat/history", async (req, res) => {
    try {
      const agentId = req.query.agentId as string;
      if (!agentId) {
        res.status(400).json({ error: "agentId is required" });
        return;
      }
      if (!db) {
        res.status(503).json({ error: "Database not connected" });
        return;
      }

      const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const issueId = await getOrCreateAgentConversationIssue(db, agent.companyId, agent.id, agent.name);

      const comments = await db
        .select({
          id: issueComments.id,
          body: issueComments.body,
          authorAgentId: issueComments.authorAgentId,
          authorType: issueComments.authorType,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));

      const messages = comments.map((c) => ({
        id: c.id,
        sender: c.authorAgentId ? "agent" : "user",
        text: c.body,
        timestamp: new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      }));

      res.json({ issueId, messages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/agent-chat/history", async (req, res) => {
    try {
      const agentId = req.query.agentId as string;
      if (!agentId || !db) {
        res.status(400).json({ error: "agentId is required" });
        return;
      }
      const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      const [issue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, agent.companyId),
            eq(issues.conversationAgentId, agent.id),
          ),
        );
      if (issue) {
        await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/agent-chat", async (req, res) => {
    try {
      const { agentId, prompt, workspaceRoot } = req.body;
      if (!agentId || !prompt) {
        res.status(400).json({ error: "Missing agentId or prompt" });
        return;
      }

      let agent: any = null;
      let issueId: string | null = null;

      if (db) {
        const [found] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
        if (found) {
          agent = found;
          issueId = await getOrCreateAgentConversationIssue(db, agent.companyId, agent.id, agent.name);
          // Persist user comment into Paperclip database
          await db.insert(issueComments).values({
            companyId: agent.companyId,
            issueId,
            body: prompt,
            authorType: "user",
          });
        }
      }

      // Set up SSE stream to browser client
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const abortController = new AbortController();
      res.on("close", () => {
        abortController.abort();
      });

      await runAgentTurnLoop({
        agentId,
        prompt,
        workspaceRoot: workspaceRoot || process.cwd(),
        db,
        companyId: agent?.companyId,
        issueId: issueId || undefined,
        signal: abortController.signal,
        onEvent: (event) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      });

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    }
  });

  router.post("/create-agent", async (req, res) => {
    try {
      const { companyId, name, role = "general", title, model = "gemini-argon", systemPrompt } = req.body;
      if (!name) {
        res.status(400).json({ error: "Agent name is required" });
        return;
      }

      const VALID_ROLES = new Set(["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"]);
      const requestedRole = (role || "").toLowerCase().trim();
      const mappedRole = VALID_ROLES.has(requestedRole) ? requestedRole : "engineer";

      let targetCompanyId = companyId;
      if (!targetCompanyId && db) {
        const [comp] = await db.select().from(companies).limit(1);
        if (comp) targetCompanyId = comp.id;
      }

      if (!targetCompanyId) {
        res.status(400).json({ error: "Company ID required" });
        return;
      }

      const userHome = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\malek";
      const agentInstructionsDir = path.join(userHome, ".paperclip", "instances", "default", "agents");
      fs.mkdirSync(agentInstructionsDir, { recursive: true });
      const instructionsFilePath = path.join(
        agentInstructionsDir,
        `${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}_instructions.md`,
      );

      const promptContent = systemPrompt || `You are ${name}, a specialized ${mappedRole} agent in FreeLLM Work. Fulfill your role with high precision and empirical evidence.`;
      fs.writeFileSync(instructionsFilePath, promptContent, "utf8");

      if (db) {
        const [createdAgent] = await db.insert(agentsTable).values({
          companyId: targetCompanyId,
          name,
          role: mappedRole,
          title: title || `${name} (${mappedRole.toUpperCase()})`,
          adapterType: "freellm_browser",
          adapterConfig: {
            model,
            systemPrompt: promptContent,
            instructionsFilePath,
          },
          status: "idle",
          permissions: { canCreateAgents: true, canCreateSkills: true },
        }).returning();

        res.status(201).json(createdAgent);
        return;
      }

      const serverPort = Number(process.env.PORT) || 3100;
      const agentPayload = JSON.stringify({
        name,
        role: mappedRole,
        title: title || `${name} (${mappedRole.toUpperCase()})`,
        adapterType: "freellm_browser",
        adapterConfig: { model, systemPrompt: promptContent, instructionsFilePath },
        permissions: { canCreateAgents: true, canCreateSkills: true },
      });

      const createReq = http.request(
        {
          hostname: "127.0.0.1",
          port: serverPort,
          path: `/api/companies/${targetCompanyId}/agents`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(agentPayload),
          },
        },
        (createRes) => {
          let data = "";
          createRes.on("data", (c) => (data += c));
          createRes.on("end", () => {
            try {
              const createdAgent = JSON.parse(data);
              res.status(createRes.statusCode || 201).json(createdAgent);
            } catch (err: any) {
              res.status(500).json({ error: "Failed to parse agent creation response", raw: data });
            }
          });
        },
      );
      createReq.on("error", (e) => res.status(502).json({ error: e.message }));
      createReq.write(agentPayload);
      createReq.end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
