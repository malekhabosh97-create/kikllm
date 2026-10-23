export type Blocker =
  | "captcha"
  | "login"
  | "login_blocked"
  | "rate_limit"
  | "quota_exhausted"
  | "model_unavailable"
  | "browser_disconnected"
  | "unknown";

export interface BlockerRule {
  type: Blocker;
  selector?: string;
  textPattern?: string;
  urlPattern?: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  url: string;
  newChatUrl?: string;
  loginIndicators: string[];
  chatInput: string[];
  sendButton: string[];
  stopButton: string[];
  lastMessage: string[];
  messageText: string[];
  attachButton: string[];
  fileInput: string[];
  modelMenu?: string[];
  modelOptions?: Record<string, { label: string; selector?: string }>;
  blockers: BlockerRule[];
  completion: {
    stabilityMs: number;
    pollIntervalMs: number;
    maxTimeoutMs: number;
  };
}

export interface ReplyResult {
  status: "ok" | "blocked" | "timeout";
  text: string;
  blocker?: Blocker;
  blockerDetails?: string;
  rawHtmlSnapshot?: string;
  screenshotPath?: string;
}

export interface ChatSession {
  send(text: string): Promise<void>;
  attach(files: string[]): Promise<void>;
  waitForReply(opts?: {
    timeoutMs?: number;
    onChunk?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<ReplyResult>;
  close(): Promise<void>;
}

export interface SiteHealth {
  ok: boolean;
  reason?: string;
  currentUrl?: string;
  isLoggedIn?: boolean;
}

export interface SiteAdapter {
  readonly id: string;
  health(): Promise<SiteHealth>;
  listModels(): Promise<string[]>;
  newChat(modelId?: string): Promise<ChatSession>;
  shutdown(): Promise<void>;
}
