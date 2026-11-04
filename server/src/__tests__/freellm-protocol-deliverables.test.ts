import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { classifyModelReply, executeToolOutcome } from "../adapters/freellm-browser/tool-executor.js";
import { runAgentTurnLoop } from "../adapters/freellm-browser/unified-engine.js";
import { classifyWork } from "../adapters/freellm-browser/work-kind.js";
import { inspectMediaBuffer, registerDeliverable, hasVerifiedDeliverable, saveRemoteMedia, listDeliverables } from "../adapters/freellm-browser/deliverables.js";

const roots: string[] = [];
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "freellm-protocol-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const agent = { id: "10000000-0000-4000-8000-000000000002", companyId: "20000000-0000-4000-8000-000000000002", name: "Designer", role: "designer", adapterConfig: { model: "gemini-default" } };
const envelope = (tool: string, args: Record<string, unknown>, id: string = crypto.randomUUID()) => JSON.stringify({ callId: id, tool, arguments: args });
const fence = (tool: string, args: Record<string, unknown>, id?: string, label = "tool_call") => "```" + label + "\n" + envelope(tool, args, id) + "\n```";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0); buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16); buf.writeUInt32BE(height, 20);
  return buf;
}
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(8 + payload.length, 0); header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function mp4(durationSec: number): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom", "binary"));
  const mvhd = Buffer.alloc(100); mvhd[0] = 0; mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(Math.round(durationSec * 1000), 16);
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd))]);
}

describe("FreeLLM reply protocol", () => {
  it("executes a real call even when the prose elsewhere says 'for example'", () => {
    const text = "سأبدأ، على سبيل المثال بقراءة الملفات المهمة.\n\nالخطوة الأولى:\n\n" + fence("list_dir", {});
    expect(classifyModelReply(text)).toMatchObject({ kind: "tool_call", call: { tool: "list_dir" } });
  });
  it("treats a fence introduced as an example as illustrative", () => {
    expect(classifyModelReply("Example only:\n" + fence("list_dir", {})).kind).toBe("answer");
  });
  it("accepts an uppercase JSON label produced by the site's code block", () => {
    expect(classifyModelReply(fence("list_dir", {}, undefined, "JSON")).call?.tool).toBe("list_dir");
  });
  it("runs only the first call and reports the rest as not executed", () => {
    const result = classifyModelReply(fence("list_dir", {}, "first") + "\n\n" + fence("read_file", { path: "a.txt" }, "second"));
    expect(result.call?.callId).toBe("first");
    expect(result.ignoredCallIds).toEqual(["second"]);
  });
  it("flags schema-invalid calls with specific reasons instead of executing them", () => {
    const result = classifyModelReply(fence("read_file", {}));
    expect(result.kind).toBe("invalid_tool_call");
    expect(result.issues.join(" ")).toMatch(/read_file: path/);
  });
  it("flags unknown tools", () => {
    expect(classifyModelReply(fence("format_disk", {})).issues.join(" ")).toMatch(/unknown tool/);
  });
  it("classifies declared questions, blockers and deliveries", () => {
    expect(classifyModelReply("Need the brand colors. [[STATUS: question: what are the brand colors?]]")).toMatchObject({ kind: "question", detail: "what are the brand colors?" });
    expect(classifyModelReply("[[STATUS: blocked: video generation unavailable]]")).toMatchObject({ kind: "blocker", detail: "video generation unavailable" });
    expect(classifyModelReply("All files verified. [[STATUS: delivered]]").kind).toBe("delivery");
    expect(classifyModelReply("Plain answer.").kind).toBe("answer");
  });
});

describe("FreeLLM work classification", () => {
  it("separates media products from software products", () => {
    expect(classifyWork("صمم شعارًا وهوية بصرية لمقهى")).toMatchObject({ primary: "image", requiredMedia: ["image"] });
    expect(classifyWork("أعد فيديو ترويجي مدته 15 ثانية")).toMatchObject({ primary: "video", requiredMedia: ["video"] });
    expect(classifyWork("ابني موقع للمطعم مع صور للأطباق")).toMatchObject({ primary: "code", requiredMedia: [] });
    expect(classifyWork("ما عاصمة فرنسا؟").primary).toBe("answer");
  });
});

