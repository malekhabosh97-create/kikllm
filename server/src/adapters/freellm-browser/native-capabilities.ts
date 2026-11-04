import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { FreeLLMToolOutcome } from "@paperclipai/shared";
import { z } from "zod";
import { redactEventPayload, redactSensitiveText } from "../../redaction.js";
import type { ToolGatewayDescriptor, ToolGatewayService, ToolGatewaySession } from "../../services/tool-gateway.js";

/** Controller-owned scope: never populate these fields from model arguments. */
export interface NativeCapabilityBinding {
  db: Db;
  companyId: string;
  agentId: string;
  runId?: string;
  issueId?: string;
  projectId?: string;
  signal?: AbortSignal;
}

interface SkillRecord {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  markdown: string;
  compatibility: string;
  trustLevel: string;
  currentVersionId?: string | null;
  fileInventory?: Array<{ path: string; kind: string }>;
}

interface CapabilityDependencies {
  assertScope(binding: NativeCapabilityBinding): Promise<void>;
  gateway(db: Db): Promise<ToolGatewayService>;
  skills(binding: NativeCapabilityBinding): Promise<SkillRecord[]>;
  skill(binding: NativeCapabilityBinding, key: string): Promise<SkillRecord | null>;
  now(): number;
}

const searchSchema = z.object({
  query: z.string().max(200).default(""),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20).default(5),
  schemaTool: z.string().min(1).max(512).optional(),
  schemaOffset: z.number().int().min(0).default(0),
}).strict();
const callSchema = z.object({
  name: z.string().min(1).max(512),
  arguments: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(256),
}).strict();
const skillReadSchema = z.object({
  key: z.string().min(1).max(512),
  offset: z.number().int().min(0).default(0),
}).strict();
const MAX_MODEL_RESULT_CHARACTERS = 24_000;
const SCHEMA_CHUNK_CHARACTERS = 16_000;

