import { evaluatePolicy } from "@/lib/policy.js";
import { getSettings } from "@/lib/settings-store";
import { searchWebDetailed, SearchUnavailableError } from "@/lib/search";

export async function POST(request: Request) {
  let query = "";
  try {
    const input = await request.json() as { query?: unknown };
    query = typeof input.query === "string" ? input.query.trim() : "";
  } catch {
    return Response.json({ error: "รูปแบบคำค้นไม่ถูกต้อง" }, { status: 400 });
  }

  if (!query) return Response.json({ error: "กรุณาใส่คำค้น" }, { status: 400 });
  const settings = await getSettings();
  const policy = evaluatePolicy(query, settings);

  if (!policy.allowed) {
    return Response.json({ error: policy.reason, code: policy.code }, { status: 403 });
  }
  if (!settings.web_search_enabled) {
    return Response.json({ error: "การเข้าถึงอินเทอร์เน็ตถูกปิดอยู่", code: "internet_disabled" }, { status: 403 });
  }

  try {
    return Response.json(await searchWebDetailed(query, settings));
  } catch (error) {
    const message = error instanceof SearchUnavailableError ? error.message : "ค้นเว็บไม่สำเร็จ";
    return Response.json({ error: message }, { status: 503 });
  }
}
