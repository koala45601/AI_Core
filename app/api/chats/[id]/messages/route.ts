import { getChat, listChatMessages } from "@/lib/chat-store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const chat = await getChat(id);
  if (!chat) return Response.json({ error: "ไม่พบแชต" }, { status: 404 });
  return Response.json({ chat, messages: await listChatMessages(id) }, { headers: { "Cache-Control": "no-store" } });
}
