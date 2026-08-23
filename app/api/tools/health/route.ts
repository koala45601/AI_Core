import { getPairingCode, getToolHealth } from "@/lib/tool-client";

export async function GET() {
  const health = await getToolHealth();
  const pairing_code = health.connected ? await getPairingCode().catch(() => "") : "";
  return Response.json({ ...health, pairing_code }, { headers: { "Cache-Control": "no-store" } });
}

