import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/context/CompanyContext";
import {
  Send,
  Square,
  Sparkles,
  Bot,
  User,
  PlusCircle,
  Trash2,
  ExternalLink,
  Crown,
  CheckCircle2,
  Copy,
  Check,
  AlertCircle,
  RefreshCw,
  Layers,
  Zap,
  FolderGit2,
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  role: string;
  title?: string;
  adapterConfig?: { model?: string };
  avatarUrl?: string;
}

interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: string;
  actionProposal?: {
    action: "create_agent";
    name: string;
    role: string;
    title?: string;
    model?: string;
    systemPrompt?: string;
  } | null;
  createdAgentId?: string;
}

export function DirectChatPage() {
  const { selectedCompanyId } = useCompany();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [browserStatus, setBrowserStatus] = useState<any>({ deepseek: "CHECKING", gemini: "CHECKING" });
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("C:\\Users\\malek\\Documents\\freellm work");

  // New agent form state
  const [newAgentForm, setNewAgentForm] = useState({
    name: "",
    role: "engineer",
    title: "",
    model: "gemini-argon",
    systemPrompt: "",
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 1. Fetch Agents List
  const fetchAgents = async () => {
    if (!selectedCompanyId) return;
    try {
      const res = await fetch(`/api/companies/${selectedCompanyId}/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
        if (!selectedAgentId && data.length > 0) {
          // Default to CEO agent if available, otherwise first agent
          const ceo = data.find((a: Agent) => a.role === "ceo" || a.name.includes("CEO"));
          setSelectedAgentId(ceo ? ceo.id : data[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to fetch agents", e);
    }
  };

  // 2. Fetch Browser Status
  const fetchBrowserStatus = async () => {
    try {
      const res = await fetch("/api/browser/status");
      if (res.ok) {
        const data = await res.json();
        setBrowserStatus(data);
      }
    } catch {
      setBrowserStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED" });
    }
  };

  useEffect(() => {
    fetchAgents();
    fetchBrowserStatus();
    const timer = setInterval(fetchBrowserStatus, 5000);
    return () => clearInterval(timer);
  }, [selectedCompanyId]);

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // 3. Load Chat History from Paperclip Central Database when agent changes
  useEffect(() => {
    if (!selectedAgentId) {
      setMessages([]);
      return;
    }
    let isCancelled = false;
    setIsLoadingHistory(true);
    fetch(`/api/browser/agent-chat/history?agentId=${selectedAgentId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load history");
        return res.json();
      })
      .then((data) => {
        if (!isCancelled && Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
      })
      .catch((err) => {
        console.error("Failed to load agent chat history:", err);
      })
      .finally(() => {
        if (!isCancelled) setIsLoadingHistory(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [selectedAgentId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const activeModel = selectedAgent?.adapterConfig?.model || "gemini-argon";
  const activePlatform = activeModel.startsWith("gemini") ? "gemini" : "deepseek";
  const isPlatformReady =
    activePlatform === "gemini" ? browserStatus.gemini === "READY" : browserStatus.deepseek === "READY";

  // Parse Action proposal from text
  const parseActionProposal = (text: string) => {
    try {
      const match = text.match(/```(?:json)?\s*(\{[\s\S]*?"action"\s*:\s*"create_agent"[\s\S]*?\})\s*```/);
      let parsed = match && match[1] ? JSON.parse(match[1]) : null;
      if (!parsed) {
        const rawMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"create_agent"[\s\S]*?\}/);
        if (rawMatch) parsed = JSON.parse(rawMatch[0]);
      }
      if (parsed) {
        if (parsed.agent) {
          return {
            action: "create_agent",
            name: parsed.agent.name || "Specialist Agent",
            role: parsed.agent.role || "engineer",
            title: parsed.agent.role || parsed.agent.name,
            model: parsed.agent.model || "gemini-argon",
            systemPrompt: parsed.agent.system_prompt || parsed.agent.description || "",
          };
        }
        return parsed;
      }
    } catch {
      // ignore parse errors
    }
    return null;
  };

  // 4. Send Message (Verbatim Transmission)
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend !== undefined ? textToSend : inputPrompt).trim();
    if (!text || isStreaming || !selectedAgentId) return;

    setInputPrompt("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const userMessage: ChatMessage = {
      id: "usr_" + Date.now(),
      sender: "user",
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const agentMessageId = "agt_" + Date.now();
    const placeholderAgentMessage: ChatMessage = {
      id: agentMessageId,
      sender: "agent",
      text: "",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMessage, placeholderAgentMessage]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/browser/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          prompt: text, // Sent verbatim
          workspaceRoot,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل الاتصال بالخادم" }));
        throw new Error(err.error || `Error ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("لا يمكن قراءة البث (No stream reader)");

      const decoder = new TextDecoder();
      let accumulatedText = "";

      let sseBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              if (data.type === "token" && data.text) {
                accumulatedText += data.text;
              } else if (data.type === "replace" && data.text) {
                accumulatedText = data.text;
              } else if (data.type === "content" && data.content) {
                accumulatedText += data.content;
              } else if (data.type === "tool_call") {
                accumulatedText += `\n\n> ⚡ **[أمر تنفيذي للأداة: \`${data.tool}\`]**\n`;
              } else if (data.type === "tool_result") {
                const preview = data.result ? data.result.slice(0, 300) : "";
                accumulatedText += `> 📋 **[نتيجة الأداة: \`${data.tool}\`]**\n\`\`\`text\n${preview}${data.result && data.result.length > 300 ? "\n..." : ""}\n\`\`\`\n\n`;
              } else if (data.type === "error") {
                accumulatedText += `\n\n> [!WARNING]\n> ${data.message || "حدث خطأ أثناء التوليد"}`;
              }
            } catch {
              // ignore parse errors for partial chunks
            }
          }
        }

        // Update the agent message live
        const proposal = parseActionProposal(accumulatedText);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMessageId ? { ...msg, text: accumulatedText, actionProposal: proposal } : msg
          )
        );
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  text:
                    msg.text ||
                    `⚠️ تعذر استلام الرد: ${err.message}.\nيرجى التأكد من أن المتصفح يعمل وأن التبويب مسجل الدخول إليه.`,
                }
              : msg
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  const handleClearHistory = async () => {
    if (confirm("هل أنت متأكد من مسح سجل المحادثة مع هذا الإيجنت؟")) {
      setMessages([]);
      if (selectedAgentId) {
        await fetch(`/api/browser/agent-chat/history?agentId=${selectedAgentId}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    }
  };

  // 5. Execute Agent Creation from CEO Action Proposal
  const handleExecuteAgentCreation = async (
    msgId: string,
    proposal: {
      action: "create_agent";
      name: string;
      role: string;
      title?: string;
      model?: string;
      systemPrompt?: string;
    }
  ) => {
    setIsCreatingAgent(true);
    try {
      const res = await fetch("/api/browser/create-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: proposal.name,
          role: proposal.role || "engineer",
          title: proposal.title || proposal.name,
          model: proposal.model || "gemini-argon",
          systemPrompt: proposal.systemPrompt || "",
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل إنشاء الإيجنت" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const created = await res.json();
      await fetchAgents();

      // Mark this proposal as created
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, createdAgentId: created.id } : m))
      );

      alert(`تم إنشاء الإيجنت "${created.name}" بنجاح في النظام! 🎉`);
    } catch (e: any) {
      alert("حدث خطأ أثناء إنشاء الإيجنت: " + e.message);
    } finally {
      setIsCreatingAgent(false);
    }
  };

  // 6. Manual Agent Creation Modal Submit
  const handleManualCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentForm.name.trim()) return;

    setIsCreatingAgent(true);
    try {
      const res = await fetch("/api/browser/create-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newAgentForm.name,
          role: newAgentForm.role,
          title: newAgentForm.title || `${newAgentForm.name} (${newAgentForm.role.toUpperCase()})`,
          model: newAgentForm.model,
          systemPrompt: newAgentForm.systemPrompt,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل إنشاء الإيجنت" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const created = await res.json();
      await fetchAgents();
      setSelectedAgentId(created.id);
      setShowCreateModal(false);
      setNewAgentForm({ name: "", role: "engineer", title: "", model: "gemini-argon", systemPrompt: "" });
      alert(`تم إنشاء الإيجنت "${created.name}" بنجاح! تم نقلك للمحادثة معه.`);
    } catch (e: any) {
      alert("فشل إنشاء الإيجنت: " + e.message);
    } finally {
      setIsCreatingAgent(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleBringBrowserToFront = async () => {
    try {
      await fetch("/api/browser/tab/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: activePlatform }),
      });
    } catch (e: any) {
      alert("تعذر فتح التبويب: " + e.message);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-6xl mx-auto p-4 gap-4">
      {/* Top Header & Agent Picker */}
      <header className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold text-lg shadow-inner">
              {selectedAgent?.role === "ceo" ? <Crown className="w-6 h-6 text-amber-400" /> : <Bot className="w-6 h-6" />}
            </div>
            <span
              className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-card ${
                isPlatformReady ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
              }`}
            />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <label htmlFor="agent-select" className="text-xs text-muted-foreground font-semibold">
                الإيجنت المتحدث:
              </label>
              <select
                id="agent-select"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="bg-background border border-border text-foreground font-semibold text-sm rounded-md px-2.5 py-1 focus:outline-hidden focus:ring-1 focus:ring-primary cursor-pointer"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role.toUpperCase()}) - {a.adapterConfig?.model || "FreeLLM"}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">{selectedAgent?.title || "AI Agent"}</span>
              <Badge variant="outline" className="text-[11px] py-0 px-1.5 border-primary/30 text-primary">
                {activeModel}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[11px] py-0 px-1.5 ${
                  isPlatformReady
                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                    : "border-amber-500/40 text-amber-400 bg-amber-500/10"
                }`}
              >
                {isPlatformReady ? "متصل بالمتصفح الحي" : "غير متصل / يحتاج فحص"}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border/80 bg-background/50 text-xs">
            <FolderGit2 className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-[11px] font-medium text-muted-foreground shrink-0">مجلد المشروع:</span>
            <input
              type="text"
              value={workspaceRoot}
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              className="bg-transparent border-0 text-foreground font-mono text-[11px] focus:outline-none w-56 md:w-64"
              placeholder="C:\path\to\project"
              title="المسار الذي ستعمل عليه أدوات الإيجنت (read_file, list_dir, run_command, verify_task)"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleBringBrowserToFront}
            className="text-xs gap-1.5 border-border hover:bg-muted"
            title="إظهار صفحة الموديل الحية في المتصفح"
          >
            <ExternalLink className="w-3.5 h-3.5 text-primary" />
            <span>عرض التبويب</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateModal(true)}
            className="text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>+ إضافة إيجنت</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearHistory}
            className="text-xs text-muted-foreground hover:text-destructive"
            title="مسح سجل المحادثة الحالي"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </header>

      {/* Main Chat Thread */}
      <main className="flex-1 overflow-y-auto rounded-xl border border-border bg-card/50 p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4 max-w-lg mx-auto">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-sm">
              {selectedAgent?.role === "ceo" ? <Crown className="w-8 h-8 text-amber-400" /> : <Bot className="w-8 h-8" />}
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">
                محادثة مباشرة مع {selectedAgent?.name || "الإيجنت"}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedAgent?.role === "ceo"
                  ? "أنا المدير التنفيذي (CEO) لشركة FreeLLM Work بموديل Gemini 4 Argon. مهمتي قيادة الشركة، فحص المشاريع، صناعة الإيجنتات، وتنسيق وتنفيذ واختبار المهام بأدوات حقيقية."
                  : "أنا جاهز لمساعدتك وتنفيذ طلباتك مباشرة عبر المتصفح وبشكل حرفي متدفق مع تشغيل الأدوات."}
              </p>
            </div>

            {selectedAgent?.role === "ceo" && (
              <div className="w-full flex flex-col gap-2 pt-2">
                <span className="text-xs text-muted-foreground font-medium text-right">أوامر قيادية وتنفيذية مقترحة:</span>
                <button
                  onClick={() => handleSendMessage("افحص المشروع في مسار العمل، واقترح خطة مناسبة، ووزّع العمل على فريق الإيجنتات، ونفّذ واختبر النتيجة بأدلة حقيقية.")}
                  className="text-xs text-right p-2.5 rounded-lg border border-primary/40 bg-primary/10 hover:bg-primary/20 transition-colors text-foreground flex items-center justify-between font-medium"
                >
                  <span>🎯 افحص المشروع، واقترح خطة، ووزّع العمل، ونفّذ واختبر النتيجة</span>
                  <Zap className="w-3.5 h-3.5 text-primary" />
                </button>
                <button
                  onClick={() => handleSendMessage("افحص الملفات في مجلد المشروع عبر get_project_context واعرض لي تقريراً معمارياً موجزاً")}
                  className="text-xs text-right p-2.5 rounded-lg border border-border/80 bg-background/50 hover:bg-primary/10 hover:border-primary/40 transition-colors text-foreground flex items-center justify-between"
                >
                  <span>🔍 افحص الملفات واعرض تقريراً معمارياً موجزاً عن المشروع</span>
                  <Zap className="w-3.5 h-3.5 text-primary" />
                </button>
                <button
                  onClick={() => handleSendMessage("اصنع لي إيجنت مطور برمجيات كامل (Fullstack Engineer) بموديل ديب سيك")}
                  className="text-xs text-right p-2.5 rounded-lg border border-border/80 bg-background/50 hover:bg-primary/10 hover:border-primary/40 transition-colors text-foreground flex items-center justify-between"
                >
                  <span>🚀 اصنع لي إيجنت مطور برمجيات كامل (Fullstack) بموديل ديب سيك</span>
                  <Zap className="w-3.5 h-3.5 text-primary" />
                </button>
              </div>
            )}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 max-w-4xl ${msg.sender === "user" ? "ml-auto flex-row-reverse" : "mr-auto"}`}
            >
              <div
                className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold ${
                  msg.sender === "user"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-muted border border-border text-foreground"
                }`}
              >
                {msg.sender === "user" ? (
                  <User className="w-4 h-4" />
                ) : selectedAgent?.role === "ceo" ? (
                  <Crown className="w-4 h-4 text-amber-400" />
                ) : (
                  <Bot className="w-4 h-4 text-primary" />
                )}
              </div>

              <div
                className={`flex flex-col gap-1.5 ${
                  msg.sender === "user" ? "items-end max-w-[85%]" : "items-start max-w-[90%]"
                }`}
              >
                <div className="flex items-center gap-2 px-1">
                  <span className="text-xs font-semibold text-foreground/80">
                    {msg.sender === "user" ? "أنت" : selectedAgent?.name || "الوكيل"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{msg.timestamp}</span>
                </div>

                <div
                  className={`rounded-2xl p-4 text-sm leading-relaxed shadow-xs relative group ${
                    msg.sender === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-xs"
                      : "bg-card border border-border text-card-foreground rounded-tl-xs"
                  }`}
                >
                  {msg.sender === "agent" && (
                    <button
                      onClick={() => copyToClipboard(msg.text, msg.id)}
                      className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 p-1.5 rounded-md bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
                      title="نسخ النص"
                    >
                      {copiedId === msg.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  )}

                  <div className="markdown-body prose dark:prose-invert max-w-none text-sm break-words">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text || "..."}</ReactMarkdown>
                  </div>

                  {/* Executive Action Card (if CEO proposes creating an agent) */}
                  {msg.actionProposal && msg.actionProposal.action === "create_agent" && (
                    <div className="mt-4 p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-amber-400 font-semibold text-xs">
                          <Zap className="w-4 h-4" />
                          <span>اقتراح تنفيذي لإنشاء إيجنت جديد</span>
                        </div>
                        <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">
                          {msg.actionProposal.model || "gemini-argon"}
                        </Badge>
                      </div>

                      <div className="text-xs space-y-1 text-foreground/90 bg-background/60 p-2.5 rounded-lg border border-border">
                        <div>
                          <strong>الاسم:</strong> {msg.actionProposal.name}
                        </div>
                        <div>
                          <strong>الدور:</strong> {msg.actionProposal.role} ({msg.actionProposal.title || "محدد"})
                        </div>
                        {msg.actionProposal.systemPrompt && (
                          <div className="text-[11px] text-muted-foreground line-clamp-2">
                            <strong>التعليمات:</strong> {msg.actionProposal.systemPrompt}
                          </div>
                        )}
                      </div>

                      {msg.createdAgentId ? (
                        <div className="flex items-center justify-between text-xs text-emerald-400 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/30">
                          <span className="flex items-center gap-1.5 font-medium">
                            <CheckCircle2 className="w-4 h-4" />
                            تم إنشاء هذا الإيجنت بنجاح في النظام!
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-emerald-500/40 text-emerald-400"
                            onClick={() => setSelectedAgentId(msg.createdAgentId!)}
                          >
                            التبديل إليه الآن
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          disabled={isCreatingAgent}
                          onClick={() => handleExecuteAgentCreation(msg.id, msg.actionProposal!)}
                          className="w-full bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold gap-1.5 shadow-sm"
                        >
                          <PlusCircle className="w-4 h-4" />
                          {isCreatingAgent ? "جاري إنشاء الإيجنت..." : "اعتماد وإنشاء الإيجنت الآن"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Input Bar */}
      <footer className="relative flex flex-col gap-2 p-2 rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputPrompt}
            onChange={(e) => {
              setInputPrompt(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder={`اكتب رسالتك إلى ${selectedAgent?.name || "الوكيل"} هنا... (Shift+Enter لسطر جديد)`}
            className="flex-1 bg-transparent border-0 resize-none p-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden max-h-44 min-h-[44px]"
          />

          {isStreaming ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleStopStreaming}
              className="h-10 px-3.5 gap-1.5 font-medium shrink-0"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>إيقاف</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!inputPrompt.trim() || !selectedAgentId}
              onClick={() => handleSendMessage()}
              className="h-10 px-4 gap-1.5 font-semibold shrink-0 shadow-xs"
            >
              <span>إرسال</span>
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between px-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            يتم نقل النص حرفياً للمتصفح الحي واستلام الرد المتدفق عبر محرك FreeLLM
          </span>
          <span>{inputPrompt.length} حرف</span>
        </div>
      </footer>

      {/* Create Agent Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-md p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-primary" />
                <span>إضافة إيجنت جديد للشركة</span>
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleManualCreateAgent} className="space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-foreground">اسم الإيجنت *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: Senior Python Developer"
                  value={newAgentForm.name}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, name: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-foreground">الدور (Role)</label>
                  <select
                    value={newAgentForm.role}
                    onChange={(e) => setNewAgentForm({ ...newAgentForm, role: e.target.value })}
                    className="w-full mt-1 bg-background border border-border rounded-lg px-2.5 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                  >
                    <option value="engineer">مهندس (Engineer)</option>
                    <option value="cto">CTO</option>
                    <option value="cmo">CMO</option>
                    <option value="cfo">CFO</option>
                    <option value="general">عام (General)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-foreground">الموديل المخصص</label>
                  <select
                    value={newAgentForm.model}
                    onChange={(e) => setNewAgentForm({ ...newAgentForm, model: e.target.value })}
                    className="w-full mt-1 bg-background border border-border rounded-lg px-2.5 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                  >
                    <option value="gemini-argon">Gemini 4 Argon</option>
                    <option value="gemini-pro">Gemini 3.1 Pro</option>
                    <option value="gemini-flash">Gemini 3.8 Flash</option>
                    <option value="deepseek-normal">DeepSeek V3 (Normal)</option>
                    <option value="deepseek-thinking">DeepSeek R1 (Thinking)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">المسمى الوظيفي (Title)</label>
                <input
                  type="text"
                  placeholder="مثال: مطور الذكاء الاصطناعي والتطبيقات"
                  value={newAgentForm.title}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, title: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">التعليمات والتوجيهات (System Prompt)</label>
                <textarea
                  rows={3}
                  placeholder="حدد دور الإيجنت واختصاصه وكيف ينجز المهام..."
                  value={newAgentForm.systemPrompt}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, systemPrompt: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg p-2.5 text-xs text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCreateModal(false)}
                  className="text-xs"
                >
                  إلغاء
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isCreatingAgent || !newAgentForm.name.trim()}
                  className="text-xs font-semibold"
                >
                  {isCreatingAgent ? "جاري الإنشاء..." : "إنشاء الإيجنت الآن"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
