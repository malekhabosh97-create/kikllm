export type Blocker =
  | "captcha"
  | "login"
  | "login_blocked"
  | "rate_limit"
  | "quota_exhausted"
  | "provider_error"
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
  status: "ok" | "blocked" | "timeout" | "cancelled";
  text: string;
  stopped?:boolean;
  blocker?: Blocker;
  blockerDetails?: string;
  rawHtmlSnapshot?: string;
  screenshotPath?: string;
}

export interface ChatSession {
  readonly tabId?: string;
  isClosed(): boolean;
  url(): string;
  stop(): Promise<boolean>;
  setBusy?(busy:boolean):Promise<void>;
  waitUntilReady?(opts?:{signal?:AbortSignal;onBlocker?:(message:string|null)=>void}):Promise<void>;
  send(text: string): Promise<void>;
  attach(files: string[]): Promise<void>;
  waitForReply(opts?: {
    timeoutMs?: number;
    onChunk?: (text: string) => void;
    onSnapshot?: (text: string) => void;
    onBlocker?: (message:string|null)=>void;
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

export interface LiveModelInfo {
  id: string;
  label: string;
  description?: string;
  locked: boolean;
  rawText?: string;
}

export interface SiteAdapter {
  readonly id: string;
  health(): Promise<SiteHealth>;
  listModels(): Promise<LiveModelInfo[]>;
  newChat(modelId?: string): Promise<ChatSession>;
  resumeChat(url: string, modelId?: string): Promise<ChatSession>;
  shutdown(): Promise<void>;
}
