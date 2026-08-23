import { confirmTool } from "@/lib/tool-client";
import { getMessage, updateMessage } from "@/lib/chat-store";
import { ArtifactRecord } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { confirmation_id?: unknown; approved?: unknown; message_id?: unknown };
    if (typeof body.confirmation_id !== "string") return Response.json({ error: "ไม่พบรหัสคำขอ" }, { status: 400 });
    const result = await confirmTool(body.confirmation_id, body.approved === true);
    if (typeof body.message_id === "string") {
      const existing = await getMessage(body.message_id);
      if (existing) {
        const artifacts = Array.isArray(result.artifacts) ? result.artifacts as ArtifactRecord[] : [];
        const content = result.denied
          ? "ไม่ได้ดำเนินการ เพราะคุณไม่อนุญาต"
          : [existing.content, result.message, result.stdout ? `ผลการรัน:\n${String(result.stdout)}` : "", result.stderr ? `ข้อผิดพลาด:\n${String(result.stderr)}` : ""].filter(Boolean).join("\n\n");
        await updateMessage(body.message_id, { content, metadata: { artifacts: [...(existing.metadata.artifacts ?? []), ...artifacts] } });
      }
    }
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "ยืนยันเครื่องมือไม่สำเร็จ" }, { status: 500 });
  }
}
