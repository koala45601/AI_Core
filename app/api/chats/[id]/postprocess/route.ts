import { postprocessChatTurn } from "@/lib/chat-postprocess";
import { getSettings } from "@/lib/settings-store";

interface PostprocessBody {
  user_message_id?: string;
  assistant_message_id?: string;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: PostprocessBody;
  try {
    body = await request.json() as PostprocessBody;
  } catch {
    return Response.json({ error: "รูปแบบคำขอไม่ถูกต้อง" }, { status: 400 });
  }

  if (!body.user_message_id || !body.assistant_message_id) {
    return Response.json({ error: "ข้อมูลข้อความไม่ครบ" }, { status: 400 });
  }

  try {
    const result = await postprocessChatTurn({
      chatId: id,
      userMessageId: body.user_message_id,
      assistantMessageId: body.assistant_message_id,
      settings: await getSettings(),
      signal: request.signal,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: error instanceof Error ? error.message : "ประมวลผลแชตเบื้องหลังไม่สำเร็จ" }, { status: 503 });
  }
}
