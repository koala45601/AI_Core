import { openArtifact } from "@/lib/tool-client";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await openArtifact(id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "เปิด Finder ไม่สำเร็จ" }, { status: 500 });
  }
}

