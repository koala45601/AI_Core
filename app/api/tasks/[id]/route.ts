import { getAgentRun } from "@/lib/agent-run-store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = await getAgentRun(id);
  if (!run) return Response.json({ error: "ไม่พบสถานะงาน" }, { status: 404 });
  return Response.json({ run });
}
