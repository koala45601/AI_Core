import { skillsRequest } from "@/lib/tool-client";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try { return Response.json(await skillsRequest(`?${url.searchParams.toString()}`, { method: "GET" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "โหลดรายการสกิลไม่สำเร็จ" }, { status: 503 }); }
}
