import { listChats, listRecentChatMessages } from "@/lib/chat-store";
import { addMemory } from "@/lib/memory-store";
import { getSettings } from "@/lib/settings-store";
import { acknowledgeAutoLearn, getAutoLearnStatus, startAutoLearn, stopAutoLearn } from "@/lib/tool-client";

function redactFocus(value: string) {
  return value.replace(/((?:password|รหัสผ่าน|otp|token|api[_ -]?key|secret)\s*[:=]?\s*)\S+/gi, "$1[REDACTED]").slice(0, 20_000);
}

async function recentFocusContext() {
  const chats = await listChats({ status: "active", limit: 12 });
  const entries = await Promise.all(chats.map(async (chat) => {
    const messages = await listRecentChatMessages(chat.id, 6);
    const userWork = messages.filter((item) => item.role === "user").map((item) => item.content).join(" | ");
    return `- ${chat.title}\n  ${chat.rolling_summary || userWork || chat.last_preview}`;
  }));
  return redactFocus(entries.join("\n").slice(0, 20_000));
}

export async function GET() {
  try {
    const data = await getAutoLearnStatus();
    const job = data.job as Record<string, unknown> | undefined;
    if (job && ["completed", "stopped"].includes(String(job.status)) && job.imported !== true && job.report && typeof job.report === "object") {
      const report = job.report as { summary?: unknown; topics?: Array<Record<string, unknown>>; skills?: Array<Record<string, unknown>> };
      const topics = (report.topics ?? []).filter((item) => item.success === true).slice(0, 20);
      const memory = `[Auto Learn ${String(job.id || "")}] ${String(report.summary || "")}\n${topics.map((item) => `- ${String(item.title || "")}: ${String(item.summary || "").slice(0, 1200)}`).join("\n")}`;
      if (topics.length) await addMemory(memory, "research");
      await acknowledgeAutoLearn();
      job.imported = true;
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "อ่านสถานะ Auto Learn ไม่สำเร็จ" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: { duration_minutes?: unknown } = {};
  try { body = await request.json(); } catch { /* use default */ }
  const settings = await getSettings();
  if (!settings.web_search_enabled) return Response.json({ error: "ต้องเปิดอินเทอร์เน็ตก่อนเริ่ม Auto Learn" }, { status: 403 });
  const requestedDuration = Number(body.duration_minutes);
  const duration = Number.isFinite(requestedDuration) && requestedDuration === 0
    ? 0
    : Math.min(1_440, Math.max(1, requestedDuration || 60));
  try {
    return Response.json(await startAutoLearn({
      duration_minutes: duration,
      model: settings.model,
      focus_context: await recentFocusContext(),
      max_rounds: settings.auto_learn_max_rounds,
      step_timeout_seconds: settings.auto_learn_step_timeout_seconds,
      retry_limit: settings.auto_learn_retry_limit,
      skill_frequency: settings.auto_learn_skill_frequency,
      rest_seconds: settings.auto_learn_rest_seconds,
      skill_lab_max_attempts: settings.skill_lab_max_attempts,
      research_max_rounds: settings.research_max_rounds,
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "เริ่ม Auto Learn ไม่สำเร็จ" }, { status: 503 });
  }
}

export async function DELETE() {
  try { return Response.json(await stopAutoLearn()); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "หยุด Auto Learn ไม่สำเร็จ" }, { status: 503 }); }
}
