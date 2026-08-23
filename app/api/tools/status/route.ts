import { getHostConfirmationStatus } from "@/lib/tool-client";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "ไม่พบรหัสคำขอ" }, { status: 400 });
    return Response.json(await getHostConfirmationStatus(id));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "อ่านสถานะคำขอไม่สำเร็จ" }, { status: 503 });
  }
}
