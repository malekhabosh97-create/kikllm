export const freellmModels = [
  { id: "deepseek-normal", label: "DeepSeek (Normal Mode)" },
  { id: "deepseek-deepthink", label: "DeepSeek (DeepThink / Thinking Mode)" },
  { id: "gemini-default", label: "Google Gemini (Default Active Mode)" },
  { id: "gemini-pro", label: "Google Gemini (3.1 Pro - Advanced Reasoning)" },
  { id: "gemini-flash", label: "Google Gemini (3.8 Flash - All-around Help)" },
  { id: "gemini-flash-lite", label: "Google Gemini (3.5 Flash-Lite - Fastest Answers)" },
  { id: "gemini-argon", label: "Google Gemini (4 Argon - Complex Tasks)" },
];

export async function listModels(): Promise<Array<{ id: string; label: string }>> {
  return freellmModels;
}
