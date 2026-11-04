import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { assertSafeWorkspacePath } from "../../services/file-mutation.js";

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const relativePath = z.string().min(1).max(500).refine(value => {
  const normalized = value.replace(/\\/g, "/");
  return !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(value) &&
    !normalized.split("/").some(part => part === ".." || part.includes(":")) &&
    !/[\x00*?\[\]]/.test(normalized) &&
    !normalized.split("/").some(part => [".git", ".env", "node_modules", ".freellm-runtime"].includes(part) || part.startsWith(".env.")) &&
    !normalized.startsWith(".freellm/contracts");
}, "Use a project-relative file or directory path without wildcards or private runtime files");
const criterion = z.object({
  id,
  description: z.string().min(10).max(2000),
  expectedFiles: z.array(relativePath).max(100).default([]),
  command: z.string().min(3).max(2000).optional(),
});
const moduleInput = z.object({
  id, title: z.string().min(3).max(300), role: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100).optional(),
  dependencies: z.array(id).max(50).default([]),
  allowedPaths: z.array(relativePath).min(1).max(100),
  acceptanceCriteriaIds: z.array(id).min(1).max(60),
});
export const projectContractInputSchema = z.object({
  goal: z.string().min(10).max(10000),
  kind: z.enum(["code", "research", "content"]),
  stack: z.array(z.string().min(1).max(200)).max(30).default([]),
  acceptanceCriteria: z.array(criterion).min(1).max(60),
  modules: z.array(moduleInput).min(1).max(50),
  reviewPolicy: z.enum(["independent", "checks"]).default("independent"),
});
export type ProjectContractInput = z.input<typeof projectContractInputSchema>;
type Plan = z.output<typeof projectContractInputSchema>;
export type ProjectModuleStatus = "planned" | "ready" | "running" | "review" | "needs_changes" | "done" | "blocked";
export interface ProjectContractScope { companyId: string; projectId?: string; }
export interface ProjectContractActor { agentId: string; role?: string; canManage?: boolean; }
export interface ProjectCheckResult {
  criterionId: string; passed: boolean; command?: string; exitCode?: number;
  files: Array<{ path: string; sha256: string | null }>;
  error?: string;
}
export interface ProjectAcceptanceEvidence {
  id: string; moduleId?: string; planHash: string; actorAgentId: string; createdAt: string;
  passed: boolean; checks: ProjectCheckResult[];
}
export interface ProjectReview {
  moduleId: string; agentId: string; approved: boolean; summary: string;
  evidenceId: string; createdAt: string;
}
export interface ProjectContract extends Plan {
  version: 1; companyId: string; projectId?: string; revision: number; planHash: string;
  createdAt: string; updatedAt: string; createdByAgentId: string;
  modules: Array<Plan["modules"][number] & { status: ProjectModuleStatus; summary?: string }>;
  evidence: ProjectAcceptanceEvidence[]; reviews: ProjectReview[];
}
export type ProjectAcceptanceRunner = (command: string) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

