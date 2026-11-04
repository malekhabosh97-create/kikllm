// These IDs identify website modes; they do not assert a particular model version.
export const freellmModels = [
  {id:"gemini-default",label:"Gemini — current account mode"},
  {id:"deepseek-chat",label:"DeepSeek — standard mode"},
  {id:"deepseek-reasoner",label:"DeepSeek — thinking mode (when available)"},
  ...["chatgpt","claude","qwen","grok","glm","arena"].map(id=>({id:id+"-default",label:id+" — current account mode"})),
];
export async function listModels(){return freellmModels;}
