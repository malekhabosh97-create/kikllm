import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Eye, EyeOff, RefreshCw, ShieldAlert, CheckCircle2, Clock, Sparkles, MessageSquare } from "lucide-react";

export function BrowserManagerPage() {
  const [status, setStatus] = useState<any>({ deepseek: "CHECKING", gemini: "CHECKING", isGenerating: false });
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/browser/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      } else {
        setStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED", isGenerating: false });
      }
    } catch {
      setStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED", isGenerating: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  const handleShowWindow = async () => {
    try {
      const res = await fetch("/api/browser/show", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert("تعذر إظهار النافذة: " + (body.error || body.message || `HTTP ${res.status}`));
      }
    } catch (e: any) {
      alert("تعذر إظهار النافذة: " + e.message);
    }
  };

  const handleMinimizeWindow = async () => {
    try {
      const res = await fetch("/api/browser/minimize", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert("تعذر تصغير النافذة: " + (body.error || body.message || `HTTP ${res.status}`));
      }
    } catch (e: any) {
      alert("تعذر تصغير النافذة: " + e.message);
    }
  };

  const handleSwitchTab = async (platform: "deepseek" | "gemini") => {
    try {
      const res = await fetch("/api/browser/tab/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert("تعذر فتح التبويب: " + (body.error || body.message || `HTTP ${res.status}`));
      }
    } catch (e: any) {
      alert("تعذر فتح التبويب: " + e.message);
    }
  };

  const getBadge = (s?: string) => {
    switch (s) {
      case "READY":
        return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">جاهز / متصل</Badge>;
      case "NEEDS_LOGIN":
        return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/40">يحتاج تسجيل دخول</Badge>;
      case "NEEDS_HUMAN_INTERVENTION":
        return <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/40 animate-pulse">مطلوب تدخل بشري (كابتشا)</Badge>;
      default:
        return <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/40">غير متصل</Badge>;
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>إدارة المتصفح الحي (FreeLLM Browser Hub)</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            التحكم في متصفح Chromium المباشر ومراقبة منصات الذكاء الاصطناعي المجانية (DeepSeek & Google Gemini).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={fetchStatus} disabled={loading} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            تحديث الحالة
          </Button>
          <Button variant="default" size="sm" onClick={handleShowWindow} className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white">
            <Eye className="w-3.5 h-3.5" />
            إظهار المتصفح
          </Button>
          <Button variant="secondary" size="sm" onClick={handleMinimizeWindow} className="gap-2">
            <EyeOff className="w-3.5 h-3.5" />
            تصغير المتصفح
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* DeepSeek Card */}
        <Card className="bg-[#1e293b] border-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-sky-400" />
                <span>DeepSeek Web</span>
              </CardTitle>
              {getBadge(status.deepseek)}
            </div>
            <CardDescription className="text-xs text-slate-400">
              الوضع العادي (Instant) ووضع التفكير العميق (DeepThink)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs text-slate-300">
            <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الموديلات المتاحة:</span>
                <span className="text-emerald-400 font-medium">Normal / DeepThink</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">رابط الخدمة:</span>
                <span className="font-mono text-slate-200">https://chat.deepseek.com</span>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSwitchTab("deepseek")}
                className="w-full text-xs gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                التبديل إلى تبويب DeepSeek
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Google Gemini Card */}
        <Card className="bg-[#1e293b] border-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Google Gemini Web</span>
              </CardTitle>
              {getBadge(status.gemini)}
            </div>
            <CardDescription className="text-xs text-slate-400">
              يدعم كافة أوضاع حسابك (Flash / Pro / Flash-Lite / Argon)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs text-slate-300">
            <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الموديلات المدعومة:</span>
                <span className="text-amber-300 font-medium">3.1 Pro / 3.8 Flash / 4 Argon</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">رابط الخدمة:</span>
                <span className="font-mono text-slate-200">https://gemini.google.com/app</span>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSwitchTab("gemini")}
                className="w-full text-xs gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                التبديل إلى تبويب Gemini
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Global Status Banner */}
      <Card className="bg-[#1e293b]/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-white">بيئة التشغيل المحلية الآمنة (.freellm-browser-profile)</CardTitle>
          <CardDescription className="text-xs text-slate-400">
            متصفح مرئي حقيقي يعمل على سطح مكتبك مع إدارة الجلسات والكوكيز
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-slate-300">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-slate-900/60 p-3 rounded border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">القفل الذري (Atomic Lock):</span>
              <span className="text-emerald-400 flex items-center gap-1 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5" /> نشط
              </span>
            </div>
            <div className="bg-slate-900/60 p-3 rounded border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">منفذ التحكم (CDP Port):</span>
              <span className="text-slate-200 font-mono">127.0.0.1:9222</span>
            </div>
            <div className="bg-slate-900/60 p-3 rounded border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">حالة التوليد الحالية:</span>
              <span className="text-slate-200 font-medium">
                {status.isGenerating ? "جاري التوليد الآن..." : "خامل / جاهز"}
              </span>
            </div>
          </div>

          <div className="p-3 bg-blue-950/30 border border-blue-900/40 rounded text-blue-300 leading-relaxed">
            💡 <strong>ملاحظة:</strong> يمكنك تشغيل المتصفح بجميع التبويبات بنقرة واحدة من سطح المكتب عبر ملف <code>FreeLLM_Browser.bat</code> أو اختصار <code>FreeLLM Browser</code>.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
