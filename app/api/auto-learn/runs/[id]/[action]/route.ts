import { autoLearnRequest } from "@/lib/tool-client";

export async function POST(_request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  if (!["retry", "skip"].includes(action)) return Response.json({ error: "ไม่รู้จักคำสั่ง" }, { status: 404 });
  try { return Response.json(await autoLearnRequest(`/runs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "สั่งงาน Auto Learn ไม่สำเร็จ" }, { status: 503 }); }
}
