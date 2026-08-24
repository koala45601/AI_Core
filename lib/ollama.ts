import { env } from "cloudflare:workers";
import { AGENT_TOOLS } from "./agent-tools";
import { AppSettings, HealthStatus, SearchResult } from "./types";
import { MemoryRecord } from "./memory-store";
import { redactCredentials } from "./context-routing.js";

interface RuntimeEnv {
  OLLAMA_BASE_URL?: string;
}

export interface OllamaToolCall {
  type?: "function";
  function: { index?: number; name: string; arguments: Record<string, unknown> };
}

export interface OllamaConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
}

function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function baseUrl(): string {
  return (runtimeEnv().OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
}

function timedSignal(timeout: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function ollamaFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
}

export async function decideSearchWithModel(message: string, settings: AppSettings): Promise<boolean> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: { num_ctx: 2048, num_predict: 4, temperature: 0 },
      messages: [
        {
          role: "system",
          content: "Classify whether answering requires fresh web information or knowledge you likely do not have. Reply only SEARCH or LOCAL. Use SEARCH for current facts, named obscure entities, verification requests, or explicit uncertainty. Use LOCAL for writing, reasoning, translation, and stable general knowledge.",
        },
        { role: "user", content: message },
      ],
    }),
  });

  if (!response.ok) return false;
  const payload = await response.json() as { message?: { content?: string } };
  return /SEARCH/i.test(payload.message?.content ?? "");
}

export async function requestChatStream(
  messages: OllamaConversationMessage[],
  settings: AppSettings,
): Promise<Response> {
  return ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      think: false,
      keep_alive: "5m",
      options: {
        num_ctx: settings.max_context_tokens,
        num_predict: settings.max_output_tokens,
        temperature: 0.6,
        top_p: 0.9,
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
}

export async function requestChatOnce(
  messages: OllamaConversationMessage[],
  settings: AppSettings,
  temperature = 0.35,
): Promise<{ content: string; prompt_tokens: number; response_tokens: number }> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: {
        num_ctx: settings.max_context_tokens,
        num_predict: settings.max_output_tokens,
        temperature,
        top_p: 0.9,
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Ollama ตอบกลับด้วยสถานะ ${response.status}`);
  const payload = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  return {
    content: String(payload.message?.content || "").trim(),
    prompt_tokens: Number(payload.prompt_eval_count || 0),
    response_tokens: Number(payload.eval_count || 0),
  };
}

export async function requestToolPlan(
  messages: OllamaConversationMessage[],
  settings: AppSettings,
): Promise<OllamaConversationMessage> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools: AGENT_TOOLS,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: {
        num_ctx: settings.max_context_tokens,
        num_predict: Math.min(settings.max_output_tokens, 1400),
        temperature: 0.1,
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Ollama tool planner ตอบกลับ ${response.status}`);
  const data = await response.json() as { message?: OllamaConversationMessage };
  return data.message ?? { role: "assistant", content: "" };
}

export async function extractDurableMemory(
  userMessage: string,
  assistantMessage: string,
  settings: AppSettings,
): Promise<string | null> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: { num_ctx: 2048, num_predict: 120, temperature: 0 },
      messages: [
        {
          role: "system",
          content: "Extract one durable user fact, preference, project detail, or correction that would be useful in future chats. Never save passwords, credentials, financial identifiers, private addresses, medical secrets, or transient questions. Reply with a concise Thai memory only, or exactly NONE if nothing is worth remembering.",
        },
        { role: "user", content: `USER: ${userMessage}\nASSISTANT: ${assistantMessage.slice(0, 3000)}` },
      ],
    }),
  });

  if (!response.ok) return null;
  const payload = await response.json() as { message?: { content?: string } };
  const memory = payload.message?.content?.trim();
  if (!memory || /^NONE[.!]?$/i.test(memory)) return null;
  return memory.slice(0, 1000);
}

export interface ExtractedMemory {
  content: string;
  category: MemoryRecord["category"];
  confidence: number;
}

