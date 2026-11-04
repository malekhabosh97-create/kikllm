import fs from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@paperclipai/db";
import { fileMutationPayloadSchema, type FileMutationPayload } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { applyFileMutation, assertSafeWorkspacePath } from "./file-mutation.js";

export async function resolveWorkspaceDirectory(db:Db,companyId:string,payload:FileMutationPayload):Promise<string> {
  const resolve = async(id:string) => {
    const [execution]=await db.select({cwd:executionWorkspaces.cwd}).from(executionWorkspaces).where(and(eq(executionWorkspaces.id,id),eq(executionWorkspaces.companyId,companyId)));
    if(execution?.cwd&&fs.existsSync(execution.cwd))return execution.cwd;
    const [project]=await db.select({cwd:projectWorkspaces.cwd}).from(projectWorkspaces).where(and(eq(projectWorkspaces.id,id),eq(projectWorkspaces.companyId,companyId)));
    return project?.cwd&&fs.existsSync(project.cwd)?project.cwd:null;
  };
  if(payload.workspaceId){const cwd=await resolve(payload.workspaceId);if(cwd)return cwd;throw unprocessable("Approval workspace is not available in this company");}
  if(payload.issueId){
    const [issue]=await db.select({workspaceId:issues.projectWorkspaceId}).from(issues).where(and(eq(issues.id,payload.issueId),eq(issues.companyId,companyId)));
    if(issue?.workspaceId){const cwd=await resolve(issue.workspaceId);if(cwd)return cwd;}
  }
  throw unprocessable("File approval requires an explicit workspace in this company");
}
export function validateSafePath(root:string,relative:string):string {
  try{return assertSafeWorkspacePath(root,relative);}catch(error){throw unprocessable((error as Error).message);}
}
export async function applyFileMutationApproval(db:Db,companyId:string,rawPayload:unknown) {
  const payload=fileMutationPayloadSchema.parse(rawPayload);
  const root=await resolveWorkspaceDirectory(db,companyId,payload);
  try{
    const result=applyFileMutation(root,payload);
    return {success:true,appliedPath:result.targetPath,operation:result.operation};
  }catch(error){throw unprocessable((error as Error).message);}
}
export async function cleanupFileMutationApproval(db:Db,companyId:string,rawPayload:unknown):Promise<void> {
  const parsed=fileMutationPayloadSchema.safeParse(rawPayload);if(!parsed.success)return;
  try{
    const root=await resolveWorkspaceDirectory(db,companyId,parsed.data);
    const owned=assertSafeWorkspacePath(root,path.join(".paperclip","staged-mutations"));
    const staged=assertSafeWorkspacePath(root,path.relative(root,parsed.data.stagedPath));
    const relative=path.relative(owned,staged);
    if(!relative||relative.startsWith("..")||path.isAbsolute(relative))return;
    if(fs.existsSync(staged)&&fs.statSync(staged).isFile())fs.unlinkSync(staged);
  }catch{/* A missing binding must never turn cleanup into arbitrary file deletion. */}
}
