import { deleteChat, getChat, updateChat } from "@/lib/chat-store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const chat = await getChat(id);
  return chat ? Response.json({ chat }) : Response.json({ error: "ไม่พบแชต" }, { status: 404 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let input: { title?: unknown; pinned?: unknown; status?: unknown };
  try { input = await request.json() as typeof input; } catch { return Response.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
  const status = input.status === "active" || input.status === "archived" ? input.status : undefined;
  const chat = await updateChat(id, {
    title: typeof input.title === "string" ? input.title : undefined,
    pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
    status,
  });
  return chat ? Response.json({ chat }) : Response.json({ error: "ไม่พบแชต" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deleted = await deleteChat(id);
  return Response.json({ deleted }, { status: deleted ? 200 : 404 });
}
