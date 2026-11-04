import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type DeliverableKind = "image" | "video" | "audio" | "document" | "code" | "other";

export interface MediaInspection {
  valid: boolean;
  format?: string;
  mime?: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  error?: string;
}

export interface DeliverableEntry {
  id: string;
  kind: DeliverableKind;
  relativePath: string;
  source: { type: "file" | "remote_url"; url?: string };
  taskId?: string;
  agentId?: string;
  version: number;
  sha256: string;
  description?: string;
  inspection: MediaInspection;
  verification: {
    status: "verified" | "failed";
    checks: Array<{ name: string; passed: boolean; detail?: string }>;
    /** Automated byte-level checks only. Visual/aural review is never claimed here. */
    humanOrVisualReview: "not_performed";
  };
  createdAt: string;
}

interface Manifest { schemaVersion: 1; entries: DeliverableEntry[]; }

export const MANIFEST_PATH = ".freellm/deliverables.json";

function readUInt24LE(buf: Buffer, offset: number) { return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16); }

function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: readUInt24LE(buf, 24) + 1, height: readUInt24LE(buf, 27) + 1 };
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Walks ISO-BMFF boxes to find moov/mvhd and read the duration. */
function mp4Duration(buf: Buffer): number | undefined {
  const walk = (start: number, end: number): number | undefined => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buf.readUInt32BE(offset);
      const type = buf.toString("ascii", offset + 4, offset + 8);
      let header = 8;
      if (size === 1 && offset + 16 <= end) { size = Number(buf.readBigUInt64BE(offset + 8)); header = 16; }
      else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return undefined;
      if (type === "moov") return walk(offset + header, offset + size);
      if (type === "mvhd") {
        const version = buf[offset + header];
        const base = offset + header + 4;
        if (version === 1) {
          const timescale = buf.readUInt32BE(base + 16);
          const duration = Number(buf.readBigUInt64BE(base + 20));
          return timescale ? duration / timescale : undefined;
        }
        const timescale = buf.readUInt32BE(base + 8);
        const duration = buf.readUInt32BE(base + 12);
        return timescale ? duration / timescale : undefined;
      }
      offset += size;
    }
    return undefined;
  };
  return walk(0, buf.length);
}

export function inspectMediaBuffer(buf: Buffer): MediaInspection {
  const bytes = buf.length;
  if (bytes < 12) return { valid: false, bytes, error: "الملف أصغر من أن يكون وسائط صالحة" };
  const ascii = (start: number, end: number) => buf.toString("ascii", start, end);
  try {
    if (buf.readUInt32BE(0) === 0x89504e47 && bytes >= 24) {
      return { valid: true, format: "png", mime: "image/png", bytes, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const size = jpegSize(buf);
      return size ? { valid: true, format: "jpeg", mime: "image/jpeg", bytes, ...size } : { valid: false, format: "jpeg", bytes, error: "ترويسة JPEG بلا أبعاد" };
    }
    if (ascii(0, 4) === "GIF8") return { valid: true, format: "gif", mime: "image/gif", bytes, width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
      const size = webpSize(buf);
      return size ? { valid: true, format: "webp", mime: "image/webp", bytes, ...size } : { valid: false, format: "webp", bytes, error: "ترويسة WEBP غير مفهومة" };
    }
    if (ascii(4, 8) === "ftyp") {
      const brand = ascii(8, 12);
      const durationSec = mp4Duration(buf);
      const mime = brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
      if (durationSec === undefined) return { valid: false, format: "mp4", mime, bytes, error: "لا يوجد moov/mvhd؛ الملف غير مكتمل أو تالف" };
      return { valid: durationSec > 0, format: "mp4", mime, bytes, durationSec, error: durationSec > 0 ? undefined : "مدة الفيديو صفر" };
    }
    if (buf.readUInt32BE(0) === 0x1a45dfa3) return { valid: true, format: "webm", mime: "video/webm", bytes };
    const head = ascii(0, Math.min(bytes, 256)).trimStart();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { valid: true, format: "svg", mime: "image/svg+xml", bytes };
  } catch (error) {
    return { valid: false, bytes, error: "تعذرت قراءة الترويسة: " + (error as Error).message };
  }
  return { valid: false, bytes, error: "صيغة غير معروفة" };
}

function kindOf(inspection: MediaInspection): DeliverableKind {
  if (inspection.mime?.startsWith("image/")) return "image";
  if (inspection.mime?.startsWith("video/")) return "video";
  return "other";
}

function loadManifest(root: string): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { schemaVersion: 1, entries: [] };
}

function saveManifest(root: string, manifest: Manifest) {
  const file = path.join(root, MANIFEST_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2));
  fs.renameSync(temp, file);
}

export function listDeliverables(root: string, filter?: { taskId?: string }): DeliverableEntry[] {
  return loadManifest(root).entries.filter(entry => !filter?.taskId || entry.taskId === filter.taskId);
}

