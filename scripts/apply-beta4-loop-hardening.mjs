import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "app", "api", "chat", "route.ts");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta4-loop-hardening-v1";
if (source.includes(marker)) process.exit(0);
if (!source.includes("alpha-beta4-agent-loop-v1")) throw new Error("ต้อง apply beta4 chat runtime ก่อน");

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `  if (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {\n    await updateAgentRun(runId, { status: "running", stage: "planning", label: "กำลังวางแผน workflow ให้จบทั้งงาน" });`,
  `  // ${marker}\n  const workflowRequiresArtifact = /(สร้าง|ทำ|เขียน|บันทึก|save|create|build).{0,45}(ไฟล์|โปรแกรม|โค้ด|project|script|\\.py|\\.js|\\.mjs|\\.sh|\\.html|\\.json)/i.test(message);\n  let workflowCreatedArtifact = false;\n\n  if (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {\n    await updateAgentRun(runId, { status: "running", stage: "planning", label: "กำลังวางแผน workflow ให้จบทั้งงาน" });`,
  "workflow requirement state",
);

replaceOnce(
  `      if (!calls.length) break;`,
  `      if (!calls.length && workflowRequiresArtifact && !workflowCreatedArtifact && iteration < 7) {\n        conversation.push(planned);\n        conversation.push({ role: "system", content: "งานนี้ยังไม่จบ: ผู้ใช้สั่งให้สร้างไฟล์/โปรแกรมจริง แต่ยังไม่มี Artifact จาก create_files ห้ามตอบว่าจะสร้าง ห้ามให้ผู้ใช้ยืนยันซ้ำ ให้เรียก create_files ตอนนี้พร้อมเนื้อหาที่สมบูรณ์ แล้วค่อยทำขั้นถัดไป" });\n        await updateAgentRun(runId, { status: "running", stage: "planning", label: "ยังไม่มีไฟล์จริง — กำลังบังคับ workflow ให้สร้าง Artifact" });\n        continue;\n      }\n      if (!calls.length) break;`,
  "no-call continuation",
);

replaceOnce(
  `        if (Array.isArray(result.artifacts)) toolEvents.push({ type: "artifact", payload: { artifacts: result.artifacts as ArtifactRecord[] } });`,
  `        if (Array.isArray(result.artifacts)) {\n          workflowCreatedArtifact = workflowCreatedArtifact || result.artifacts.length > 0;\n          toolEvents.push({ type: "artifact", payload: { artifacts: result.artifacts as ArtifactRecord[] } });\n        }`,
  "artifact completion tracking",
);

replaceOnce(
  `        if (toolEvents.length && !assistantText.includes("สถานะ: ✅ COMPLETED")) {\n          const completed = \`${assistantText.trim() ? "\\n\\n" : ""}สถานะ: ✅ COMPLETED\`;\n          assistantText += completed;\n          controller.enqueue(event("token", { text: completed }));\n        }\n        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));\n        await finishAgentRun(runId, "completed", toolEvents.length ? "workflow เสร็จสมบูรณ์" : "ตอบเสร็จแล้ว");`,
  `        const missingRequiredArtifact = workflowRequiresArtifact && artifacts.length === 0;\n        if (missingRequiredArtifact) {\n          const failed = \`${assistantText.trim() ? "\\n\\n" : ""}สถานะ: ❌ FAILED — ยังไม่มีไฟล์จริงจาก create_files จึงไม่นับว่างานเสร็จ\`;\n          assistantText += failed;\n          controller.enqueue(event("token", { text: failed }));\n        } else if (toolEvents.length && !assistantText.includes("สถานะ: ✅ COMPLETED")) {\n          const completed = \`${assistantText.trim() ? "\\n\\n" : ""}สถานะ: ✅ COMPLETED\`;\n          assistantText += completed;\n          controller.enqueue(event("token", { text: completed }));\n        }\n        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));\n        if (missingRequiredArtifact) await finishAgentRun(runId, "failed", "workflow ยังไม่สร้าง Artifact จริง", "Planner ครบรอบแต่ create_files ยังไม่คืน Artifact");\n        else await finishAgentRun(runId, "completed", toolEvents.length ? "workflow เสร็จสมบูรณ์" : "ตอบเสร็จแล้ว");`,
  "truthful completion status",
);

const tmp = `${path}.beta4-hardening.tmp`;
await fs.writeFile(tmp, source, "utf8");
await fs.rename(tmp, path);
console.log("Applied beta4 workflow hardening");
