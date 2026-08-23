import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const routePath = resolve(appDir, "app", "api", "chat", "route.ts");
let source = await fs.readFile(routePath, "utf8");
const marker = "alpha-beta4-agent-loop-v1";

if (source.includes(marker)) {
  console.log("Alpha beta4 chat runtime patch already applied");
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `import { addMemory, findRelevantMemories } from "@/lib/memory-store";`,
  `import { addMemory, findRelevantMemories } from "@/lib/memory-store";\nimport { finishAgentRun, startAgentRun, updateAgentRun } from "@/lib/agent-run-store";`,
  "agent-run-store import",
);

replaceOnce(
  `function shouldPlanTools(message: string, directRead: boolean, browserHandled: boolean, learnedSkills: LearnedSkillSummary[]): boolean {\n  const fileIntent = /(สร้าง|ทำ|เขียน|บันทึก|ส่งออก|ดาวน์โหลด|download|create|save).{0,40}(ไฟล์|โปรแกรม|โค้ด|project|\\.py|\\.js|\\.html|\\.json)|(?:อ่าน|แก้|ย้าย|บีบอัด|zip|ลบ|เปิด).{0,30}(?:ไฟล์|finder)|รันไฟล์|run file/i.test(message);\n  const apiDiscoveryIntent = /(devtools|network tab|api|endpoint|xhr|fetch|graphql).{0,50}(หา|ค้น|จับ|ดู|วิเคราะห์|ทดสอบ|ยิง|discover|inspect|probe)|(?:หา|ค้น|จับ|วิเคราะห์|ทดสอบ|ยิง).{0,50}(?:api|endpoint|xhr|fetch|graphql)/i.test(message);\n  return fileIntent || apiDiscoveryIntent || matchesLearnedSkill(message, learnedSkills) || (wantsBrowser(message) && !browserHandled) || (!directRead && !browserHandled && /https?:\\/\\//i.test(message));\n}`,
  `function shouldPlanTools(message: string, directRead: boolean, browserHandled: boolean, learnedSkills: LearnedSkillSummary[]): boolean {\n  const fileIntent = /(สร้าง|ทำ|เขียน|บันทึก|ส่งออก|ดาวน์โหลด|download|create|save).{0,40}(ไฟล์|โปรแกรม|โค้ด|project|\\.py|\\.js|\\.html|\\.json)|(?:อ่าน|แก้|ย้าย|บีบอัด|zip|ลบ|เปิด).{0,30}(?:ไฟล์|finder)|รันไฟล์|run file/i.test(message);\n  const apiDiscoveryIntent = /(devtools|network tab|api|endpoint|xhr|fetch|graphql).{0,50}(หา|ค้น|จับ|ดู|วิเคราะห์|ทดสอบ|ยิง|discover|inspect|probe)|(?:หา|ค้น|จับ|วิเคราะห์|ทดสอบ|ยิง).{0,50}(?:api|endpoint|xhr|fetch|graphql)/i.test(message);\n  const securityIntent = /(wifi|wi-fi|wireless|security|cyber|pentest|hack|ช่องโหว่|เครือข่าย|รหัสผ่าน|password|audit)/i.test(message)\n    && /(ตรวจ|ทดสอบ|สร้าง|ทำ|วิเคราะห์|สแกน|หา|run|test|audit|scan|build|create)/i.test(message);\n  return fileIntent || apiDiscoveryIntent || securityIntent || matchesLearnedSkill(message, learnedSkills) || (wantsBrowser(message) && !browserHandled) || (!directRead && !browserHandled && /https?:\\/\\//i.test(message));\n}`,
  "shouldPlanTools",
);

