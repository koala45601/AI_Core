import { skillsRequest } from "@/lib/tool-client";

const ACTIONS = new Set(["run", "test", "reverify", "retrain", "export", "open"]);

export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  if (!ACTIONS.has(action)) return Response.json({ error: "ไม่รู้จักคำสั่งสกิล" }, { status: 404 });
  const body = action === "run" ? await request.text() || "{}" : "{}";
  try { return Response.json(await skillsRequest(`/${encodeURIComponent(id)}/${action}`, { method: "POST", body })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "คำสั่งสกิลไม่สำเร็จ" }, { status: 503 }); }
}
