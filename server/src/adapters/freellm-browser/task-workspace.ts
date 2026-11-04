import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runLocalGit } from "@paperclipai/adapter-utils/git-workspace-sync";
import type { FileMutationPayload } from "@paperclipai/shared";
import { assertSafeWorkspacePath, calculateSha256, stageFileMutation } from "../../services/file-mutation.js";

export interface TaskWorkspaceScope {
  companyId: string;
  projectId: string;
  taskId: string;
}
export interface PrepareTaskWorkspaceInput extends TaskWorkspaceScope {
  projectRoot: string;
  agentId: string;
  /** An operator-controlled directory outside projectRoot; never supplied directly by a model. */
  storageRoot?: string;
}
export interface TaskWorkspaceManifest extends TaskWorkspaceScope {
  version: 1;
  workspaceKey: string;
  agentId: string;
  baseRoot: string;
  cwd: string;
  strategy: "git_worktree" | "isolated_copy";
  baseCommit: string | null;
  createdAt: string;
  baseHashes: Record<string, string>;
  manifestPath: string;
}
export interface TaskDeliveryChange {
  relativePath: string;
  operation: "create" | "modify" | "delete";
  baseSha256: string | null;
  deliveredSha256: string | null;
  currentSha256: string | null;
  conflict: boolean;
}
export interface TaskDeliveryInspection {
  workspace: TaskWorkspaceManifest;
  changes: TaskDeliveryChange[];
  conflicts: string[];
  deliverySha256: string;
}
export interface StageTaskIntegrationInput extends TaskWorkspaceScope {
  projectRoot: string;
  storageRoot?: string;
  /** Each entry is a file or directory prefix, not a glob. At least one is required. */
  allowedPaths: string[];
  /** Binds approval to exactly the delivery that was reviewed. */
  expectedDeliverySha256: string;
}
const inFlight = new Map<string, Promise<unknown>>();
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const EXCLUDED = new Set([
  ".git", "node_modules", ".paperclip", ".freellm-runtime", ".browser-profile",
  ".venv", "venv", "dist", "build", "coverage", ".next", "target", ".cache",
  ".npmrc", ".netrc", "credentials", "id_rsa", "id_ed25519",
]);

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid " + label);
  return value;
}
function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function assertNoSymlinkAncestors(target: string): void {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink workspace path is not allowed: " + current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function projectRoot(input: string): string {
  assertNoSymlinkAncestors(input);
  if (!fs.statSync(input).isDirectory()) throw new Error("Project workspace is not a directory");
  return fs.realpathSync(input);
}
function pathsFor(input: { projectRoot: string; storageRoot?: string } & TaskWorkspaceScope) {
  const baseRoot = projectRoot(input.projectRoot);
  const company = safeSegment(input.companyId, "company id");
  const project = safeSegment(input.projectId, "project id");
  safeSegment(input.taskId, "task id");
  const storage = path.resolve(input.storageRoot || path.join(path.dirname(baseRoot), ".freellm-workspaces"));
  assertNoSymlinkAncestors(storage);
  if (contained(baseRoot, storage) || contained(storage, baseRoot)) throw new Error("Workspace storage must be outside the source project");
  const workspaceKey = crypto.createHash("sha256").update(JSON.stringify([normalized(baseRoot), company, project, input.taskId])).digest("hex").slice(0,32);
  const folder = path.join(storage, company, project, workspaceKey);
  assertNoSymlinkAncestors(folder);
  return { baseRoot, workspaceKey, folder, cwd:path.join(folder,"work"), manifestPath:path.join(folder,"manifest.json"), lockPath:path.join(folder,"prepare.lock") };
}
function excluded(relative: string): boolean {
  return relative.replace(/\\/g,"/").split("/").some(part =>
    EXCLUDED.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) ||
    /^\.freellm-.*-profile$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part)
  );
}
function internalState(relative: string): boolean {
  return /^\.freellm\/(?:project-contract\.json|project-state\.json|delivery-state\.json|contract\.json|state\.json|notes\/|workspaces\/|sessions\/|runs\/|locks\/)/i.test(relative.replace(/\\/g,"/"));
}
function scanFiles(root: string): Map<string, { hash:string; size:number }> {
  const found = new Map<string, { hash:string; size:number }>();
  let total = 0;
  const walk = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const relative = (prefix ? prefix + "/" : "") + entry.name;
      if (excluded(relative)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symlink files cannot be isolated or delivered: " + relative);
      if (entry.isDirectory()) { walk(full,relative); continue; }
      if (!entry.isFile()) throw new Error("Unsupported workspace entry: " + relative);
      const before=fs.lstatSync(full);
      if (before.size > MAX_FILE_BYTES) throw new Error("Workspace file exceeds isolation limit: " + relative);
      const data=fs.readFileSync(full);
      total += data.length;
      if (found.size + 1 > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error("Workspace exceeds isolation limits");
      found.set(relative,{hash:calculateSha256(data),size:data.length});
      const after=fs.lstatSync(full);
      if (after.size!==before.size || after.mtimeMs!==before.mtimeMs) throw new Error("Workspace changed while snapshotting: " + relative);
    }
  };
  walk(root,"");
  return found;
}
function validateManifest(value: unknown, expected: ReturnType<typeof pathsFor>, scope: TaskWorkspaceScope): TaskWorkspaceManifest {
  const record=value as TaskWorkspaceManifest;
  if (!record || record.version!==1 || record.companyId!==scope.companyId || record.projectId!==scope.projectId ||
    record.taskId!==scope.taskId || record.workspaceKey!==expected.workspaceKey || normalized(record.baseRoot)!==normalized(expected.baseRoot) ||
    normalized(record.cwd)!==normalized(expected.cwd) || normalized(record.manifestPath)!==normalized(expected.manifestPath) ||
    !["git_worktree","isolated_copy"].includes(record.strategy) || !record.baseHashes || typeof record.baseHashes!=="object") {
    throw new Error("Task workspace manifest does not match the requested scope");
  }
  assertNoSymlinkAncestors(record.cwd);
  if (!fs.existsSync(record.cwd) || !fs.statSync(record.cwd).isDirectory()) throw new Error("Isolated task workspace is missing");
  for (const [name,hash] of Object.entries(record.baseHashes)) {
    if (excluded(name) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid workspace base snapshot");
    assertSafeWorkspacePath(record.cwd,name);
  }
  return record;
}
async function exclusive<T>(key:string, action:()=>Promise<T>):Promise<T> {
  const prior=inFlight.get(key)||Promise.resolve();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  inFlight.set(key,gate);
  await prior.catch(()=>{});
  try { return await action(); }
  finally { release(); if(inFlight.get(key)===gate)inFlight.delete(key); }
}
export function loadTaskWorkspace(input: { projectRoot: string; storageRoot?: string } & TaskWorkspaceScope): TaskWorkspaceManifest | null {
  const resolved=pathsFor(input);
  if(!fs.existsSync(resolved.manifestPath))return null;
  assertNoSymlinkAncestors(resolved.manifestPath);
  return validateManifest(JSON.parse(fs.readFileSync(resolved.manifestPath,"utf8")),resolved,input);
}
async function gitRootAndHead(root:string):Promise<string|null> {
  try {
    const top=(await runLocalGit(root,["rev-parse","--show-toplevel"])).stdout.trim();
    if(normalized(top)!==normalized(root))throw new Error("Select the repository root before isolating a nested Git directory");
    return (await runLocalGit(root,["rev-parse","--verify","HEAD"])).stdout.trim();
  } catch(error) {
    if (fs.existsSync(path.join(root,".git"))) throw new Error("Git workspace could not be inspected: " + String(error));
    return null;
  }
}
function scrubCreatedCheckout(root:string, prefix=""):void {
  for(const entry of fs.readdirSync(path.join(root,prefix),{withFileTypes:true})){
    const relative=prefix?prefix+"/"+entry.name:entry.name;
    if(relative===".git")continue;
    const full=path.join(root,relative);
    if(entry.isSymbolicLink())throw new Error("Git checkout contains a symlink: "+relative);
    if(excluded(relative)){
      // This path belongs to a newly created checkout, never to the source.
      if(entry.isDirectory())fs.rmSync(full,{recursive:true});else fs.unlinkSync(full);
    } else if(entry.isDirectory())scrubCreatedCheckout(root,relative);
  }
}
export async function prepareTaskWorkspace(input:PrepareTaskWorkspaceInput):Promise<TaskWorkspaceManifest> {
  safeSegment(input.agentId,"agent id");
  const resolved=pathsFor(input);
  return exclusive(resolved.folder,async()=>{
    const existing=loadTaskWorkspace(input);
    if(existing){
      if(existing.agentId!==input.agentId)throw new Error("Task workspace is already owned by another agent");
      return existing;
    }
    fs.mkdirSync(resolved.folder,{recursive:true});
    assertNoSymlinkAncestors(resolved.folder);
    let lock:number;
    try{lock=fs.openSync(resolved.lockPath,"wx");}
    catch{throw new Error("Task workspace preparation is already running or needs recovery");}
    try{
      if(fs.existsSync(resolved.cwd))throw new Error("Unfinished workspace exists; inspect it before retrying preparation");
      const source=scanFiles(resolved.baseRoot);
      const baseCommit=await gitRootAndHead(resolved.baseRoot);
      if(baseCommit){
        await runLocalGit(resolved.baseRoot,["-c","core.hooksPath=" + path.join(resolved.folder,"no-hooks"),"worktree","add","--detach",resolved.cwd,baseCommit],{timeout:30000,maxBuffer:256*1024});
        scrubCreatedCheckout(resolved.cwd);
        const checkout=scanFiles(resolved.cwd);
        for(const name of checkout.keys())if(!source.has(name))fs.unlinkSync(assertSafeWorkspacePath(resolved.cwd,name));
      }else fs.mkdirSync(resolved.cwd);
      for(const [name,base] of source){
        const full=assertSafeWorkspacePath(resolved.baseRoot,name);
        const data=fs.readFileSync(full);
        if(calculateSha256(data)!==base.hash)throw new Error("Source changed while preparing task workspace: "+name);
        const target=assertSafeWorkspacePath(resolved.cwd,name);
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.writeFileSync(target,data);
      }
      const after=scanFiles(resolved.baseRoot);
      if(after.size!==source.size||[...source].some(([name,value])=>after.get(name)?.hash!==value.hash))throw new Error("Source changed while preparing task workspace; inspect before retrying");
      const record:TaskWorkspaceManifest={version:1,workspaceKey:resolved.workspaceKey,companyId:input.companyId,projectId:input.projectId,taskId:input.taskId,agentId:input.agentId,baseRoot:resolved.baseRoot,cwd:resolved.cwd,strategy:baseCommit?"git_worktree":"isolated_copy",baseCommit,createdAt:new Date().toISOString(),baseHashes:Object.fromEntries([...source].map(([name,entry])=>[name,entry.hash])),manifestPath:resolved.manifestPath};
      const temp=resolved.manifestPath+"."+crypto.randomUUID()+".tmp";
      fs.writeFileSync(temp,JSON.stringify(record,null,2),{flag:"wx"});
      fs.renameSync(temp,resolved.manifestPath);
      return record;
    }finally{fs.closeSync(lock);fs.unlinkSync(resolved.lockPath);}
  });
}
export function inspectTaskDelivery(input:{projectRoot:string;storageRoot?:string}&TaskWorkspaceScope):TaskDeliveryInspection {
  const workspace=loadTaskWorkspace(input);
  if(!workspace)throw new Error("Task has no isolated workspace");
  const delivered=scanFiles(workspace.cwd), current=scanFiles(workspace.baseRoot);
  const names=[...new Set([...Object.keys(workspace.baseHashes),...delivered.keys()])].sort();
  const changes:TaskDeliveryChange[]=[];
  for(const name of names){
    if(internalState(name))continue;
    const baseSha256=workspace.baseHashes[name]||null, deliveredSha256=delivered.get(name)?.hash||null;
    if(baseSha256===deliveredSha256)continue;
    const currentSha256=current.get(name)?.hash||null;
    // An identical result already integrated by an earlier attempt is safe and idempotent.
    if(currentSha256===deliveredSha256)continue;
    changes.push({relativePath:name,operation:!deliveredSha256?"delete":baseSha256?"modify":"create",baseSha256,deliveredSha256,currentSha256,conflict:currentSha256!==baseSha256});
  }
  const deliverySha256=calculateSha256(JSON.stringify(changes.map(change=>({path:change.relativePath,operation:change.operation,base:change.baseSha256,delivered:change.deliveredSha256}))));
  return {workspace,changes,conflicts:changes.filter(change=>change.conflict).map(change=>change.relativePath),deliverySha256};
}
function allowed(relative:string,prefixes:string[]):boolean {
  return prefixes.some(prefix=>relative===prefix||relative.startsWith(prefix+"/"));
}
export function stageTaskIntegration(input:StageTaskIntegrationInput):{workspace:TaskWorkspaceManifest;deliverySha256:string;mutations:FileMutationPayload[]} {
  if(!input.allowedPaths.length)throw new Error("Integration requires explicit allowed file paths");
  const inspection=inspectTaskDelivery(input);
  if(inspection.deliverySha256!==input.expectedDeliverySha256)throw new Error("Task delivery changed since review");
  if(inspection.conflicts.length)throw new Error("Integration conflicts require review: "+inspection.conflicts.join(", "));
  const prefixes=input.allowedPaths.map(name=>{
    if(path.isAbsolute(name)||name.split(/[\\/]/).some(part=>part===".."||part==="."||!part)||excluded(name)||internalState(name))throw new Error("Invalid integration path");
    assertSafeWorkspacePath(inspection.workspace.baseRoot,name);
    return name.replace(/\\/g,"/").replace(/\/$/,"");
  });
  const invalid=inspection.changes.filter(change=>!allowed(change.relativePath,prefixes));
  if(invalid.length)throw new Error("Delivery modifies files outside task ownership: "+invalid.map(change=>change.relativePath).join(", "));
  // Validate every change before staging any payload.
  const prepared=inspection.changes.map(change=>{
    let content:string|undefined;
    if(change.operation!=="delete"){
      const data=fs.readFileSync(assertSafeWorkspacePath(inspection.workspace.cwd,change.relativePath));
      if(calculateSha256(data)!==change.deliveredSha256)throw new Error("Delivery changed while staging");
      if(data.includes(0)||!Buffer.from(data.toString("utf8"),"utf8").equals(data))throw new Error("Binary delivery requires a dedicated artifact workflow: "+change.relativePath);
      content=data.toString("utf8");
    }
    return {change,content};
  });
  const mutations:FileMutationPayload[]=[];
  for(const {change,content} of prepared){
    const payload=stageFileMutation(inspection.workspace.baseRoot,{relativePath:change.relativePath,operation:change.operation,content});
    if(payload.baseSha256!==change.currentSha256)throw new Error("Source changed while staging integration");
    mutations.push(payload);
  }
  return {workspace:inspection.workspace,deliverySha256:inspection.deliverySha256,mutations};
}