export interface RegisterOptions {
  expectedKind?: DeliverableKind;
  description?: string;
  taskId?: string;
  agentId?: string;
  source?: DeliverableEntry["source"];
  minWidth?: number;
  minHeight?: number;
  minDurationSec?: number;
}

/** Inspects a file that already exists inside the workspace and records a new manifest version. */
export function registerDeliverable(root: string, relativePath: string, absolutePath: string, options: RegisterOptions = {}): DeliverableEntry {
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error("المسار ليس ملفًا");
  const buf = fs.readFileSync(absolutePath);
  const inspection = inspectMediaBuffer(buf);
  const detected = kindOf(inspection);
  const kind = options.expectedKind ?? detected;
  const checks: DeliverableEntry["verification"]["checks"] = [
    { name: "file_exists", passed: stat.size > 0, detail: stat.size + " bytes" },
  ];
  if (kind === "image" || kind === "video") {
    checks.push({ name: "decodable_header", passed: inspection.valid, detail: inspection.error || inspection.format });
    checks.push({ name: "kind_matches", passed: detected === kind, detail: "detected " + detected });
  }
  if (options.minWidth) checks.push({ name: "min_width", passed: (inspection.width ?? 0) >= options.minWidth, detail: String(inspection.width) });
  if (options.minHeight) checks.push({ name: "min_height", passed: (inspection.height ?? 0) >= options.minHeight, detail: String(inspection.height) });
  if (options.minDurationSec) checks.push({ name: "min_duration", passed: (inspection.durationSec ?? 0) >= options.minDurationSec, detail: String(inspection.durationSec) });

  const manifest = loadManifest(root);
  const normalized = relativePath.replace(/\\/g, "/");
  const version = manifest.entries.filter(entry => entry.relativePath === normalized).length + 1;
  const entry: DeliverableEntry = {
    id: crypto.randomUUID(), kind, relativePath: normalized,
    source: options.source ?? { type: "file" }, taskId: options.taskId, agentId: options.agentId, version,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"), description: options.description, inspection,
    verification: { status: checks.every(check => check.passed) ? "verified" : "failed", checks, humanOrVisualReview: "not_performed" },
    createdAt: new Date().toISOString(),
  };
  manifest.entries.push(entry);
  saveManifest(root, manifest);
  return entry;
}

export interface RemoteMediaResult { ok: boolean; entry?: DeliverableEntry; url: string; error?: string; }

const MAX_REMOTE_BYTES = 200 * 1024 * 1024;

/**
 * Downloads a public media URL into the workspace. Many chat sites serve generated media behind
 * their session cookies; a plain fetch then fails, and the failure is returned rather than hidden.
 */
export async function saveRemoteMedia(root: string, url: string, relativePath: string, absolutePath: string, options: RegisterOptions = {}, fetchImpl: typeof fetch = fetch): Promise<RemoteMediaResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: "يُقبل http(s) فقط" };
  let response: Response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: "follow" }); }
  catch (error) { return { ok: false, url, error: "تعذر التنزيل: " + (error as Error).message }; }
  if (!response.ok) return { ok: false, url, error: "HTTP " + response.status + (response.status === 401 || response.status === 403 ? " (يحتاج غالبًا جلسة الموقع؛ نزّل الملف من تبويب المتصفح)" : "") };
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_REMOTE_BYTES) return { ok: false, url, error: "الملف أكبر من الحد المسموح" };
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_REMOTE_BYTES) return { ok: false, url, error: "الملف أكبر من الحد المسموح" };
  const format = inspectMediaBuffer(buf).format;
  if (format && relativePath.endsWith(".img")) {
    const ext = "." + (format === "jpeg" ? "jpg" : format);
    relativePath = relativePath.slice(0, -4) + ext;
    absolutePath = absolutePath.slice(0, -4) + ext;
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buf);
  const entry = registerDeliverable(root, relativePath, absolutePath, { ...options, source: { type: "remote_url", url } });
  return { ok: entry.verification.status === "verified", entry, url, error: entry.verification.status === "verified" ? undefined : "الملف المنزل لم يجتز الفحص" };
}

export function hasVerifiedDeliverable(root: string, kind: DeliverableKind, sinceIso?: string, taskId?: string): boolean {
  return listDeliverables(root).some(entry =>
    entry.kind === kind && entry.verification.status === "verified" &&
    (!taskId || !entry.taskId || entry.taskId === taskId) &&
    (!sinceIso || entry.createdAt >= sinceIso) &&
    fileStillMatches(root, entry));
}

/** A manifest entry is only evidence while the file it describes is unchanged. */
function fileStillMatches(root: string, entry: DeliverableEntry): boolean {
  try {
    const buf = fs.readFileSync(path.join(root, entry.relativePath));
    return crypto.createHash("sha256").update(buf).digest("hex") === entry.sha256;
  } catch { return false; }
}