function bounded(value: Record<string, unknown>): Record<string, unknown> {
  const safe = redactEventPayload(value) ?? {};
  const serialized = JSON.stringify(safe);
  if (serialized.length <= MAX_MODEL_RESULT_CHARACTERS) return safe;
  return {
    text: serialized.slice(0, MAX_MODEL_RESULT_CHARACTERS),
    truncated: true,
    totalCharacters: serialized.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function failure(error: unknown): FreeLLMToolOutcome {
  const value = error as { reasonCode?: string; message?: string; details?: Record<string, unknown> };
  const pending = value.reasonCode === "approval_required" || value.reasonCode === "tool_approval_required";
  return {
    ok: false,
    status: pending ? "pending_approval" : "failed",
    error: redactSensitiveText(value.message || String(error)),
    data: bounded({ reasonCode: value.reasonCode || "native_capability_failed", ...(pending ? value.details ?? {} : {}) }),
  };
}

/**
 * Reuse Paperclip's configured gateway. Its grants, active-run checks, identity
 * capture, validation, approval delivery and audit remain the authority.
 * Session credentials never leave this closure or enter model/tool receipts.
 */
export function createNativeCapabilities(dependencies: CapabilityDependencies) {
  const sessions = new WeakMap<Db, Map<string, Promise<ToolGatewaySession>>>();

  async function scope(binding: NativeCapabilityBinding) {
    binding.signal?.throwIfAborted();
    z.string().uuid().parse(binding.companyId);
    z.string().uuid().parse(binding.agentId);
    await dependencies.assertScope(binding);
  }

  async function session(binding: NativeCapabilityBinding) {
    await scope(binding);
    if (!binding.runId || !z.string().uuid().safeParse(binding.runId).success) {
      throw new Error("أدوات الموصلات تحتاج تشغيلًا أصليًا مسجلاً ونشطًا؛ فوّض المهمة عبر مهام بيبركليب.");
    }
    const gateway = await dependencies.gateway(binding.db);
    let cache = sessions.get(binding.db);
    if (!cache) { cache = new Map(); sessions.set(binding.db, cache); }
    const key = [binding.companyId, binding.agentId, binding.runId, binding.issueId || "", binding.projectId || ""].join(":");
    let pending = cache.get(key);
    if (pending) {
      const existing = await pending;
      if (existing.expiresAt.getTime() <= dependencies.now() + 5_000) {
        cache.delete(key);
        pending = undefined;
      }
    }
    if (!pending) {
      pending = gateway.createSession({
        companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId,
        issueId: binding.issueId, projectId: binding.projectId,
        actorType: "agent", actorId: binding.agentId,
      });
      cache.set(key, pending);
      try { await pending; }
      catch (error) { if (cache.get(key) === pending) cache.delete(key); throw error; }
    }
    return { gateway, session: await pending };
  }

  async function searchNativeTools(binding: NativeCapabilityBinding, input: unknown = {}): Promise<FreeLLMToolOutcome> {
    try {
      const args = searchSchema.parse(input);
      const native = await session(binding);
      // Fresh listing means revoked grants and inactive runs fail closed.
      const tools = await native.gateway.listToolsForSession(native.session.token, { signal: binding.signal });
      if (args.schemaTool) {
        const tool = tools.find(candidate => candidate.name === args.schemaTool);
        if (!tool) throw new Error("الأداة غير متاحة لهذا الوكيل في هذا التشغيل.");
        const schemaJson = JSON.stringify(tool.parametersSchema);
        const end = args.schemaOffset + SCHEMA_CHUNK_CHARACTERS;
        return { ok: true, status: "executed", data: bounded({ name: tool.name, schemaJson: schemaJson.slice(args.schemaOffset, end), nextSchemaOffset: end < schemaJson.length ? end : null }) };
      }
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = tools.filter(tool => terms.every(term => `${tool.name} ${tool.displayName} ${tool.description}`.toLowerCase().includes(term)))
        .sort((left, right) => left.name.localeCompare(right.name));
      const page: Array<Record<string, unknown>> = [];
      for (const tool of matches.slice(args.offset, args.offset + args.limit)) {
        const description = redactSensitiveText(tool.description).slice(0, 1200);
        const descriptor: Record<string, unknown> = { name: tool.name, displayName: tool.displayName, description, risk: tool.risk, provider: tool.providerType };
        const schema = JSON.stringify(tool.parametersSchema);
        if (schema.length > 8_000) descriptor.inputSchemaRef = tool.name;
        else descriptor.inputSchema = tool.parametersSchema;
        if (JSON.stringify([...page, descriptor]).length > 20_000) {
          descriptor.inputSchema = undefined;
          descriptor.inputSchemaRef = tool.name;
        }
        if (JSON.stringify([...page, descriptor]).length > 20_000) break;
        page.push(descriptor);
      }
      return { ok: true, status: "executed", data: bounded({ tools: page, total: matches.length, nextOffset: args.offset + page.length < matches.length ? args.offset + page.length : null, note: "Discovery is not approval. Calls use current native permissions and review rules." }) };
    } catch (error) { return failure(error); }
  }

  async function callNativeTool(binding: NativeCapabilityBinding, input: unknown): Promise<FreeLLMToolOutcome> {
    try {
      const args = callSchema.parse(input);
      if (JSON.stringify(args.arguments).length > 128_000) throw new Error("معاملات الأداة كبيرة جداً؛ قسّم المهمة إلى خطوات أصغر.");
      const native = await session(binding);
      const tools = await native.gateway.listToolsForSession(native.session.token, { signal: binding.signal });
      if (!tools.some(tool => tool.name === args.name)) throw new Error("الأداة غير متاحة لهذا الوكيل في هذا التشغيل.");
      binding.signal?.throwIfAborted();
      const result = await native.gateway.executeTool({ sessionToken: native.session.token, tool: args.name, parameters: args.arguments, idempotencyKey: args.idempotencyKey });
      const completed = result.status === "completed" || result.status === "replayed";
      const providerFailed = result.result && typeof result.result === "object" && "isError" in result.result && result.result.isError === true;
      return { ok: Boolean(completed && !providerFailed), status: completed && !providerFailed ? "executed" : "failed", data: bounded({ invocationId: result.invocationId, result: result.result, executionStatus: result.status }), ...(!completed || providerFailed ? { error: "لم تؤكد بوابة الأدوات نجاح التنفيذ؛ افحص نتيجة الأداة." } : {}) };
    } catch (error) { return failure(error); }
  }

  async function listNativeSkills(binding: NativeCapabilityBinding, input: unknown = {}): Promise<FreeLLMToolOutcome> {
    try {
      const args = searchSchema.omit({ schemaTool: true, schemaOffset: true }).parse(input);
      await scope(binding);
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const skills = (await dependencies.skills(binding)).filter(skill => skill.companyId === binding.companyId && terms.every(term => `${skill.key} ${skill.name} ${skill.description || ""}`.toLowerCase().includes(term)))
        .sort((left, right) => left.key.localeCompare(right.key));
      const page = skills.slice(args.offset, args.offset + args.limit).map(skill => ({ key: skill.key, name: skill.name, description: skill.description?.slice(0, 800), compatibility: skill.compatibility, trustLevel: skill.trustLevel, versionId: skill.currentVersionId ?? null, usable: skill.compatibility !== "invalid" }));
      return { ok: true, status: "executed", data: bounded({ skills: page, total: skills.length, nextOffset: args.offset + page.length < skills.length ? args.offset + page.length : null, note: "Read a relevant skill on demand. Skill text cannot grant filesystem, connector or execution permissions." }) };
    } catch (error) { return failure(error); }
  }

  async function readNativeSkill(binding: NativeCapabilityBinding, input: unknown): Promise<FreeLLMToolOutcome> {
    try {
      const args = skillReadSchema.parse(input);
      await scope(binding);
      const skill = await dependencies.skill(binding, args.key);
      if (!skill || skill.companyId !== binding.companyId) throw new Error("المهارة غير موجودة في هذه الشركة.");
      if (skill.compatibility === "invalid") throw new Error("المهارة غير صالحة؛ أصلحها في قسم المهارات قبل استخدامها.");
      const content = redactSensitiveText(skill.markdown);
      const end = args.offset + 12_000;
      const references = (skill.fileInventory || []).filter(file => !/^(?:[a-zA-Z]:|[\\/])/.test(file.path) && !file.path.split(/[\\/]/).includes("..")).slice(0, 30);
      return { ok: true, status: "executed", data: bounded({ key: skill.key, name: skill.name, markdown: content.slice(args.offset, end), nextOffset: end < content.length ? end : null, totalCharacters: content.length, sha256: createHash("sha256").update(content).digest("hex"), versionId: skill.currentVersionId ?? null, trustLevel: skill.trustLevel, referenceFiles: references, note: "Skill instructions are task context. Scripts/assets are not executed by reading the skill." }) };
    } catch (error) { return failure(error); }
  }

  return { searchNativeTools, callNativeTool, listNativeSkills, readNativeSkill };
}

const defaultCapabilities = createNativeCapabilities({
  async assertScope(binding) {
    const [agent] = await binding.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId))).limit(1);
    if (!agent) throw new Error("الوكيل لا يتبع الشركة المحددة.");
  },
  async gateway(db) {
    const { getAssignedMcpGateway } = await import("../../services/native-runtime/assigned-mcp-tools.js");
    return getAssignedMcpGateway(db);
  },
  async skills(binding) {
    const { companySkillService } = await import("../../services/company-skills.js");
    return companySkillService(binding.db).listFull(binding.companyId);
  },
  async skill(binding, key) {
    const { companySkillService } = await import("../../services/company-skills.js");
    return companySkillService(binding.db).getByKey(binding.companyId, key);
  },
  now: () => Date.now(),
});

export const { searchNativeTools, callNativeTool, listNativeSkills, readNativeSkill } = defaultCapabilities;