const helperNeedle = `function completeOllamaResponse(result: { content: string; prompt_tokens: number; response_tokens: number }): Response {`;
const helpers = `// ${marker}\nfunction artifactLocationQuestion(message: string): boolean {\n  return /(?:ไฟล์|โปรแกรม|project|artifact).{0,35}(?:อยู่ไหน|ไว้ไหน|ที่ไหน|path|พาธ|folder|โฟลเดอร์)|(?:อยู่ไหน|ไว้ไหน|ที่ไหน|path|พาธ).{0,35}(?:ไฟล์|โปรแกรม|project|artifact)/i.test(message);\n}\n\nfunction artifactLocationText(artifacts: ArtifactRecord[]): string {\n  if (!artifacts.length) return "";\n  const unique = artifacts.filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index);\n  return ["📁 ตำแหน่งไฟล์จริง:", ...unique.map((item) => `- ${item.name}: \\`${item.path}\\``)].join("\\n");\n}\n\nfunction storedMessageForModel(item: { role: "user" | "assistant"; content: string; metadata?: { artifacts?: ArtifactRecord[] } }) {\n  const locations = item.role === "assistant" ? artifactLocationText(item.metadata?.artifacts ?? []) : "";\n  return { role: item.role, content: [item.content, locations ? `\\n\\n[Artifact record จากระบบ]\\n${locations}` : ""].filter(Boolean).join("") };\n}\n\nfunction buildLocalSystemPrompt(settings: AppSettings) {\n  const rules = settings.core_rules.map((rule, index) => `${index + 1}. ${rule}`).join("\\n");\n  return `คุณคือ “อัลฟ่า” ผู้ช่วย AI ส่วนตัวบน Mac ของผู้ใช้\\n${personalityPrompt(settings)}\\nกฎที่ผู้ใช้ตั้งไว้:\\n${rules}\\n${settings.custom_instructions || "ตอบเป็นภาษาเดียวกับผู้ใช้ โดยใช้ภาษาไทยเป็นค่าเริ่มต้น"}\\nนี่เป็นคำถามทั่วไปที่ไม่ต้องใช้เว็บหรือเครื่องมือ ตอบตรงคำถามทันทีโดยใช้บริบทบทสนทนาล่าสุด ห้ามเสียรอบเรียก classifier/search/tool planner เพิ่ม และห้ามพูดถึงขั้นตอนตรวจ policy ภายใน`;\n}\n\n`;
replaceOnce(helperNeedle, `${helpers}${helperNeedle}`, "helper insertion point");

replaceOnce(
  `  const conversationRoute = classifyConversationTurn(message, { forceSearch: body.force_search === true });\n  const fastPath = conversationRoute.route === "instant";`,
  `  const conversationRoute = classifyConversationTurn(message, { forceSearch: body.force_search === true });\n  const fastPath = conversationRoute.route === "instant";\n  const localPath = conversationRoute.route === "local";\n  const runId = typeof body.message_id === "string" ? body.message_id : savedUser?.id || crypto.randomUUID();\n  await startAgentRun(runId, chat.id, localPath ? "กำลังตอบคำถามทั่วไป" : "กำลังวิเคราะห์คำขอ");`,
  "route flags",
);

replaceOnce(
  `  let learnedSkills: LearnedSkillSummary[] = [];\n  if (!fastPath) {`,
  `  let learnedSkills: LearnedSkillSummary[] = [];\n  if (!fastPath && !localPath) {`,
  "learned-skill fast bypass",
);

replaceOnce(
  `    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: policy.reason, metadata: { error: true } });`,
  `    await finishAgentRun(runId, "blocked", "คำขอถูกบล็อกโดย Settings", policy.reason);\n    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: policy.reason, metadata: { error: true } });`,
  "policy finish state",
);

replaceOnce(
  `    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { fast_path: true }, promptTokens: 0, responseTokens });\n    return immediateStream([`,
  `    await finishAgentRun(runId, "completed", "ตอบเสร็จแล้ว");\n    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { fast_path: true }, promptTokens: 0, responseTokens });\n    return immediateStream([`,
  "instant completion state",
);

replaceOnce(
  `  const recentStored = await listRecentChatMessages(chat.id, 12);\n  const recentMessagesAll = body.chat_id ? recentStored.map(({ role, content }) => ({ role, content })) : (legacyMessages.length ? legacyMessages : recentStored.map(({ role, content }) => ({ role, content })));`,
  `  const recentStored = await listRecentChatMessages(chat.id, 12);\n  if (artifactLocationQuestion(message)) {\n    const recentArtifacts = [...recentStored].reverse().flatMap((item) => item.role === "assistant" ? (item.metadata.artifacts ?? []) : []);\n    if (recentArtifacts.length) {\n      const reply = artifactLocationText(recentArtifacts.slice(0, 12));\n      await finishAgentRun(runId, "completed", "ตอบตำแหน่งไฟล์จาก Artifact record แล้ว");\n      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { artifacts: recentArtifacts.slice(0, 12) }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });\n      return immediateStream([\n        ...baseEvents,\n        { type: "status", payload: { stage: "artifact", label: "อ่านตำแหน่งไฟล์จาก Artifact record" } },\n        { type: "token", payload: { text: reply } },\n        ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []),\n        { type: "done", payload: {} },\n      ]);\n    }\n  }\n  const recentMessagesAll = body.chat_id ? recentStored.map(storedMessageForModel) : (legacyMessages.length ? legacyMessages : recentStored.map(storedMessageForModel));`,
  "artifact grounded recent context",
);

replaceOnce(
  `  if (matchedLearnedSkill && directSkillInput) {`,
  `  if (!localPath && matchedLearnedSkill && directSkillInput) {`,
  "direct skill local bypass",
);

replaceOnce(
  `  if (!fastPath && !directRead && !wantsBrowser(message) && !wantsSearch && settings.web_search_enabled) {`,
  `  if (!fastPath && !localPath && !directRead && !wantsBrowser(message) && !wantsSearch && settings.web_search_enabled) {`,
  "search classifier local bypass",
);