export async function extractDurableMemories(
  userMessage: string,
  assistantMessage: string,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<ExtractedMemory[]> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "5m",
      options: { num_ctx: 3072, num_predict: 500, temperature: 0 },
      messages: [
        {
          role: "system",
          content: `คัดเลือกความจำระยะยาวจากบทสนทนา${settings.memory_extract_limit ? `ไม่เกิน ${settings.memory_extract_limit} รายการ` : "โดยไม่จำกัดจำนวนตายตัว"} ได้แก่ โปรไฟล์ ความชอบ โปรเจกต์ หรือคำแก้ไขของผู้ใช้
ห้ามเก็บรหัสผ่าน OTP เลขบัตร token, API key, private key, ที่อยู่ละเอียด ข้อมูลการเงิน หรือคำถามชั่วคราว
ตอบ JSON เท่านั้น: {"memories":[{"content":"ข้อความสั้นภาษาไทย","category":"profile|preference|project|correction|general","confidence":0}]}
หากไม่มีสิ่งควรจำให้ตอบ {"memories":[]}`,
        },
        { role: "user", content: `ผู้ใช้: ${userMessage.slice(0, 5000)}\nอัลฟ่า: ${assistantMessage.slice(0, 5000)}` },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!response.ok) return [];
  const payload = await response.json() as { message?: { content?: string } };
  try {
    const parsed = JSON.parse(payload.message?.content ?? "{}") as { memories?: Array<Record<string, unknown>> };
    const categories = new Set(["general", "profile", "preference", "project", "correction"]);
    return (parsed.memories ?? []).filter((item) => typeof item.content === "string" && item.content.trim())
      .slice(0, settings.memory_extract_limit || undefined).map((item) => ({
        content: String(item.content).trim().slice(0, 1000),
        category: (categories.has(String(item.category)) ? String(item.category) : "general") as MemoryRecord["category"],
        confidence: Math.min(100, Math.max(0, Number(item.confidence) || 70)),
      }));
  } catch {
    return [];
  }
}

export async function summarizeChat(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  existingSummary: string,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<string> {
  if (!messages.length) return existingSummary;
  const transcript = messages.map((item) => `${item.role === "user" ? "ผู้ใช้" : "อัลฟ่า"}: ${redactCredentials(item.content)}`).join("\n\n");
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: { num_ctx: Math.min(settings.max_context_tokens, 6144), num_predict: 900, temperature: 0.1 },
      messages: [
        {
          role: "system",
          content: "สรุปบทสนทนาเป็นภาษาไทยแบบกระชับเพื่อให้ผู้ช่วยใช้ต่อในอนาคต เก็บเป้าหมาย การตัดสินใจ ความชอบ ข้อจำกัด งานที่ทำแล้ว และงานค้าง ห้ามเดาข้อมูลและห้ามเก็บรหัสผ่าน OTP เลขบัตรหรือข้อมูลลับ ตอบเฉพาะบทสรุป",
        },
        { role: "user", content: `สรุปเดิม:\n${redactCredentials(existingSummary) || "ยังไม่มี"}\n\nข้อความใหม่:\n${transcript.slice(0, 18_000)}` },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`สรุปแชตไม่สำเร็จ (${response.status})`);
  const payload = await response.json() as { message?: { content?: string } };
  return (payload.message?.content ?? existingSummary).trim().slice(0, 12_000);
}

export interface ResearchSynthesis {
  summary: string;
  gaps: string[];
  next_query: string;
  confidence: number;
  prompt_tokens: number;
  response_tokens: number;
}

export interface SkillTestCase {
  name: string;
  input: Record<string, unknown>;
  stdout_contains: string;
  expected_files: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  runtime: "python" | "node";
  entrypoint: string;
  dependencies: string[];
  trigger_examples: string[];
  test_cases: SkillTestCase[];
}

export interface SkillPlanResult {
  status: "ready" | "blocked";
  reason: string;
  skill?: SkillDefinition;
  prompt_tokens: number;
  response_tokens: number;
}

export interface SkillBuildResult {
  files: Array<{ path: string; content: string }>;
  notes: string;
  blocked_reason: string;
  prompt_tokens: number;
  response_tokens: number;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("โมเดลไม่ได้ส่งแผนสกิลเป็น JSON");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function normalizePlannedSkill(value: unknown, testLimit: number): SkillDefinition | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!new Set(["python", "node"]).has(String(raw.runtime))) return null;
  const rawTests = Array.isArray(raw.test_cases) ? raw.test_cases
    : Array.isArray(raw.tests) ? raw.tests
      : Array.isArray(raw.trigger_examples) ? raw.trigger_examples.filter((item) => item && typeof item === "object") : [];
  const tests = rawTests.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const test = item as Record<string, unknown>;
    return Boolean(String(test.stdout_contains || test.expected_output_contains || test.expected_stdout_contains || "").trim())
      || (Array.isArray(test.expected_files) && test.expected_files.length > 0);
  }).slice(0, testLimit || undefined).map((item, index) => {
    const test = item as Record<string, unknown>;
    const input = test.input && typeof test.input === "object" ? test.input as Record<string, unknown> : {};
    let stdoutContains = String(test.stdout_contains || test.expected_output_contains || test.expected_stdout_contains || "").slice(0, 500);
    const lineExpectation = stdoutContains.match(/Line\s+(\d+).*?\b(eval|exec|os\.system|subprocess|pickle\.loads)\b/i);
    const source = Object.values(input).find((item): item is string => typeof item === "string" && item.includes("\n"));
    if (lineExpectation && source) {
      const needle = lineExpectation[2].toLowerCase();
      const actualLine = source.split("\n").findIndex((line) => line.toLowerCase().includes(needle));
      if (actualLine >= 0) stdoutContains = stdoutContains.replace(/Line\s+\d+/i, `Line ${actualLine + 1}`);
    }
    return {
      name: String(test.name || `test-${index + 1}`).slice(0, 100),
      input,
      stdout_contains: stdoutContains,
      expected_files: Array.isArray(test.expected_files) ? test.expected_files.map(String).slice(0, 10) : [],
    };
  });
  if (!tests.length) return null;
  const runtime = String(raw.runtime) as "python" | "node";
  return {
    id: String(raw.id || "alpha-skill").slice(0, 80),
    name: String(raw.name || "Alpha Skill").slice(0, 100),
    description: String(raw.description || "").slice(0, 1000),
    runtime,
    entrypoint: String(raw.entrypoint || (runtime === "python" ? "main.py" : "index.js")),
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String).slice(0, 6) : [runtime === "python" ? "python-stdlib" : "node-stdlib"],
    trigger_examples: Array.isArray(raw.trigger_examples) ? raw.trigger_examples.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    test_cases: tests,
  };
}