function hash(value: string | Buffer) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonicalPath(value: string) { return path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/$/, ""); }
function containsPath(prefix: string, target: string) {
  const left = canonicalPath(prefix), right = canonicalPath(target);
  return left === "." || left === right || right.startsWith(left + "/");
}
function requireManager(actor: ProjectContractActor) {
  if (!actor.canManage && !["ceo", "cto", "manager", "lead", "board"].includes(actor.role || "")) throw new Error("Only a project manager can create or revise the delivery contract");
}
function contractFile(root: string, scope: ProjectContractScope) {
  if (!scope.companyId.trim()) throw new Error("A company scope is required");
  const name = hash(JSON.stringify([scope.companyId, scope.projectId || "projectless"]));
  return assertSafeWorkspacePath(root, ".freellm/contracts/" + name + ".json");
}
function validatePlan(input: ProjectContractInput): Plan {
  const plan = projectContractInputSchema.parse(input);
  const criteria = new Map(plan.acceptanceCriteria.map(item => [item.id, item]));
  const modules = new Map(plan.modules.map(item => [item.id, item]));
  if (criteria.size !== plan.acceptanceCriteria.length || modules.size !== plan.modules.length) throw new Error("Module and acceptance criterion IDs must be unique");
  if (!plan.acceptanceCriteria.some(item => item.expectedFiles.length)) throw new Error("A deliverable requires at least one expected file");
  if (plan.kind === "code" && !plan.acceptanceCriteria.some(item => item.command)) throw new Error("Code delivery requires an acceptance test command fixed in the plan");
  for (const item of plan.acceptanceCriteria) {
    if (item.command && /^(?:echo\b|printf\b|write-output\b|true\s*$|exit(?:\s+0)?\s*$)/i.test(item.command.trim())) throw new Error("A success message is not an acceptance test command");
  }
  const visit = (current: string, active: Set<string>, visited: Set<string>) => {
    if (active.has(current)) throw new Error("Module dependencies contain a cycle");
    if (visited.has(current)) return;
    active.add(current);
    for (const dependency of modules.get(current)!.dependencies) {
      if (!modules.has(dependency)) throw new Error("Unknown module dependency: " + dependency);
      visit(dependency, active, visited);
    }
    active.delete(current); visited.add(current);
  };
  const visited = new Set<string>();
  for (const item of plan.modules) {
    visit(item.id, new Set(), visited);
    for (const check of item.acceptanceCriteriaIds) {
      if (!criteria.has(check)) throw new Error("Unknown acceptance criterion: " + check);
    }
  }
  const used = new Set(plan.modules.flatMap(item => item.acceptanceCriteriaIds));
  if (plan.acceptanceCriteria.some(item => !used.has(item.id))) throw new Error("Every acceptance criterion must belong to a module");
  const dependsOn = (from: string, target: string): boolean => modules.get(from)!.dependencies.some(dependency => dependency === target || dependsOn(dependency, target));
  for (let left = 0; left < plan.modules.length; left++) for (let right = left + 1; right < plan.modules.length; right++) {
    const a = plan.modules[left], b = plan.modules[right];
    if (a.allowedPaths.some(first => b.allowedPaths.some(second => containsPath(first, second) || containsPath(second, first))) && !dependsOn(a.id, b.id) && !dependsOn(b.id, a.id)) throw new Error("Parallel modules cannot own overlapping paths; separate ownership or add a dependency");
  }
  return plan;
}
function planHash(plan: Plan) { return hash(JSON.stringify(plan)); }
function validateStored(value: unknown, scope: ProjectContractScope): ProjectContract {
  const state = value as ProjectContract;
  if (!state || state.version !== 1 || !Number.isInteger(state.revision) || state.revision < 1 || state.companyId !== scope.companyId || state.projectId !== scope.projectId) throw new Error("Contract scope or version mismatch");
  const plan = validatePlan(state);
  if (planHash(plan) !== state.planHash || !Array.isArray(state.evidence) || !Array.isArray(state.reviews)) throw new Error("Contract integrity check failed");
  const statuses = new Set(["planned", "ready", "running", "review", "needs_changes", "done", "blocked"]);
  if (state.modules.some(item => !statuses.has(item.status))) throw new Error("Invalid module state");
  return state;
}
export function loadProjectContract(root: string, scope: ProjectContractScope): ProjectContract | null {
  const file = contractFile(root, scope);
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("Project contract exceeds the supported size");
  return validateStored(JSON.parse(fs.readFileSync(file, "utf8")), scope);
}
async function withContractLock<T>(root: string, scope: ProjectContractScope, action: (file: string) => T | Promise<T>): Promise<T> {
  const file = contractFile(root, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + ".lock", token = crypto.randomUUID();
  const until = Date.now() + 5000;
  let handle: number;
  for (;;) {
    try { handle = fs.openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new Error("Project contract is locked; check the existing owner before recovery");
      await delay(20);
    }
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
    fs.closeSync(handle);
    return await action(file);
  } finally {
    try { if (JSON.parse(fs.readFileSync(lock, "utf8")).token === token) fs.unlinkSync(lock); } catch { /* Preserve a lock whose ownership cannot be confirmed. */ }
  }
}
function persist(file: string, state: ProjectContract) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  const contents = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(contents) > 2 * 1024 * 1024) throw new Error("Project contract exceeds the supported size");
  const handle = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(handle, contents); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function expected(state: ProjectContract | null, revision: number): ProjectContract {
  if (!state) throw new Error("Create a project delivery contract first");
  if (state.revision !== revision) throw new Error("The project plan changed; reload its current revision before updating it");
  return state;
}
function getModule(state: ProjectContract, moduleId: string) {
  const item = state.modules.find(module => module.id === moduleId);
  if (!item) throw new Error("Unknown project module: " + moduleId);
  return item;
}
function requireModuleActor(state: ProjectContract, actor: ProjectContractActor, moduleId?: string) {
  if (!moduleId) { requireManager(actor); return; }
  const item = getModule(state, moduleId);
  if (item.agentId !== actor.agentId) requireManager(actor);
}
function revised(state: ProjectContract) { state.revision++; state.updatedAt = new Date().toISOString(); return state; }
export async function createProjectContract(root: string, scope: ProjectContractScope, actor: ProjectContractActor, input: ProjectContractInput): Promise<ProjectContract> {
  requireManager(actor); const plan = validatePlan(input);
  return withContractLock(root, scope, file => {
    if (loadProjectContract(root, scope)) throw new Error("A contract already exists; revise it using its current revision");
    const now = new Date().toISOString();
    const state: ProjectContract = { ...plan, version: 1, ...scope, revision: 1, planHash: planHash(plan), createdAt: now, updatedAt: now, createdByAgentId: actor.agentId, modules: plan.modules.map(item => ({ ...item, status: "planned" })), evidence: [], reviews: [] };
    persist(file, state); return state;
  });
}
export async function reviseProjectContract(root: string, scope: ProjectContractScope, actor: ProjectContractActor, options: { expectedRevision: number; input: ProjectContractInput }): Promise<ProjectContract> {
  requireManager(actor); const plan = validatePlan(options.input);
  return withContractLock(root, scope, file => {
    const previous = expected(loadProjectContract(root, scope), options.expectedRevision);
    if (previous.modules.some(item => item.status === "running")) throw new Error("Stop active module work before revising its contract");
    const state: ProjectContract = { ...previous, ...plan, planHash: planHash(plan), modules: plan.modules.map(item => ({ ...item, status: "planned" })), evidence: [], reviews: [] };
    persist(file, revised(state)); return state;
  });
}
export function readyProjectModules(state: ProjectContract) {
  return state.modules.filter(item => ["planned", "ready", "needs_changes"].includes(item.status) && item.dependencies.every(dependency => getModule(state, dependency).status === "done"));
}
export function assertProjectPathOwnership(state: ProjectContract, moduleId: string, relative: string) {
  const checked = relativePath.parse(relative);
  if (!getModule(state, moduleId).allowedPaths.some(prefix => containsPath(prefix, checked))) throw new Error("The file is owned by another project module: " + relative);
}
export async function transitionProjectModule(root: string, scope: ProjectContractScope, actor: ProjectContractActor, options: { expectedRevision: number; moduleId: string; status: Exclude<ProjectModuleStatus, "done">; summary?: string }): Promise<ProjectContract> {
  return withContractLock(root, scope, file => {
    const state = expected(loadProjectContract(root, scope), options.expectedRevision);
    requireModuleActor(state, actor, options.moduleId);
    const item = getModule(state, options.moduleId);
    const transitions: Record<ProjectModuleStatus, string[]> = { planned: ["ready", "running", "blocked"], ready: ["running", "blocked"], running: ["review", "blocked", "needs_changes"], review: ["running", "needs_changes", "blocked"], needs_changes: ["ready", "running", "blocked"], done: ["needs_changes"], blocked: ["ready", "needs_changes"] };
    if (!transitions[item.status].includes(options.status)) throw new Error("Invalid module transition: " + item.status + " → " + options.status);
    if (["ready", "running"].includes(options.status) && !item.dependencies.every(dependency => getModule(state, dependency).status === "done")) throw new Error("Complete module dependencies before starting this work");
    item.status = options.status; item.summary = options.summary?.slice(0, 2000);
    if (["running", "needs_changes"].includes(options.status)) { state.evidence = state.evidence.filter(value => value.moduleId !== item.id && value.moduleId !== undefined); state.reviews = state.reviews.filter(value => value.moduleId !== item.id); }
    persist(file, revised(state)); return state;
  });
}
function fileSnapshot(root: string, paths: string[]) {
  return paths.map(relative => {
    const file = assertSafeWorkspacePath(root, relative);
    try { const stat = fs.statSync(file); return { path: relative, sha256: stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024 * 1024 ? hash(fs.readFileSync(file)) : null }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relative, sha256: null }; throw error; }
  });
}
function snapshotCurrent(root: string, evidence: ProjectAcceptanceEvidence) {
  return evidence.checks.every(check => JSON.stringify(fileSnapshot(root, check.files.map(file => file.path))) === JSON.stringify(check.files));
}
export async function runProjectAcceptance(root: string, scope: ProjectContractScope, actor: ProjectContractActor, runner: ProjectAcceptanceRunner, options: { expectedRevision: number; moduleId?: string }): Promise<{ contract: ProjectContract; evidence: ProjectAcceptanceEvidence }> {
  const initial = expected(loadProjectContract(root, scope), options.expectedRevision);
  requireModuleActor(initial, actor, options.moduleId);
  const selected = options.moduleId ? initial.acceptanceCriteria.filter(check => getModule(initial, options.moduleId!).acceptanceCriteriaIds.includes(check.id)) : initial.acceptanceCriteria;
  const checks: ProjectCheckResult[] = [];
  for (const check of selected) {
    const before = fileSnapshot(root, check.expectedFiles);
    let exitCode: number | undefined, error: string | undefined;
    if (check.command) {
      try { exitCode = (await runner(check.command)).exitCode; if (exitCode !== 0) error = "The planned acceptance command failed"; }
      catch { exitCode = -1; error = "The planned acceptance command could not run"; }
    }
    const files = fileSnapshot(root, check.expectedFiles);
    if (JSON.stringify(before) !== JSON.stringify(files)) error = "Deliverable files changed during verification; run the checks again";
    if (files.some(file => !file.sha256)) error = "An expected deliverable file is missing or empty";
    checks.push({ criterionId: check.id, passed: !error && (!check.command || exitCode === 0), command: check.command, exitCode, files, error });
  }
  const evidence: ProjectAcceptanceEvidence = { id: crypto.randomUUID(), moduleId: options.moduleId, planHash: initial.planHash, actorAgentId: actor.agentId, createdAt: new Date().toISOString(), passed: checks.length > 0 && checks.every(check => check.passed), checks };
  return withContractLock(root, scope, file => {
    const state = expected(loadProjectContract(root, scope), options.expectedRevision);
    if (state.planHash !== evidence.planHash || !snapshotCurrent(root, evidence)) throw new Error("The project changed while verification was running; verify the current files again");
    state.evidence = [...state.evidence.filter(value => value.moduleId !== options.moduleId), evidence].slice(-60);
    if (options.moduleId) { const item = getModule(state, options.moduleId); item.status = evidence.passed ? state.reviewPolicy === "checks" ? "done" : "review" : "needs_changes"; }
    persist(file, revised(state)); return { contract: state, evidence };
  });
}
export async function reviewProjectDelivery(root: string, scope: ProjectContractScope, actor: ProjectContractActor, options: { expectedRevision: number; moduleId: string; approved: boolean; summary: string }): Promise<ProjectContract> {
  if (options.summary.trim().length < 10) throw new Error("A review must explain its findings");
  return withContractLock(root, scope, file => {
    const state = expected(loadProjectContract(root, scope), options.expectedRevision), item = getModule(state, options.moduleId);
    if (actor.agentId === item.agentId || (!item.agentId && actor.agentId === state.createdByAgentId)) throw new Error("A delivery must be reviewed by an independent agent");
    const evidence = state.evidence.find(value => value.moduleId === item.id);
    if (!evidence?.passed || evidence.planHash !== state.planHash || !snapshotCurrent(root, evidence)) throw new Error("Run successful acceptance checks on the current files before review");
    if (item.status !== "review") throw new Error("Only a submitted delivery can be reviewed");
    state.reviews.push({ moduleId: item.id, agentId: actor.agentId, approved: options.approved, summary: options.summary.slice(0, 4000), evidenceId: evidence.id, createdAt: new Date().toISOString() });
    item.status = options.approved ? "done" : "needs_changes";
    persist(file, revised(state)); return state;
  });
}
export function projectDeliveryStatus(root: string, state: ProjectContract) {
  const verified = state.evidence.find(value => !value.moduleId && value.planHash === state.planHash && value.passed);
  const modulesDone = state.modules.every(item => item.status === "done");
  const current = Boolean(verified && snapshotCurrent(root, verified));
  return { completed: modulesDone && current, modulesDone, acceptanceCurrent: current, readyModules: readyProjectModules(state).map(item => item.id), blockers: state.modules.filter(item => ["blocked", "needs_changes"].includes(item.status)).map(item => ({ id: item.id, status: item.status, summary: item.summary })) };
}
