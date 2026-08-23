import { artifactResponse } from "@/lib/tool-client";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return artifactResponse(id);
}

