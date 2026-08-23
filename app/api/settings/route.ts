import { getSettings, saveSettings } from "@/lib/settings-store";
import { unloadModel } from "@/lib/ollama";

export async function GET() {
  return Response.json(await getSettings(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PUT(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "รูปแบบการตั้งค่าไม่ถูกต้อง" }, { status: 400 });
  }

  const result = await saveSettings(input);
  if (result.previous.model !== result.settings.model) {
    await unloadModel(result.previous.model);
  }
  return Response.json(result.settings);
}
