import { autoLearnRequest } from "@/lib/tool-client";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try { return Response.json(await autoLearnRequest(`/events?${url.searchParams.toString()}`, { method: "GET" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "โหลด timeline ไม่สำเร็จ" }, { status: 503 }); }
}
