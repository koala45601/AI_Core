import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "lib", "ollama.ts");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta5-adaptive-reasoning-v1";

if (source.includes(marker)) {
  console.log("Alpha beta5 adaptive reasoning already applied");
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  source = source.replace(needle, replacement);
}

function patchSection(startNeedle, endNeedle, transform, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`หา section ${label} ไม่พบ`);
  const before = source.slice(0, start);
  const section = source.slice(start, end);
  const after = source.slice(end);
  const next = transform(section);
  if (next === section) throw new Error(`section ${label} ไม่ได้ถูกแก้`);
  source = before + next + after;
}

const helperNeedle = "export async function decideSearchWithModel(message: string, settings: AppSettings): Promise<boolean> {";
const helperBlock = `// ${marker}\ntype AlphaReasoningTier = "fast" | "balanced" | "deep";\n\ninterface AlphaReasoningProfile {\n  tier: AlphaReasoningTier;\n  think: boolean;\n  numCtx: number;\n  numPredict: number;\n  timeoutMs: number;\n}\n\nfunction lastUserText(messages: OllamaConversationMessage[]): string {\n  for (let index = messages.length - 1; index >= 0; index -= 1) {\n    if (messages[index]?.role === "user") return String(messages[index]?.content || "");\n  }\n  return "";\n}\n\nfunction isFastLocalConversation(messages: OllamaConversationMessage[]): boolean {\n  return messages.some((item) => item.role === "system" && /คำถามทั่วไปที่ไม่ต้องใช้เว็บหรือเครื่องมือ|ตอบตรงคำถามทันที/i.test(String(item.content || "")));\n}\n\nfunction adaptiveReasoningProfile(\n  messages: OllamaConversationMessage[],\n  settings: AppSettings,\n  purpose: "chat" | "single" | "tool",\n): AlphaReasoningProfile {\n  const text = lastUserText(messages);\n  const baseCtx = Math.max(4096, settings.max_context_tokens || 6144);\n  const basePredict = Math.max(768, settings.max_output_tokens || 1536);\n  const deepIntent = /(วิเคราะห์|วางแผน|ออกแบบ|architecture|debug|bug|แก้โค้ด|เขียนโค้ด|โปรแกรม|security|cyber|pentest|wifi|wi-fi|wireless|audit|docker|api|database|incident|root cause|rca|reason|logic|หลายขั้น|workflow|agent|tool|ทดสอบ|ตรวจสอบ|เปรียบเทียบ|optimi[sz]e)/i.test(text);\n  const mediumIntent = deepIntent || text.length > 700 || /(?:ทำไม|อย่างไร|ยังไง|อธิบาย|คิด|ประเมิน|recommend|แนะนำ)/i.test(text);\n\n  if (purpose === "tool") {\n    return {\n      tier: "deep",\n      think: true,\n      numCtx: Math.min(24_576, Math.max(baseCtx, 16_384)),\n      numPredict: Math.min(3_072, Math.max(basePredict, 2_048)),\n      timeoutMs: 300_000,\n    };\n  }\n\n  if (isFastLocalConversation(messages) && !deepIntent) {\n    return { tier: "fast", think: false, numCtx: baseCtx, numPredict: basePredict, timeoutMs: 180_000 };\n  }\n\n  if (deepIntent) {\n    return {\n      tier: "deep",\n      think: true,\n      numCtx: Math.min(24_576, Math.max(baseCtx, 16_384)),\n      numPredict: Math.min(3_072, Math.max(basePredict, 2_048)),\n      timeoutMs: 300_000,\n    };\n  }\n\n  if (mediumIntent || purpose === "single") {\n    return {\n      tier: "balanced",\n      think: true,\n      numCtx: Math.min(16_384, Math.max(baseCtx, 8_192)),\n      numPredict: Math.min(2_048, Math.max(basePredict, 1_536)),\n      timeoutMs: 240_000,\n    };\n  }\n\n  return { tier: "fast", think: false, numCtx: baseCtx, numPredict: basePredict, timeoutMs: 180_000 };\n}\n\nfunction deepWorkerOptions(settings: AppSettings, requestedPredict: number) {\n  return {\n    think: true,\n    numCtx: Math.min(24_576, Math.max(settings.max_context_tokens || 6144, 16_384)),\n    numPredict: Math.min(4_096, Math.max(requestedPredict, settings.max_output_tokens || 1536)),\n    timeoutMs: 300_000,\n  };\n}\n\n`;
replaceOnce(helperNeedle, helperBlock + helperNeedle, "adaptive reasoning insertion point");

