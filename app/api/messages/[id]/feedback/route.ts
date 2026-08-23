import { getMessage, saveFeedback } from "@/lib/chat-store";
import { addMemory } from "@/lib/memory-store";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const message = await getMessage(id);
  if (!message || message.role !== "assistant") return Response.json({ error: "ไม่พบคำตอบของอัลฟ่า" }, { status: 404 });
  let input: { rating?: unknown; correction?: unknown; remember_correction?: unknown };
  try { input = await request.json() as typeof input; } catch { return Response.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
  const rating = input.rating === -1 ? -1 : input.rating === 1 ? 1 : 0;
  if (!rating) return Response.json({ error: "rating ต้องเป็น 1 หรือ -1" }, { status: 400 });
  const correction = typeof input.correction === "string" ? input.correction.trim().slice(0, 4000) : "";
  const rememberCorrection = input.remember_correction === true && Boolean(correction);
  const feedback = await saveFeedback({ messageId: id, rating, correction, rememberCorrection });
  let memory = null;
  if (rememberCorrection) {
    memory = await addMemory(`คำแก้ไขจากผู้ใช้: ${correction}`, "correction", {
      category: "correction", sourceChatId: message.chat_id, confidence: 100, pinned: true,
    });
  }
  return Response.json({ feedback, memory });
}
