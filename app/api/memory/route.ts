import { addMemory, deleteMemory, listMemories, updateMemory } from "@/lib/memory-store";

export async function GET() {
  return Response.json({ memories: await listMemories() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let content = "";
  try {
    const input = await request.json() as { content?: unknown };
    content = typeof input.content === "string" ? input.content : "";
  } catch {
    return Response.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }

  if (!content.trim()) {
    return Response.json({ error: "กรุณาใส่สิ่งที่ต้องการให้อัลฟ่าจำ" }, { status: 400 });
  }

  const memory = await addMemory(content, "manual");
  if (!memory) return Response.json({ error: "ไม่สามารถบันทึกความจำได้" }, { status: 503 });
  return Response.json({ memory }, { status: 201 });
}

export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "รหัสความจำไม่ถูกต้อง" }, { status: 400 });
  }
  const deleted = await deleteMemory(id);
  return Response.json({ deleted }, { status: deleted ? 200 : 404 });
}

export async function PATCH(request: Request) {
  let input: { id?: unknown; content?: unknown; pinned?: unknown; category?: unknown };
  try { input = await request.json() as typeof input; } catch { return Response.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "รหัสความจำไม่ถูกต้อง" }, { status: 400 });
  const allowedCategories = new Set(["general", "profile", "preference", "project", "correction", "research"]);
  const memory = await updateMemory(id, {
    content: typeof input.content === "string" ? input.content : undefined,
    pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
    category: allowedCategories.has(String(input.category)) ? input.category as "general" : undefined,
  });
  return memory ? Response.json({ memory }) : Response.json({ error: "ไม่พบความจำ" }, { status: 404 });
}
