import { confirmTool } from "@/lib/tool-client";
import { getMessage, updateMessage } from "@/lib/chat-store";
import { ArtifactRecord } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { confirmation_id?: unknown; approved?: unknown; message_id?: unknown };
    if (typeof body.confirmation_id !== "string") return Response.json({ error: "ไม่พบรหัสคำขอ" }, { status: 400 });

    const approved = body.approved === true;
    const result = await confirmTool(body.confirmation_id, approved);

    if (typeof body.message_id === "string") {
      const existing = await getMessage(body.message_id);
      if (existing) {
        const artifacts = Array.isArray(result.artifacts) ? result.artifacts as ArtifactRecord[] : [];
        const toolEvents = (existing.metadata.tool_events ?? []).filter((item) => !(
          item.type === "permission_required" && item.confirmation_id === body.confirmation_id
        ));
        toolEvents.push({
          type: "permission_resolved",
          confirmation_id: body.confirmation_id,
          approved,
          ok: result.ok !== false,
          at: Date.now(),
        });

        const statusText = result.denied
          ? "ไม่ได้ดำเนินการ เพราะคุณไม่อนุญาต"
          : String(result.message || (result.ok === false ? result.error || "ดำเนินการไม่สำเร็จ" : "ดำเนินการที่ได้รับอนุญาตเรียบร้อยแล้ว"));

        await updateMessage(body.message_id, {
          content: statusText,
          metadata: {
            artifacts: [...(existing.metadata.artifacts ?? []), ...artifacts],
            tool_events: toolEvents,
            error: result.ok === false && !result.denied,
          },
        });
      }
    }

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "ยืนยันเครื่องมือไม่สำเร็จ" }, { status: 500 });
  }
}