patchSection(
  "export async function requestChatStream(",
  "export async function requestChatOnce(",
  (section) => {
    let next = section.replace(
      "): Promise<Response> {\n  return ollamaFetch(\"/api/chat\", {",
      "): Promise<Response> {\n  const reasoning = adaptiveReasoningProfile(messages, settings, \"chat\");\n  return ollamaFetch(\"/api/chat\", {",
    );
    next = next.replace("      think: false,", "      think: reasoning.think,");
    next = next.replace("        num_ctx: settings.max_context_tokens,", "        num_ctx: reasoning.numCtx,");
    next = next.replace("        num_predict: settings.max_output_tokens,", "        num_predict: reasoning.numPredict,");
    next = next.replace("    signal: AbortSignal.timeout(180_000),", "    signal: AbortSignal.timeout(reasoning.timeoutMs),");
    return next;
  },
  "requestChatStream",
);

patchSection(
  "export async function requestChatOnce(",
  "export async function requestToolPlan(",
  (section) => {
    let next = section.replace(
      "): Promise<{ content: string; prompt_tokens: number; response_tokens: number }> {\n  const response = await ollamaFetch(\"/api/chat\", {",
      "): Promise<{ content: string; prompt_tokens: number; response_tokens: number }> {\n  const reasoning = adaptiveReasoningProfile(messages, settings, \"single\");\n  const response = await ollamaFetch(\"/api/chat\", {",
    );
    next = next.replace("      think: false,", "      think: reasoning.think,");
    next = next.replace("        num_ctx: settings.max_context_tokens,", "        num_ctx: reasoning.numCtx,");
    next = next.replace("        num_predict: settings.max_output_tokens,", "        num_predict: reasoning.numPredict,");
    next = next.replace("    signal: AbortSignal.timeout(180_000),", "    signal: AbortSignal.timeout(reasoning.timeoutMs),");
    return next;
  },
  "requestChatOnce",
);

patchSection(
  "export async function requestToolPlan(",
  "export async function extractDurableMemory(",
  (section) => {
    let next = section.replace(
      "): Promise<OllamaConversationMessage> {\n  const response = await ollamaFetch(\"/api/chat\", {",
      "): Promise<OllamaConversationMessage> {\n  const reasoning = adaptiveReasoningProfile(messages, settings, \"tool\");\n  const response = await ollamaFetch(\"/api/chat\", {",
    );
    next = next.replace("      think: false,", "      think: reasoning.think,");
    next = next.replace("        num_ctx: settings.max_context_tokens,", "        num_ctx: reasoning.numCtx,");
    next = next.replace("        num_predict: Math.min(settings.max_output_tokens, 1400),", "        num_predict: reasoning.numPredict,");
    next = next.replace("    signal: AbortSignal.timeout(180_000),", "    signal: AbortSignal.timeout(reasoning.timeoutMs),");
    return next;
  },
  "requestToolPlan",
);

for (const [startNeedle, endNeedle, predictExpression, label] of [
  ["export async function designSkillGoal(", "export async function designHiddenSkillTests(", "Math.min(2600, settings.max_output_tokens + 1000)", "designSkillGoal"],
  ["export async function designHiddenSkillTests(", "export async function buildSkillAttempt(", "Math.min(3000, Math.max(1200, settings.max_output_tokens * 2))", "designHiddenSkillTests"],
  ["export async function buildSkillAttempt(", "export async function synthesizeResearchRound(", "Math.min(4200, Math.max(2400, settings.max_output_tokens * 2))", "buildSkillAttempt"],
  ["export async function synthesizeResearchRound(", "export async function unloadModel(", "Math.min(settings.max_output_tokens, 1200)", "synthesizeResearchRound"],
]) {
  patchSection(startNeedle, endNeedle, (section) => {
    let next = section;
    const anchor = label === "designSkillGoal" ? "  const sourceText =" : label === "designHiddenSkillTests" ? "  const requested =" : label === "buildSkillAttempt" ? "  const previousSource =" : "  const evidence =";
    next = next.replace(anchor, `  const deepWorker = deepWorkerOptions(settings, ${predictExpression});\n${anchor}`);
    next = next.replace("      think: false,", "      think: deepWorker.think,");
    next = next.replace(/num_ctx: settings\.max_context_tokens/g, "num_ctx: deepWorker.numCtx");
    next = next.replace(predictExpression, "deepWorker.numPredict");
    next = next.replace(/timedSignal\((180_000|240_000), signal\)/g, "timedSignal(deepWorker.timeoutMs, signal)");
    return next;
  }, label);
}

const temporary = `${path}.beta5.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, path);
console.log("Applied Alpha beta5 adaptive reasoning: fast chat stays fast; agent/tool/skill/research work uses thinking + larger context");
