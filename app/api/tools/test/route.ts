import { searchWebDetailed } from "@/lib/search";
import { getSettings } from "@/lib/settings-store";
import { executeTool } from "@/lib/tool-client";

export async function POST(request: Request) {
  let kind = "";
  try {
    const input = await request.json() as { kind?: unknown };
    kind = typeof input.kind === "string" ? input.kind : "";
  } catch { return Response.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
  const settings = await getSettings();
  if (!settings.web_search_enabled) return Response.json({ error: "สวิตช์อินเทอร์เน็ตปิดอยู่" }, { status: 403 });
  try {
    if (kind === "read") {
      const result = await executeTool("web_read", { url: "https://example.com/" }, settings);
      return Response.json({ ok: true, label: `อ่าน URL สำเร็จ: ${String(result.title || "Example Domain").slice(0, 80)}` });
    }
    if (kind === "search") {
      const result = await searchWebDetailed("ข่าวเทคโนโลยีวันนี้", settings);
      return Response.json({ ok: result.results.length > 0, label: `ค้นผ่าน ${result.backend} พบ ${result.results.length} ผลลัพธ์`, ...result });
    }
    if (kind === "browser") {
      if (settings.browser_mode === "off") return Response.json({ error: "ปิด Browser mode อยู่" }, { status: 409 });
      const result = await executeTool("browser_action", { action: "open", url: "https://example.com/", new_tab: true }, settings);
      return Response.json({ ok: result.ok !== false, label: `Browser เปิด ${String(result.title || result.url || "example.com")}`, result });
    }
    return Response.json({ error: "ไม่รู้จักการทดสอบ" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "ทดสอบเครื่องมือไม่สำเร็จ" }, { status: 503 });
  }
}