export async function designSkillGoal(
  objective: string,
  successCriteria: string,
  evidence: SearchResult[],
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<SkillPlanResult> {
  const sourceText = evidence.slice(0, settings.search_result_limit || undefined).map((item) => `- ${item.title}: ${item.snippet}\n${item.url}`).join("\n\n");
  const systemPrompt = `คุณเป็นสถาปนิก Skill Lab ของอัลฟ่า ออกแบบสเปกทักษะที่ทดสอบได้และรันแบบออฟไลน์ใน Docker
runtime ที่ใช้ได้: python หรือ node
trusted dependency ids ที่ใช้ได้เท่านั้น: python-stdlib, python-pillow, python-numpy, node-stdlib
โปรแกรมต้องรับ JSON จาก argv[1], ใช้ ALPHA_OUTPUT_DIR หากต้องสร้างไฟล์, ห้ามใช้ network ระหว่างรัน
อนุญาตงาน cybersecurity เต็มรูปแบบเมื่อเป้าหมายระบุว่าเป็นโปรแกรมของผู้ใช้หรือ lab: code audit, fuzzing, static analysis, สร้าง proof-of-concept ใน sandbox และ regression test
หากเป้าหมายภายนอกไม่ได้รับอนุญาต ให้ออกแบบ lab จำลองที่ทดสอบเทคนิคได้โดยไม่แตะระบบจริง
test_cases เป็น field บังคับ ต้องมีอย่างน้อย 2 รายการ${settings.skill_test_case_limit ? `และไม่เกิน ${settings.skill_test_case_limit} รายการ` : "โดยไม่มีเพดานตายตัว"}จากเกณฑ์ผู้ใช้ แต่ละรายการต้องมี stdout_contains ที่ไม่ว่าง หรือ expected_files ที่ระบุชื่อไฟล์จริง
trigger_examples ต้องเป็น array ของข้อความเท่านั้น เช่น ["คำนวณค่าเฉลี่ยให้หน่อย"] ห้ามใส่ object
	หากเป้าหมายกล่าวถึงเครื่องมือที่ยังไม่มี ให้พยายามสร้าง learned tool ที่ให้ผลเทียบเท่าด้วย standard library หรือ dependency ที่มีใน catalog ก่อน เพื่อให้อัลฟ่าเพิ่มความสามารถและเรียกซ้ำได้เอง
	ถ้าต้องใช้โมเดล/โปรแกรมภายนอกที่ไม่มีใน catalog และทำอย่างซื่อสัตย์ไม่ได้จริง จึงค่อยให้ status=blocked พร้อมระบุ capability gap ที่ชัดเจน ห้ามสร้างผลปลอม
ตอบ JSON เท่านั้น: {"status":"ready|blocked","reason":"...","skill":{"id":"english-kebab-case","name":"...","description":"...","runtime":"python|node","entrypoint":"main.py|index.js","dependencies":["..."],"trigger_examples":["ข้อความตัวอย่าง"],"test_cases":[{"name":"...","input":{},"stdout_contains":"ข้อความตรวจสอบ","expected_files":[]}]}}`;
  let repair = "";
  let promptTokens = 0;
  let responseTokens = 0;
  for (let planAttempt = 1; planAttempt <= 3; planAttempt += 1) {
    const response = await ollamaFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        think: false,
        format: "json",
        keep_alive: "5m",
        options: { num_ctx: settings.max_context_tokens, num_predict: Math.min(2600, settings.max_output_tokens + 1000), temperature: planAttempt === 1 ? 0.15 : 0 },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `เป้าหมาย:\n${objective}\n\nเกณฑ์สำเร็จ:\n${successCriteria || "ทำตามเป้าหมายได้จริงและผลทดสอบตรวจซ้ำได้"}\n\nข้อมูลจากเว็บ (อาจไม่มี):\n${sourceText || "ไม่มี"}${repair}` },
        ],
      }),
      signal: timedSignal(180_000, signal),
    });
    if (!response.ok) throw new Error(`ออกแบบสกิลไม่สำเร็จ (${response.status})`);
    const payload = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    promptTokens += payload.prompt_eval_count ?? 0;
    responseTokens += payload.eval_count ?? 0;
    let parsed: Record<string, unknown>;
    try { parsed = parseJsonObject(payload.message?.content ?? "{}"); } catch {
      repair = "\n\nคำตอบก่อนหน้าไม่ใช่ JSON ที่ parse ได้ กรุณาส่ง JSON ใหม่ทั้งก้อนตาม schema เท่านั้น";
      continue;
    }
    if (parsed.status === "blocked") return { status: "blocked", reason: String(parsed.reason || "เป้าหมายต้องใช้เครื่องมือที่ไม่อนุญาต").slice(0, 2000), prompt_tokens: promptTokens, response_tokens: responseTokens };
    const skill = normalizePlannedSkill(parsed.skill, settings.skill_test_case_limit);
    if (skill) return { status: "ready", reason: String(parsed.reason || "").slice(0, 2000), skill, prompt_tokens: promptTokens, response_tokens: responseTokens };
    repair = "\n\nแผนก่อนหน้าไม่ผ่าน schema โดยเฉพาะ skill.test_cases ที่หายหรือไม่มีเกณฑ์ตรวจ และ trigger_examples ที่ไม่ใช่ string array กรุณาซ่อมและส่ง JSON ใหม่ทั้งก้อน";
  }
  return { status: "blocked", reason: "โมเดลสร้างสเปก test case ที่ตรวจสอบได้ไม่สำเร็จหลังซ่อมอัตโนมัติ 3 รอบ", prompt_tokens: promptTokens, response_tokens: responseTokens };
}

