export type WorkKind = "code" | "image" | "video" | "research" | "document" | "answer";

export interface WorkProfile {
  kinds: WorkKind[];
  primary: WorkKind;
  /** Deliverable kinds that must exist as verified files before the run may be marked complete. */
  requiredMedia: Array<"image" | "video">;
}

const PATTERNS: Array<[Exclude<WorkKind, "answer">, RegExp]> = [
  ["video", /(?:فيديو|فديو|مقطع\s+(?:مرئي|ترويجي|قصير)|موشن|انيميشن|أنيميشن|\bvideo\b|\bclip\b|\banimation\b|\bmp4\b|\breel\b)/i],
  ["image", /(?:صور(?:ة|ه)?|شعار|لوجو|هوية\s+بصرية|تصميم\s+(?:بصري|إعلان|اعلان|بوستر|غلاف)|بوستر|ملصق|رسمة|رسم\s|أيقونة|ايقونة|\bimage\b|\bimages\b|\blogo\b|\bposter\b|\billustration\b|\bbanner\b|\bicon\b|\bpng\b|\bjpe?g\b)/i],
  ["code", /(?:تطبيق|موقع|برنامج|كود|برمجة|واجهة\s+برمجية|سكربت|اختبارات|خادم|قاعدة\s+بيانات|\bapp\b|\bwebsite\b|\bapi\b|\bcode\b|\bscript\b|\bbug\b|\brefactor\b|\bfrontend\b|\bbackend\b|\bcomponent\b)/i],
  ["research", /(?:بحث|دراسة|تحليل\s+(?:سوق|منافسين)|مصادر|قارن|مقارنة|\bresearch\b|\bmarket\s+analysis\b|\bcompare\b|\bsources\b|\bsurvey\b)/i],
  ["document", /(?:تقرير|مستند|مقال|خطة\s+تسويق|محتوى|نص\s+إعلاني|عرض\s+تقديمي|\breport\b|\bdocument\b|\barticle\b|\bcopy\b|\bpdf\b|\bdocx\b|\bslides?\b)/i],
];

export function classifyWork(prompt: string): WorkProfile {
  const text = prompt || "";
  const kinds = PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind) as WorkKind[];
  const primary = kinds.includes("code") ? "code" : kinds[0] ?? "answer";
  // In mixed software work, media is an input to the product; only enforce media files when media is the product.
  const requiredMedia = kinds.includes("code") ? [] : kinds.filter((kind): kind is "image" | "video" => kind === "image" || kind === "video");
  return { kinds: kinds.length ? kinds : ["answer"], primary, requiredMedia };
}

export function workInstructions(profile: WorkProfile): string {
  if (profile.primary === "answer") return "";
  const lines = ["WORK TYPE: " + profile.kinds.join(", ") + ". Choose the production path for this type; do not turn non-code work into code files."];
  if (profile.requiredMedia.includes("image")) lines.push(
    "IMAGE DELIVERY: a description is not an image. Produce an actual image (use the site's image generation if available). " +
    "If the image appears in this chat, the platform captures it; then call save_media_from_url with its URL, or register_deliverable for a file you created. " +
    "If image generation is unavailable on this account, end with [[STATUS: blocked: image generation unavailable]].");
  if (profile.requiredMedia.includes("video")) lines.push(
    "VIDEO DELIVERY: a script, storyboard or thumbnail is not a video. Only a real playable file counts. " +
    "If you can produce one (site video generation, or assembling frames with an available local tool such as ffmpeg via run_command), register it with register_deliverable. " +
    "Otherwise end with [[STATUS: blocked: video generation unavailable]] and list what you prepared.");
  if (profile.kinds.includes("research")) lines.push("RESEARCH DELIVERY: use web_search/fetch_url, cite only retrieved URLs, and pass them to verify_task sources.");
  return lines.join("\n");
}