replaceOnce(
  `  const authorizedSecurityTurn = authorizedSecurity && currentWifiIntent && !fastPath;`,
  `  const authorizedSecurityTurn = authorizedSecurity && !fastPath && !localPath;`,
  "general authorized security routing",
);

replaceOnce(
  `  const deterministicWifiCapabilityGap = authorizedSecurityTurn && !hasInstalledWifiSkill;`,
  `  const deterministicWifiCapabilityGap = false; // beta4: never short-circuit into a canned capability answer; inspect the Mac/tooling instead.`,
  "disable canned wifi fallback",
);

replaceOnce(
  `  const memories = !fastPath && settings.memory_enabled ? await findRelevantMemories(message, settings.memory_retrieval_limit || 5000) : [];\n  const priorSummaries = !fastPath && settings.memory_enabled && settings.cross_chat_memory_enabled ? await findRelevantChatSummaries(message, chat.id, 3) : [];`,
  `  const memories = !fastPath && !localPath && settings.memory_enabled ? await findRelevantMemories(message, settings.memory_retrieval_limit || 5000) : [];\n  const priorSummaries = !fastPath && !localPath && settings.memory_enabled && settings.cross_chat_memory_enabled ? await findRelevantChatSummaries(message, chat.id, 3) : [];`,
  "memory local bypass",
);

replaceOnce(
  `  let systemPrompt = fastPath ? buildFastSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);`,
  `  let systemPrompt = fastPath ? buildFastSystemPrompt(settings) : localPath ? buildLocalSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);`,
  "initial local prompt",
);

replaceOnce(
  `  if (shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {`,
  `  if (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {\n    await updateAgentRun(runId, { status: "running", stage: "planning", label: "กำลังวางแผน workflow ให้จบทั้งงาน" });`,
  "tool planning task state",
);

replaceOnce(
  `        if (!(planned.tool_calls?.length) && iteration === 0 && /(สร้าง|บันทึก|save|create).{0,30}(ไฟล์|โปรแกรม|project|\\.py|\\.js|\\.html)/i.test(message)) {\n          conversation.push({ role: "system", content: "คำขอนี้ต้องสร้างไฟล์จริง กรุณาเรียก create_files พร้อมเนื้อหาไฟล์ที่สมบูรณ์ ห้ามตอบเป็นข้อความอย่างเดียว" });\n          continue;\n        }`,
  `        if (!(planned.tool_calls?.length) && iteration === 0 && /(สร้าง|บันทึก|save|create).{0,30}(ไฟล์|โปรแกรม|project|\\.py|\\.js|\\.html)/i.test(message)) {\n          conversation.push({ role: "system", content: "คำขอนี้ต้องสร้างไฟล์จริง กรุณาเรียก create_files พร้อมเนื้อหาไฟล์ที่สมบูรณ์ ห้ามตอบเป็นข้อความอย่างเดียว" });\n          continue;\n        }\n        if (!(planned.tool_calls?.length) && iteration === 0 && authorizedSecurityTurn) {\n          conversation.push({ role: "system", content: "นี่เป็นงาน security ที่ได้รับอนุญาตและผู้ใช้สั่งให้ลงมือ ให้เริ่มจาก system_capability เพื่อตรวจ Mac/เครื่องมือจริง แล้วดำเนิน workflow ต่อเอง ห้ามตอบเป็นรายการสิ่งที่จะทำแล้วหยุด หากพบ dependency หลายตัวให้ใช้ install_packages ขออนุญาตครั้งเดียว" });\n          continue;\n        }`,
  "security proactive retry",
);

replaceOnce(
  `        const name = call.function.name;\n        const args = call.function.arguments ?? {};\n        toolEvents.push({ type: "tool_status", payload: { tool: name, label: TOOL_LABELS[name] ?? \`กำลังใช้ ${name}\` } });`,
  `        const name = call.function.name;\n        const args = call.function.arguments ?? {};\n        const toolLabel = TOOL_LABELS[name] ?? \`กำลังใช้ ${name}\`;\n        await updateAgentRun(runId, { status: "running", stage: "tool", label: toolLabel, tool: name });\n        toolEvents.push({ type: "tool_status", payload: { tool: name, label: toolLabel } });`,
  "tool live task state",
);

replaceOnce(
  `          toolEvents.push({ type: "permission_required", payload: { confirmation_id: result.confirmation_id, summary: result.summary, tool: name } });\n          waitingForPermission = true;`,
  `          toolEvents.push({ type: "permission_required", payload: { confirmation_id: result.confirmation_id, summary: result.summary, tool: name, run_id: runId } });\n          await updateAgentRun(runId, { status: "waiting_approval", stage: "approval", label: String(result.summary || "รอการอนุญาตจากผู้ใช้"), detail: "งานยังไม่เสร็จและจะทำต่ออัตโนมัติหลังอนุญาต", tool: name });\n          waitingForPermission = true;`,
  "permission live state",
);

