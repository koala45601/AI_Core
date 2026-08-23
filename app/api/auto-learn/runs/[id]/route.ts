import { autoLearnRequest } from "@/lib/tool-client";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try { return Response.json(await autoLearnRequest(`/runs/${encodeURIComponent(id)}`, { method: "GET" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "ไม่พบ run" }, { status: 404 }); }
}