describe("FreeLLM deliverable inspection", () => {
  it("reads real image dimensions and video duration from bytes", () => {
    expect(inspectMediaBuffer(png(1024, 768))).toMatchObject({ valid: true, format: "png", width: 1024, height: 768 });
    expect(inspectMediaBuffer(mp4(12.5))).toMatchObject({ valid: true, format: "mp4", durationSec: 12.5 });
    expect(inspectMediaBuffer(Buffer.from("this is only a description of an image")).valid).toBe(false);
  });
  it("rejects a truncated video without a moov box", () => {
    const ftypOnly = box("ftyp", Buffer.from("isom\0\0\0\0isom", "binary"));
    expect(inspectMediaBuffer(ftypOnly)).toMatchObject({ valid: false });
  });
  it("versions deliverables and invalidates evidence when the file changes", () => {
    const root = temp(), file = path.join(root, "logo.png");
    fs.writeFileSync(file, png(512, 512));
    expect(registerDeliverable(root, "logo.png", file, { expectedKind: "image" }).version).toBe(1);
    expect(registerDeliverable(root, "logo.png", file, { expectedKind: "image" }).version).toBe(2);
    expect(hasVerifiedDeliverable(root, "image")).toBe(true);
    fs.writeFileSync(file, png(256, 256));
    expect(hasVerifiedDeliverable(root, "image")).toBe(false);
  });
  it("fails a kind mismatch and minimum size", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "clip.mp4"), png(100, 100));
    const result = await executeToolOutcome({ callId: "c1", tool: "register_deliverable", arguments: { path: "clip.mp4", kind: "video" } }, root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/kind_matches/);
  });
  it("reports an authenticated media URL failure instead of hiding it", async () => {
    const root = temp();
    const denied = async () => new Response("denied", { status: 403 });
    const result = await saveRemoteMedia(root, "https://example.test/img", "deliverables/a.img", path.join(root, "deliverables/a.img"), { expectedKind: "image" }, denied as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(listDeliverables(root)).toHaveLength(0);
  });
  it("saves a downloaded image with its detected extension", async () => {
    const root = temp();
    const ok = async () => new Response(png(640, 480), { status: 200 });
    const result = await saveRemoteMedia(root, "https://example.test/img", "deliverables/a.img", path.join(root, "deliverables/a.img"), { expectedKind: "image" }, ok as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.entry?.relativePath).toBe("deliverables/a.png");
    expect(fs.existsSync(path.join(root, "deliverables/a.png"))).toBe(true);
  });
});

describe("FreeLLM engine with protocol and deliverables", () => {
  const run = (root: string, prompt: string, responses: string[], prompts: string[] = []) =>
    runAgentTurnLoop({ agentId: agent.id, agent, workspaceRoot: root, prompt, transport: async (params: any) => { prompts.push(params.prompt); return { status: "ok", text: responses.shift() ?? "" }; } });

  it("does not accept an image description as an image delivery", async () => {
    const description = "الشعار عبارة عن فنجان قهوة بني مع بخار متصاعد بخط عربي أنيق، والألوان بني وكريمي. [[STATUS: delivered]]";
    const result = await run(temp(), "صمم شعارًا لمقهى", [description, description]);
    expect(result.lastStatus).toBe("blocked");
    expect(result.errorMessage).toMatch(/صورة حقيقي/);
  });
  it("completes an image request only after a real file passes inspection", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "logo.png"), png(1024, 1024));
    const result = await run(root, "صمم شعارًا لمقهى", [fence("register_deliverable", { path: "logo.png", kind: "image", minWidth: 512 }), "تم إنتاج الشعار وفحصه. [[STATUS: delivered]]"]);
    expect(result.lastStatus).toBe("completed");
    expect(listDeliverables(root)[0]).toMatchObject({ kind: "image", verification: { status: "verified", humanOrVisualReview: "not_performed" } });
  });
  it("surfaces an explicit video capability blocker", async () => {
    const result = await run(temp(), "أعد فيديو ترويجي قصير", ["أعددت السيناريو والمشاهد، لكن [[STATUS: blocked: video generation unavailable on this account]]"]);
    expect(result.lastStatus).toBe("blocked");
    expect(result.errorMessage).toMatch(/video generation unavailable/);
  });
  it("pauses for operator input on a declared question", async () => {
    const result = await run(temp(), "Write a report", ["Which market? [[STATUS: question: which market should the report cover?]]"]);
    expect(result.lastStatus).toBe("waiting_input");
    expect(result.errorMessage).toMatch(/which market/);
  });
  it("corrects an invalid call with a specific message and stops after the limit", async () => {
    const prompts: string[] = [];
    const bad = fence("read_file", {});
    const result = await run(temp(), "Implement the task", [bad, bad, bad], prompts);
    expect(prompts[1]).toMatch(/PROTOCOL_ERROR attempt 1\/2/);
    expect(prompts[1]).toMatch(/read_file: path/);
    expect(result.lastStatus).toBe("blocked");
    expect(prompts).toHaveLength(3);
  });
  it("tells the model which extra calls were not executed", async () => {
    const root = temp(), prompts: string[] = [];
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    await run(root, "What is in this folder?", [fence("list_dir", {}, "one") + "\n" + fence("read_file", { path: "a.txt" }, "two"), "It contains a.txt."], prompts);
    expect(prompts[1]).toContain("[NOT_EXECUTED two]");
  });
});