export async function designHiddenSkillTests(
  objective: string,
  successCriteria: string,
  skill: SkillDefinition,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<{ tests: SkillTestCase[]; prompt_tokens: number; response_tokens: number }> {
  const requested = settings.skill_hidden_test_runs;
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "5m",
      options: { num_ctx: settings.max_context_tokens, num_predict: Math.min(3000, Math.max(1200, settings.max_output_tokens * 2)), temperature: 0.35 },
      messages: [
        {
          role: "system",
          content: `คุณเป็นผู้ตรวจอิสระ สร้าง hidden validation tests สำหรับสกิล โดยผู้เขียนโค้ดจะไม่เห็น test เหล่านี้
เน้น boundary, malformed-but-valid input, Unicode/ภาษาไทย, empty values, large values และ property-like cases ที่ตรวจผลได้แน่นอน
ห้ามเปลี่ยน runtime/dependency และห้ามสร้างเกณฑ์ที่คาดเดาผลไม่ได้
${requested > 0 ? `สร้างไม่เกิน ${requested} รายการ` : "สร้างจำนวนที่จำเป็นต่อการครอบคลุม โดยไม่มีเพดานตายตัวใน Settings"}
ตอบ JSON เท่านั้น: {"test_cases":[{"name":"...","input":{},"stdout_contains":"...","expected_files":[]}]}`,
        },
        { role: "user", content: `เป้าหมาย: ${objective}\nเกณฑ์สำเร็จ: ${successCriteria}\nสเปกสกิล (ยังไม่มี source code):\n${JSON.stringify(skill)}` },
      ],
    }),
    signal: timedSignal(180_000, signal),
  });
  if (!response.ok) throw new Error(`สร้าง hidden tests ไม่สำเร็จ (${response.status})`);
  const payload = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  const parsed = parseJsonObject(payload.message?.content ?? "{}");
  const normalized = normalizePlannedSkill({ ...skill, test_cases: parsed.test_cases }, requested);
  return {
    tests: normalized?.test_cases ?? [],
    prompt_tokens: payload.prompt_eval_count ?? 0,
    response_tokens: payload.eval_count ?? 0,
  };
}

