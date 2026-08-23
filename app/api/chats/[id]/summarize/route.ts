import { estimateTokens, getChat, listChatMessages, saveChatSummary } from "@/lib/chat-store";
import { summarizeChat } from "@/lib/ollama";
import { getSettings } from "@/lib/settings-store";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const chat = await getChat(id);
  if (!chat) return Response.json({ error: "ไม่พบแชต" }, { status: 404 });
  const messages = await listChatMessages(id);
  if (!messages.length) return Response.json({ summary: chat.rolling_summary, skipped: true });
  const settings = await getSettings();
  if (!settings.auto_summarize_enabled && estimateTokens(messages) < 3500) return Response.json({ summary: chat.rolling_summary, skipped: true });
  try {
    const summary = await summarizeChat(messages.map(({ role, content }) => ({ role, content })), chat.rolling_summary, settings);
    await saveChatSummary(id, summary, messages.length);
    return Response.json({ summary });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "สรุปแชตไม่สำเร็จ" }, { status: 503 });
  }
}
