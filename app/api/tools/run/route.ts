import { getSettings } from "@/lib/settings-store";
import { executeTool } from "@/lib/tool-client";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { artifact_id?: unknown };
    if (typeof body.artifact_id !== "string") return Response.json({ error: "ไม่พบรหัสไฟล์" }, { status: 400 });
    const settings = await getSettings();
    const result = await executeTool("run_artifact", { artifact_id: body.artifact_id }, settings);
    return Response.json(result, { status: result.confirmation_required ? 409 : 200 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "เตรียมรันไฟล์ไม่สำเร็จ" }, { status: 500 });
  }
}