export async function buildSkillAttempt(
  objective: string,
  successCriteria: string,
  skill: SkillDefinition,
  previousFailure: string,
  previousFiles: Array<{ path: string; content: string }>,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<SkillBuildResult> {
  const previousSource = JSON.stringify(previousFiles || []).slice(0, 24_000);
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "5m",
      options: { num_ctx: settings.max_context_tokens, num_predict: Math.min(4200, Math.max(2400, settings.max_output_tokens * 2)), temperature: 0.2 },
      messages: [
        {
          role: "system",
          content: `คุณเป็นนักพัฒนาของ Alpha Skill Lab เขียนสกิลให้ตรงกับสเปกและ test_cases ที่ล็อกไว้
ข้อกำหนดบังคับ:
- ส่งไฟล์สมบูรณ์ไม่เกิน 12 ไฟล์ รวมไม่เกินประมาณ 80KB
- entrypoint รับ JSON จาก argv[1] และเขียนไฟล์ลง path จาก ALPHA_OUTPUT_DIR เท่านั้น
- ใช้ได้เฉพาะ standard library และ dependency ids ในสเปก ห้ามเรียก network, shell, package manager หรืออ่านไฟล์ host
- ห้ามแก้เกณฑ์ทดสอบ ห้าม hard-code เฉพาะ test input; ต้องทำงานกับ input ทั่วไปตามเป้าหมาย
- อ่าน failure_kind และผล test ของ attempt ก่อนแล้วแก้ต้นเหตุ: candidate_syntax ให้ซ่อม parser/compiler error, candidate_behavior ให้เทียบ stdout/ไฟล์ที่คาดกับผลจริง, candidate_timeout ให้ลดความซับซ้อนและรับประกันว่าโปรแกรมจบ, capability_gap ให้ใช้ dependency ในสเปกหรือ standard library ที่เทียบเท่า
- แก้ต่อจาก source code เดิมเป็นหลัก รักษาส่วนที่ test ผ่านแล้ว และเปลี่ยนเฉพาะส่วนที่เกี่ยวข้องกับ failure ห้ามเขียนใหม่สุ่ม ๆ ทุก attempt
- ถ้าทำไม่ได้จริงให้ใส่ blocked_reason พร้อมเหตุผล ห้ามอ้างว่าสำเร็จ
ตอบ JSON เท่านั้น: {"files":[{"path":"main.py","content":"..."}],"notes":"...","blocked_reason":""}`,
        },
        { role: "user", content: `เป้าหมาย: ${objective}\nเกณฑ์สำเร็จ: ${successCriteria}\n\nสเปกที่ล็อกไว้:\n${JSON.stringify(skill)}\n\nผลล้มเหลวจาก attempt ก่อน (ให้แก้ต้นเหตุ):\n${previousFailure || "ยังไม่มี นี่คือ attempt แรก"}\n\nsource code จาก attempt ก่อน (แก้ต่อจากนี้และส่งไฟล์ฉบับเต็มกลับมา ห้ามเริ่มใหม่โดยไม่จำเป็น):\n${previousSource || "ยังไม่มี source code ก่อนหน้า"}` },
      ],
    }),
    signal: timedSignal(240_000, signal),
  });
  if (!response.ok) throw new Error(`สร้างสกิลไม่สำเร็จ (${response.status})`);
  const payload = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  const parsed = parseJsonObject(payload.message?.content ?? "{}");
  const files = Array.isArray(parsed.files) ? parsed.files.filter((item): item is { path: string; content: string } => (
    Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).content === "string"
  )).slice(0, 12) : [];
  return {
    files,
    notes: String(parsed.notes || "").slice(0, 3000),
    blocked_reason: String(parsed.blocked_reason || "").slice(0, 3000),
    prompt_tokens: payload.prompt_eval_count ?? 0,
    response_tokens: payload.eval_count ?? 0,
  };
}

