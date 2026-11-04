import type {ReplyResult} from "./types.js";

/** A response can establish connectivity without obeying exact formatting. */
export function classifyProviderProbe(reply:ReplyResult,nonce:string) {
  const exactInstruction=reply.status==="ok"&&reply.text.trim()===nonce;
  const passed=reply.status==="ok"&&reply.text.includes(nonce);
  return {passed,exactInstruction,error:passed?undefined:reply.blockerDetails||(reply.status==="ok"?"لم تُرجع المنصة الرد المطلوب":reply.status)};
}
