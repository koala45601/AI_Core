import { skillsRequest } from "@/lib/tool-client";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try { return Response.json(await skillsRequest(`/${encodeURIComponent(id)}`, { method: "GET" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "ไม่พบสกิล" }, { status: 404 }); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.text();
  try { return Response.json(await skillsRequest(`/${encodeURIComponent(id)}`, { method: "PATCH", body })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "แก้สกิลไม่สำเร็จ" }, { status: 503 }); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try { return Response.json(await skillsRequest(`/${encodeURIComponent(id)}`, { method: "DELETE" })); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "ลบสกิลไม่สำเร็จ" }, { status: 503 }); }
}
