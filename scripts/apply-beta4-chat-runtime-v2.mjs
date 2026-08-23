import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const routePath = resolve(appDir, "app", "api", "chat", "route.ts");
let source = await fs.readFile(routePath, "utf8");
const marker = "alpha-beta4-agent-loop-v1";

if (source.includes(marker)) {
  console.log("Alpha beta4 chat runtime already applied");
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  source = source.replace(needle, replacement);
}

function replaceBlock(startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

replaceOnce(
  'import { addMemory, findRelevantMemories } from "@/lib/memory-store";',
  'import { addMemory, findRelevantMemories } from "@/lib/memory-store";\nimport { finishAgentRun, startAgentRun, updateAgentRun } from "@/lib/agent-run-store";',
  "agent-run-store import",
);

const shouldPlanTools = [
  'function shouldPlanTools(message: string, directRead: boolean, browserHandled: boolean, learnedSkills: LearnedSkillSummary[]): boolean {',
  '  const fileIntent = /(สร้าง|ทำ|เขียน|บันทึก|ส่งออก|ดาวน์โหลด|download|create|save).{0,40}(ไฟล์|โปรแกรม|โค้ด|project|script|\\.py|\\.js|\\.mjs|\\.sh|\\.html|\\.json)|(?:อ่าน|แก้|ย้าย|บีบอัด|zip|ลบ|เปิด).{0,30}(?:ไฟล์|finder)|รันไฟล์|run file/i.test(message);',
  '  const apiDiscoveryIntent = /(devtools|network tab|api|endpoint|xhr|fetch|graphql).{0,50}(หา|ค้น|จับ|ดู|วิเคราะห์|ทดสอบ|ยิง|discover|inspect|probe)|(?:หา|ค้น|จับ|วิเคราะห์|ทดสอบ|ยิง).{0,50}(?:api|endpoint|xhr|fetch|graphql)/i.test(message);',
  '  const securityIntent = /(wifi|wi-fi|wireless|security|cyber|pentest|hack|ช่องโหว่|เครือข่าย|รหัสผ่าน|password|audit)/i.test(message)',
  '    && /(ตรวจ|ทดสอบ|สร้าง|ทำ|วิเคราะห์|สแกน|หา|run|test|audit|scan|build|create)/i.test(message);',
  '  return fileIntent || apiDiscoveryIntent || securityIntent || matchesLearnedSkill(message, learnedSkills) || (wantsBrowser(message) && !browserHandled) || (!directRead && !browserHandled && /https?:\\/\\//i.test(message));',
  '}',
  '',
].join("\n");
replaceBlock("function shouldPlanTools(", "function toolResultContent", shouldPlanTools, "shouldPlanTools");

const helpers = [
  '// ' + marker,
  'function artifactLocationQuestion(message: string): boolean {',
  '  return /(?:ไฟล์|โปรแกรม|project|artifact).{0,35}(?:อยู่ไหน|ไว้ไหน|ที่ไหน|path|พาธ|folder|โฟลเดอร์)|(?:อยู่ไหน|ไว้ไหน|ที่ไหน|path|พาธ).{0,35}(?:ไฟล์|โปรแกรม|project|artifact)/i.test(message);',
  '}',
  '',
  'function artifactLocationText(artifacts: ArtifactRecord[]): string {',
  '  if (!artifacts.length) return "";',
  '  const unique = artifacts.filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index);',
  '  return ["📁 ตำแหน่งไฟล์จริง:", ...unique.map((item) => "- " + item.name + ": `" + item.path + "`")].join("\\n");',
  '}',
  '',
  'function storedMessageForModel(item: { role: "user" | "assistant"; content: string; metadata?: { artifacts?: ArtifactRecord[] } }) {',
  '  const locations = item.role === "assistant" ? artifactLocationText(item.metadata?.artifacts ?? []) : "";',
  '  return { role: item.role, content: item.content + (locations ? "\\n\\n[Artifact record จากระบบ]\\n" + locations : "") };',
  '}',
  '',
  'function buildLocalSystemPrompt(settings: AppSettings) {',
  '  const rules = settings.core_rules.map((rule, index) => String(index + 1) + ". " + rule).join("\\n");',
  '  return "คุณคือ “อัลฟ่า” ผู้ช่วย AI ส่วนตัวบน Mac ของผู้ใช้\\n" + personalityPrompt(settings)',
  '    + "\\nกฎที่ผู้ใช้ตั้งไว้:\\n" + rules',
  '    + "\\n" + (settings.custom_instructions || "ตอบเป็นภาษาเดียวกับผู้ใช้ โดยใช้ภาษาไทยเป็นค่าเริ่มต้น")',
  '    + "\\nนี่เป็นคำถามทั่วไปที่ไม่ต้องใช้เว็บหรือเครื่องมือ ตอบตรงคำถามทันทีโดยใช้บริบทบทสนทนาล่าสุด ห้ามเสียรอบเรียก classifier/search/tool planner เพิ่ม และห้ามพูดถึงขั้นตอนตรวจ policy ภายใน";',
  '}',
  '',
].join("\n");
replaceOnce(
  'function completeOllamaResponse(result: { content: string; prompt_tokens: number; response_tokens: number }): Response {',
  helpers + '\nfunction completeOllamaResponse(result: { content: string; prompt_tokens: number; response_tokens: number }): Response {',
  "helper insertion",
);

replaceOnce(
  '  const conversationRoute = classifyConversationTurn(message, { forceSearch: body.force_search === true });\n  const fastPath = conversationRoute.route === "instant";',
  '  const conversationRoute = classifyConversationTurn(message, { forceSearch: body.force_search === true });\n'
    + '  const fastPath = conversationRoute.route === "instant";\n'
    + '  const localPath = conversationRoute.route === "local";\n'
    + '  const runId = typeof body.message_id === "string" ? body.message_id : savedUser?.id || crypto.randomUUID();\n'
    + '  await startAgentRun(runId, chat.id, localPath ? "กำลังตอบคำถามทั่วไป" : "กำลังวิเคราะห์คำขอ");',
  "route flags",
);

replaceOnce(
  '  let learnedSkills: LearnedSkillSummary[] = [];\n  if (!fastPath) {',
  '  let learnedSkills: LearnedSkillSummary[] = [];\n  if (!fastPath && !localPath) {',
  "learned-skill local bypass",
);

replaceOnce(
  '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: policy.reason, metadata: { error: true } });',
  '    await finishAgentRun(runId, "blocked", "คำขอถูกบล็อกโดย Settings", policy.reason);\n'
    + '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: policy.reason, metadata: { error: true } });',
  "policy run state",
);

replaceOnce(
  '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { fast_path: true }, promptTokens: 0, responseTokens });\n    return immediateStream([',
  '    await finishAgentRun(runId, "completed", "ตอบเสร็จแล้ว");\n'
    + '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { fast_path: true }, promptTokens: 0, responseTokens });\n'
    + '    return immediateStream([',
  "instant run state",
);

const recentOld = '  const recentStored = await listRecentChatMessages(chat.id, 12);\n'
  + '  const recentMessagesAll = body.chat_id ? recentStored.map(({ role, content }) => ({ role, content })) : (legacyMessages.length ? legacyMessages : recentStored.map(({ role, content }) => ({ role, content })));';
const recentNew = [
  '  const recentStored = await listRecentChatMessages(chat.id, 12);',
  '  if (artifactLocationQuestion(message)) {',
  '    const recentArtifacts = [...recentStored].reverse().flatMap((item) => item.role === "assistant" ? (item.metadata.artifacts ?? []) : []);',
  '    if (recentArtifacts.length) {',
  '      const artifacts = recentArtifacts.slice(0, 12);',
  '      const reply = artifactLocationText(artifacts);',
  '      await finishAgentRun(runId, "completed", "ตอบตำแหน่งไฟล์จาก Artifact record แล้ว");',
  '      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { artifacts }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });',
  '      return immediateStream([',
  '        ...baseEvents,',
  '        { type: "status", payload: { stage: "artifact", label: "อ่านตำแหน่งไฟล์จาก Artifact record" } },',
  '        { type: "artifact", payload: { artifacts } },',
  '        { type: "token", payload: { text: reply } },',
  '        ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []),',
  '        { type: "done", payload: {} },',
  '      ]);',
  '    }',
  '  }',
  '  const recentMessagesAll = body.chat_id ? recentStored.map(storedMessageForModel) : (legacyMessages.length ? legacyMessages : recentStored.map(storedMessageForModel));',
].join("\n");
replaceOnce(recentOld, recentNew, "artifact-grounded recent context");

replaceOnce('  if (matchedLearnedSkill && directSkillInput) {', '  if (!localPath && matchedLearnedSkill && directSkillInput) {', "direct skill bypass");

replaceOnce(
  '  if (!fastPath && !directRead && !wantsBrowser(message) && !wantsSearch && settings.web_search_enabled) {',
  '  if (!fastPath && !localPath && !directRead && !wantsBrowser(message) && !wantsSearch && settings.web_search_enabled) {',
  "search classifier bypass",
);

replaceOnce(
  '  const authorizedSecurityTurn = authorizedSecurity && currentWifiIntent && !fastPath;',
  '  const authorizedSecurityTurn = authorizedSecurity && !fastPath && !localPath;',
  "authorized security route",
);

replaceOnce(
  '  const deterministicWifiCapabilityGap = authorizedSecurityTurn && !hasInstalledWifiSkill;',
  '  const deterministicWifiCapabilityGap = false; // beta4: inspect actual Mac/tooling; never use the canned capability answer.',
  "disable canned Wi-Fi fallback",
);

replaceOnce(
  '  const memories = !fastPath && settings.memory_enabled ? await findRelevantMemories(message, settings.memory_retrieval_limit || 5000) : [];\n'
    + '  const priorSummaries = !fastPath && settings.memory_enabled && settings.cross_chat_memory_enabled ? await findRelevantChatSummaries(message, chat.id, 3) : [];',
  '  const memories = !fastPath && !localPath && settings.memory_enabled ? await findRelevantMemories(message, settings.memory_retrieval_limit || 5000) : [];\n'
    + '  const priorSummaries = !fastPath && !localPath && settings.memory_enabled && settings.cross_chat_memory_enabled ? await findRelevantChatSummaries(message, chat.id, 3) : [];',
  "memory local bypass",
);

const systemLine = '  let systemPrompt = fastPath ? buildFastSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);';
replaceOnce(
  systemLine,
  '  let systemPrompt = fastPath ? buildFastSystemPrompt(settings) : localPath ? buildLocalSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);',
  "initial local prompt",
);

replaceOnce(
  '  if (shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {',
  '  if (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {\n'
    + '    await updateAgentRun(runId, { status: "running", stage: "planning", label: "กำลังวางแผน workflow ให้จบทั้งงาน" });',
  "tool planner state",
);

replaceOnce(
  '        const name = call.function.name;\n'
    + '        const args = call.function.arguments ?? {};\n'
    + '        toolEvents.push({ type: "tool_status", payload: { tool: name, label: TOOL_LABELS[name] ?? `กำลังใช้ ${name}` } });',
  '        const name = call.function.name;\n'
    + '        const args = call.function.arguments ?? {};\n'
    + '        const toolLabel = TOOL_LABELS[name] ?? ("กำลังใช้ " + name);\n'
    + '        await updateAgentRun(runId, { status: "running", stage: "tool", label: toolLabel, tool: name });\n'
    + '        toolEvents.push({ type: "tool_status", payload: { tool: name, label: toolLabel } });',
  "tool run state",
);

replaceOnce(
  '          toolEvents.push({ type: "permission_required", payload: { confirmation_id: result.confirmation_id, summary: result.summary, tool: name } });\n'
    + '          waitingForPermission = true;',
  '          toolEvents.push({ type: "permission_required", payload: { confirmation_id: result.confirmation_id, summary: result.summary, tool: name, run_id: runId } });\n'
    + '          await updateAgentRun(runId, { status: "waiting_approval", stage: "approval", label: String(result.summary || "รอการอนุญาตจากผู้ใช้"), detail: "งานยังไม่เสร็จและจะทำต่ออัตโนมัติหลังอนุญาต", tool: name });\n'
    + '          waitingForPermission = true;',
  "approval run state",
);

replaceOnce(
  '        const pendingText = "อัลฟ่าพร้อมทำงานนี้แล้ว แต่ต้องได้รับอนุญาตจากคุณก่อน";',
  '        const pendingText = "⏸ WAITING_APPROVAL — งานยังไม่เสร็จ อัลฟ่ารอการอนุญาตขั้นนี้และจะทำงานเดิมต่ออัตโนมัติหลังได้รับอนุญาต";',
  "approval message",
);

replaceOnce(
  '  systemPrompt = fastPath ? buildFastSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);',
  '  systemPrompt = fastPath ? buildFastSystemPrompt(settings) : localPath ? buildLocalSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);\n'
    + '  await updateAgentRun(runId, { status: "running", stage: "responding", label: localPath ? "กำลังตอบจากโมเดลในเครื่อง" : "กำลังสรุปผล workflow" });',
  "final prompt and run state",
);

const failureOld = '    const failure = `เชื่อมต่อโมเดล ${settings.model} ไม่สำเร็จ กรุณาเปิด Ollama และติดตั้งด้วยคำสั่ง: ollama pull ${settings.model}`;\n'
  + '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });';
const failureNew = '    const failure = "เชื่อมต่อโมเดล " + settings.model + " ไม่สำเร็จ กรุณาเปิด Ollama และติดตั้งด้วยคำสั่ง: ollama pull " + settings.model;\n'
  + '    await finishAgentRun(runId, "failed", "เชื่อมต่อโมเดลไม่สำเร็จ", failure);\n'
  + '    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });';
replaceOnce(failureOld, failureNew, "model failure state");

const finalOld = '        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));\n'
  + '        const artifacts = toolEvents.flatMap((item) => item.type === "artifact" && Array.isArray(item.payload.artifacts) ? item.payload.artifacts as ArtifactRecord[] : []);\n'
  + '        const savedAssistant = await appendMessage({ id: assistantId, chatId: chat.id, role: "assistant", content: assistantText.trim() || (artifacts.length ? "ดำเนินการเรียบร้อยแล้ว" : ""), metadata: { sources, artifacts, searched: wantsSearch || directRead, search_backend: searchBackend, tool_events: toolEvents.map(({ type, payload }) => ({ type, ...payload })) }, promptTokens, responseTokens });';
const finalNew = [
  '        const artifacts = toolEvents.flatMap((item) => item.type === "artifact" && Array.isArray(item.payload.artifacts) ? item.payload.artifacts as ArtifactRecord[] : []);',
  '        const locationBlock = artifactLocationText(artifacts);',
  '        if (locationBlock && !assistantText.includes(locationBlock)) {',
  '          const suffix = (assistantText.trim() ? "\\n\\n" : "") + locationBlock;',
  '          assistantText += suffix;',
  '          controller.enqueue(event("token", { text: suffix }));',
  '        }',
  '        if (toolEvents.length && !assistantText.includes("สถานะ: ✅ COMPLETED")) {',
  '          const completed = (assistantText.trim() ? "\\n\\n" : "") + "สถานะ: ✅ COMPLETED";',
  '          assistantText += completed;',
  '          controller.enqueue(event("token", { text: completed }));',
  '        }',
  '        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));',
  '        await finishAgentRun(runId, "completed", toolEvents.length ? "workflow เสร็จสมบูรณ์" : "ตอบเสร็จแล้ว");',
  '        const savedAssistant = await appendMessage({ id: assistantId, chatId: chat.id, role: "assistant", content: assistantText.trim() || (artifacts.length ? "ดำเนินการเรียบร้อยแล้ว" : ""), metadata: { sources, artifacts, searched: wantsSearch || directRead, search_backend: searchBackend, tool_events: toolEvents.map(({ type, payload }) => ({ type, ...payload })) }, promptTokens, responseTokens });',
].join("\n");
replaceOnce(finalOld, finalNew, "artifact paths and completion");

replaceOnce(
  '      } catch {\n        controller.enqueue(event("error", { message: "การเชื่อมต่อกับโมเดลถูกตัดระหว่างตอบ" }));',
  '      } catch {\n        await finishAgentRun(runId, "failed", "การเชื่อมต่อถูกตัดระหว่างตอบ");\n'
    + '        controller.enqueue(event("error", { message: "การเชื่อมต่อกับโมเดลถูกตัดระหว่างตอบ" }));',
  "stream failure state",
);

const temporary = routePath + ".beta4-v2.tmp";
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, routePath);
console.log("Applied Alpha beta4 chat runtime v2");