export async function synthesizeResearchRound(
  topic: string,
  previousSummary: string,
  sources: SearchResult[],
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<ResearchSynthesis> {
  const evidence = sources.map((source, index) => (
    `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet}`
  )).join("\n\n");
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "5m",
      options: {
        num_ctx: settings.max_context_tokens,
        num_predict: Math.min(settings.max_output_tokens, 1200),
        temperature: 0.2,
      },
      messages: [
        {
          role: "system",
          content: `คุณเป็นนักวิจัยของอัลฟ่า สังเคราะห์ความรู้จากหลักฐานเท่านั้น ระบุช่องว่างและคำค้นรอบถัดไป ตอบ JSON รูปแบบ {"summary":"สรุปภาษาไทยพร้อม [เลข] อ้างอิง","gaps":["เรื่องที่ยังขาด"],"next_query":"คำค้นเว็บรอบถัดไป","confidence":0} ค่า confidence 0-100 คือความครบถ้วนของหลักฐาน ห้ามแต่งข้อเท็จจริงหรือ URL`,
        },
        {
          role: "user",
          content: `หัวข้อฝึก: ${topic}\n\nสรุปจากรอบก่อน:\n${previousSummary || "ยังไม่มี"}\n\nหลักฐานรอบนี้:\n${evidence}`,
        },
      ],
    }),
    signal: timedSignal(180_000, signal),
  });

  if (!response.ok) throw new Error(`Ollama ตอบกลับด้วยสถานะ ${response.status}`);
  const payload = await response.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  let parsed: Partial<ResearchSynthesis> = {};
  try {
    parsed = JSON.parse(payload.message?.content ?? "{}");
  } catch {
    parsed.summary = payload.message?.content ?? "";
  }

  return {
    summary: String(parsed.summary ?? "").trim().slice(0, 8000),
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String).map((gap) => gap.trim()).filter(Boolean).slice(0, 5) : [],
    next_query: String(parsed.next_query ?? "").trim().slice(0, 300),
    confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 0)),
    prompt_tokens: payload.prompt_eval_count ?? 0,
    response_tokens: payload.eval_count ?? 0,
  };
}

export async function unloadModel(model: string): Promise<void> {
  try {
    await ollamaFetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
    });
  } catch {
    // The setting must still save when Ollama is closed.
  }
}

export async function getHealth(configuredModel: string, memoryTargetGb = 10): Promise<HealthStatus> {
  const fallback: HealthStatus = {
    ollama_connected: false,
    model_installed: false,
    configured_model: configuredModel,
    installed_models: [],
    loaded_models: [],
    model_memory_bytes: 0,
    memory_target_bytes: memoryTargetGb * 1024 ** 3,
    search_configured: false,
    web_read_ready: false,
    search_ready: false,
    search_backend: "none",
    search_degraded_reason: "Tool Service ยังไม่ทำงาน",
    browser_ready: false,
    search_provider: "hybrid",
    tool_service: {
      connected: false,
      docker_connected: false,
      searxng_connected: false,
      alpha_browser_running: false,
      chrome_extension_connected: false,
      full_disk_access: "not_requested",
      outputs_directory: "",
      web_read_ready: false,
      search_ready: false,
      search_backend: "none",
      search_degraded_reason: "Tool Service ยังไม่ทำงาน",
      browser_ready: false,
      last_tool_error: "",
    },
    checked_at: new Date().toISOString(),
  };

  try {
    const [tagsResponse, psResponse] = await Promise.all([
      ollamaFetch("/api/tags", { signal: AbortSignal.timeout(2500) }),
      ollamaFetch("/api/ps", { signal: AbortSignal.timeout(2500) }),
    ]);

    if (!tagsResponse.ok) return fallback;
    const tags = await tagsResponse.json() as { models?: OllamaModel[] };
    const running = psResponse.ok ? await psResponse.json() as { models?: OllamaModel[] } : { models: [] };
    const installedModels = (tags.models ?? []).map((model) => model.name ?? model.model ?? "").filter(Boolean);
    const loadedModels = (running.models ?? []).map((model) => model.name ?? model.model ?? "").filter(Boolean);
    const memory = (running.models ?? []).reduce((sum, model) => sum + (model.size_vram || model.size || 0), 0);

    return {
      ...fallback,
      ollama_connected: true,
      model_installed: installedModels.some((name) => name === configuredModel || name.startsWith(`${configuredModel}:`)),
      installed_models: installedModels,
      loaded_models: loadedModels,
      model_memory_bytes: memory,
    };
  } catch {
    return fallback;
  }
}
