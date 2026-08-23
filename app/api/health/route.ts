import { getSettings } from "@/lib/settings-store";
import { getHealth } from "@/lib/ollama";
import { getToolHealth } from "@/lib/tool-client";
import { ALPHA_VERSION } from "@/lib/version";

export async function GET() {
  const settings = await getSettings();
  const [health, toolService] = await Promise.all([getHealth(settings.model, settings.memory_target_gb || 10), getToolHealth()]);
  const browserReady = settings.browser_mode === "alpha"
    ? toolService.connected
    : settings.browser_mode === "chrome"
      ? toolService.chrome_extension_connected
      : false;
  return Response.json({
    app_version: ALPHA_VERSION,
    ...health,
    search_configured: toolService.search_ready,
    web_read_ready: toolService.web_read_ready,
    search_ready: toolService.search_ready,
    search_backend: toolService.search_backend,
    search_degraded_reason: toolService.search_degraded_reason,
    browser_ready: browserReady,
    search_provider: "hybrid",
    tool_service: toolService,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