replaceOnce(
  `        const pendingText = "อัลฟ่าพร้อมทำงานนี้แล้ว แต่ต้องได้รับอนุญาตจากคุณก่อน";`,
  `        const pendingText = "⏸ WAITING_APPROVAL — งานยังไม่เสร็จ อัลฟ่ารอการอนุญาตขั้นนี้และจะทำงานเดิมต่ออัตโนมัติหลังได้รับอนุญาต";`,
  "unambiguous approval text",
);

replaceOnce(
  `  systemPrompt = fastPath ? buildFastSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);`,
  `  systemPrompt = fastPath ? buildFastSystemPrompt(settings) : localPath ? buildLocalSystemPrompt(settings) : buildSystemPrompt(settings, memories, sources, searchError, chat.rolling_summary, priorSummaries, learnedSkills, authorizedSecurityTurn);\n  await updateAgentRun(runId, { status: "running", stage: "responding", label: localPath ? "กำลังตอบจากโมเดลในเครื่อง" : "กำลังสรุปผล workflow" });`,
  "final local prompt and state",
);

replaceOnce(
  `    const failure = \`เชื่อมต่อโมเดล ${settings.model} ไม่สำเร็จ กรุณาเปิด Ollama และติดตั้งด้วยคำสั่ง: ollama pull ${settings.model}\`;\n    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });`,
  `    const failure = \`เชื่อมต่อโมเดล ${settings.model} ไม่สำเร็จ กรุณาเปิด Ollama และติดตั้งด้วยคำสั่ง: ollama pull ${settings.model}\`;\n    await finishAgentRun(runId, "failed", "เชื่อมต่อโมเดลไม่สำเร็จ", failure);\n    const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });`,
  "model error state",
);

replaceOnce(
  `        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));\n        const artifacts = toolEvents.flatMap((item) => item.type === "artifact" && Array.isArray(item.payload.artifacts) ? item.payload.artifacts as ArtifactRecord[] : []);\n        const savedAssistant = await appendMessage({ id: assistantId, chatId: chat.id, role: "assistant", content: assistantText.trim() || (artifacts.length ? "ดำเนินการเรียบร้อยแล้ว" : ""), metadata: { sources, artifacts, searched: wantsSearch || directRead, search_backend: searchBackend, tool_events: toolEvents.map(({ type, payload }) => ({ type, ...payload })) }, promptTokens, responseTokens });`,
  `        const artifacts = toolEvents.flatMap((item) => item.type === "artifact" && Array.isArray(item.payload.artifacts) ? item.payload.artifacts as ArtifactRecord[] : []);\n        const locationBlock = artifactLocationText(artifacts);\n        if (locationBlock && !assistantText.includes(locationBlock)) {\n          const suffix = `${assistantText.trim() ? "\\n\\n" : ""}${locationBlock}`;\n          assistantText += suffix;\n          controller.enqueue(event("token", { text: suffix }));\n        }\n        if (toolEvents.length && !assistantText.includes("สถานะ: ✅ COMPLETED")) {\n          const completed = `${assistantText.trim() ? "\\n\\n" : ""}สถานะ: ✅ COMPLETED`;\n          assistantText += completed;\n          controller.enqueue(event("token", { text: completed }));\n        }\n        controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));\n        await finishAgentRun(runId, "completed", toolEvents.length ? "workflow เสร็จสมบูรณ์" : "ตอบเสร็จแล้ว");\n        const savedAssistant = await appendMessage({ id: assistantId, chatId: chat.id, role: "assistant", content: assistantText.trim() || (artifacts.length ? "ดำเนินการเรียบร้อยแล้ว" : ""), metadata: { sources, artifacts, searched: wantsSearch || directRead, search_backend: searchBackend, tool_events: toolEvents.map(({ type, payload }) => ({ type, ...payload })) }, promptTokens, responseTokens });`,
  "artifact paths and completion marker",
);

replaceOnce(
  `      } catch {\n        controller.enqueue(event("error", { message: "การเชื่อมต่อกับโมเดลถูกตัดระหว่างตอบ" }));`,
  `      } catch {\n        await finishAgentRun(runId, "failed", "การเชื่อมต่อถูกตัดระหว่างตอบ");\n        controller.enqueue(event("error", { message: "การเชื่อมต่อกับโมเดลถูกตัดระหว่างตอบ" }));`,
  "stream failure state",
);

const temporary = `${routePath}.beta4.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, routePath);
console.log("Applied Alpha beta4 chat runtime patch");
