import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.cwd());
const vars = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8");
const token = vars.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1]?.trim();
const baseUrl = vars.match(/^ALPHA_TOOL_BASE_URL=(.+)$/m)?.[1]?.trim() || "http://127.0.0.1:4317";
const ids = [
  "context-aware-concise-synthesizer",
  "offline-agent-state-manager",
  "offline-png-parser-captioner",
  "configurable-rule-evaluator",
  "pillow-png-metadata-extractor",
  "stateless-context-summarizer",
];

if (!token || token.length < 32) throw new Error("ALPHA_TOOL_TOKEN ไม่พร้อมใช้งาน");

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(`${path}: ${data.error || JSON.stringify(data)}`);
  return data;
}

for (const id of ids) {
  const detail = await api(`/v1/skills/${encodeURIComponent(id)}`);
  const input = detail.skill?.report?.tests?.[0]?.case?.input;
  if (!input || typeof input !== "object") throw new Error(`${id}: ไม่พบ verified fixture สำหรับ smoke test`);
  const run = await api(`/v1/skills/${encodeURIComponent(id)}/run`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  if (!run.ok) throw new Error(`${id}: ${run.stderr || "runtime failed"}`);
  const after = await api(`/v1/skills/${encodeURIComponent(id)}`);
  const manifest = after.skill.manifest;
  if (manifest.usage_count < 1 || manifest.success_count < 1) throw new Error(`${id}: usage metrics ไม่ถูกบันทึก`);
  console.log(`PASS ${id} — run ${manifest.success_count}/${manifest.usage_count}, confidence ${manifest.generalization_confidence}% (${manifest.confidence_sample_size} samples)`);
}

const registry = await api("/v1/skills?limit=100&sort=name");
const installed = registry.skills.filter((skill) => ids.includes(skill.id));
if (installed.length !== ids.length) throw new Error(`registry พบ ${installed.length}/${ids.length} สกิล`);
console.log(`RUNTIME VERIFIED ${installed.length}/${ids.length}`);
