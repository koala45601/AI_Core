import { ticketRunEventsResponse } from "@/lib/tool-client";

export const runtime = "edge";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get("run_id") || "").trim();
    const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    if (!runId) return Response.json({ error: "ไม่พบ run_id" }, { status: 400 });
    const upstream = await ticketRunEventsResponse(runId, cursor);
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return Response.json({ error: detail || `Tool Service ตอบกลับ ${upstream.status}` }, { status: upstream.status || 502 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "เปิด Ticket Run event stream ไม่สำเร็จ" }, { status: 500 });
  }
}
