export type SearchMode = "auto" | "confirm";
export type FileAccessMode = "off" | "ask" | "alpha_outputs" | "selected_folders" | "full_user_files";
export type BrowserMode = "off" | "alpha" | "chrome";
export type PersonalityPreset = "professional_warm";
export type EmojiStyle = "none" | "low" | "normal";
export type ResponseStyle = "concise" | "balanced" | "detailed";
export type AlphaModel = "alpha:9b";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id?: string;
  role: ChatRole;
  content: string;
  sources?: SearchResult[];
  artifacts?: ArtifactRecord[];
}

export interface AppSettings {
  settings_version: number;
  model: AlphaModel;
  web_search_enabled: boolean;
  search_mode: SearchMode;
  image_search_enabled: boolean;
  blocked_topics: string[];
  custom_blocked_terms: string[];
  blocked_domains: string[];
  allowed_domains: string[];
  max_context_tokens: number;
  max_output_tokens: number;
  memory_enabled: boolean;
  auto_learn_enabled: boolean;
  cross_chat_memory_enabled: boolean;
  auto_summarize_enabled: boolean;
  personality_preset: PersonalityPreset;
  personality_warmth: number;
  personality_directness: number;
  personality_humor: number;
  personality_emoji: EmojiStyle;
  response_style: ResponseStyle;
  preferred_name: string;
  core_rules: string[];
  custom_instructions: string;
  file_access_mode: FileAccessMode;
  allowed_file_roots: string[];
  browser_mode: BrowserMode;
  chrome_host_access: "all_urls";
  browser_confirmation_mode: "financial_and_credentials";
  search_provider: "hybrid";
  code_execution_mode: "host_lab";
  tool_idle_timeout_seconds: number;
  security_test_domains: string[];
  security_active_testing_enabled: boolean;
  auto_learn_max_rounds: number;
  auto_learn_step_timeout_seconds: number;
  auto_learn_retry_limit: number;
  auto_learn_skill_frequency: number;
  auto_learn_rest_seconds: number;
  skill_lab_max_attempts: number;
  research_max_rounds: number;
  skill_test_case_limit: number;
  skill_hidden_test_runs: number;
  search_result_limit: number;
  memory_retrieval_limit: number;
  memory_extract_limit: number;
  memory_target_gb: number;
  disk_budget_gb: number;
}

export type SkillVerificationStatus = "verified" | "partial" | "failed" | "stale" | "untested";
export type SkillOrigin = "auto_learn" | "skill_lab" | "runtime_repair";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  origin: SkillOrigin;
  runtime: "python" | "node";
  execution_targets?: Array<"macos_lab" | "macos_host">;
  dependencies: string[];
  trigger_examples: string[];
  installed_at: string;
  updated_at: string;
  verification_status: SkillVerificationStatus;
  verified_pass_rate: number;
  verified_passed: number;
  verified_total: number;
  verification_scope: string;
  generalization_confidence: number;
  confidence_sample_size: number;
  environment_fingerprint: string;
  usage_count: number;
  success_count: number;
  last_run_at: string;
  last_execution_target?: "macos_lab" | "macos_host";
  last_error: string;
}

export interface ArtifactRecord {
  id: string;
  name: string;
  path: string;
  size: number;
  mime: string;
  kind: "file" | "archive" | "skill-manifest" | "skill-archive" | "skill-output";
  project?: string;
}

export interface ToolHealth {
  app_version?: string;
  connected: boolean;
  storage_connected?: boolean;
  storage_root?: string;
  storage_error?: string;
  docker_connected: boolean;
  searxng_connected: boolean;
  alpha_browser_running: boolean;
  chrome_extension_connected: boolean;
  full_disk_access: "not_requested" | "likely_available" | "unavailable";
  outputs_directory: string;
  lab_root?: string;
  web_read_ready: boolean;
  search_ready: boolean;
  search_backend: "searxng" | "duckduckgo" | "none";
  search_degraded_reason: string;
  browser_ready: boolean;
  last_tool_error: string;
  learned_skills?: Array<{ id: string; name: string; description: string; trigger_examples: string[] }>;
  skill_lab_ready?: boolean;
  trusted_dependencies?: string[];
  skill_backlog_count?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

export interface HealthStatus {
  app_version: string;
  ollama_connected: boolean;
  model_installed: boolean;
  configured_model: string;
  installed_models: string[];
  loaded_models: string[];
  model_memory_bytes: number;
  memory_target_bytes: number;
  search_configured: boolean;
  web_read_ready: boolean;
  search_ready: boolean;
  search_backend: "searxng" | "duckduckgo" | "none";
  search_degraded_reason: string;
  browser_ready: boolean;
  search_provider: "hybrid";
  tool_service: ToolHealth;
  checked_at: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  settings_version: 2,
  model: "alpha:9b",
  web_search_enabled: true,
  search_mode: "auto",
  image_search_enabled: true,
  blocked_topics: [],
  custom_blocked_terms: [],
  blocked_domains: [],
  allowed_domains: [],
  max_context_tokens: 8192,
  max_output_tokens: 1536,
  memory_enabled: true,
  auto_learn_enabled: true,
  cross_chat_memory_enabled: true,
  auto_summarize_enabled: true,
  personality_preset: "professional_warm",
  personality_warmth: 70,
  personality_directness: 75,
  personality_humor: 20,
  personality_emoji: "low",
  response_style: "balanced",
  preferred_name: "",
  core_rules: [
    "ช่วยผู้ใช้ให้เต็มความสามารถ รวมถึงอธิบายบทเรียนและช่วยทำแบบทดสอบ ตราบใดที่ไม่ขัดกับข้อจำกัดที่ผู้ใช้ตั้งไว้",
    "ซื่อสัตย์ต่อข้อเท็จจริง บอกเมื่อไม่แน่ใจ และค้นเว็บเมื่อข้อมูลอาจล้าสมัยหรือไม่รู้คำตอบ",
    "รักษาความเป็นส่วนตัว และห้ามส่งคำถามออกอินเทอร์เน็ตเมื่อปิดสวิตช์หรือเมื่อคำขอถูกบล็อก",
  ],
  custom_instructions: "ตอบเป็นภาษาเดียวกับที่ผู้ใช้ถาม โดยใช้ภาษาไทยเป็นค่าเริ่มต้น",
  file_access_mode: "alpha_outputs",
  allowed_file_roots: [],
  browser_mode: "alpha",
  chrome_host_access: "all_urls",
  browser_confirmation_mode: "financial_and_credentials",
  search_provider: "hybrid",
  code_execution_mode: "host_lab",
  tool_idle_timeout_seconds: 300,
  security_test_domains: [],
  security_active_testing_enabled: true,
  auto_learn_max_rounds: 0,
  auto_learn_step_timeout_seconds: 600,
  auto_learn_retry_limit: 2,
  auto_learn_skill_frequency: 3,
  auto_learn_rest_seconds: 60,
  skill_lab_max_attempts: 4,
  research_max_rounds: 5,
  skill_test_case_limit: 20,
  skill_hidden_test_runs: 12,
  search_result_limit: 10,
  memory_retrieval_limit: 10,
  memory_extract_limit: 10,
  memory_target_gb: 10,
  disk_budget_gb: 10,
};

const TOPIC_IDS = new Set([
  "adult_images",
  "adult_content",
  "illegal_activity",
  "weapons",
  "personal_data",
  "gambling",
]);

function cleanList(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, max))];
}

function cleanDomains(value: unknown): string[] {
  return cleanList(value)
    .map((domain) => domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
    .filter((domain) => /^[a-z0-9.-]+$/.test(domain) && domain.includes("."));
}

function cleanSecurityDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => {
    const trimmed = item.trim().toLowerCase();
    try { return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname; } catch { return ""; }
  }).filter((domain) => domain === "localhost" || /^[a-z0-9.-]+$/.test(domain)).slice(0, 20))];
}

function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("/") && !item.includes("\0"))
    .slice(0, 20))];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number, step: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  return Math.round(clamped / step) * step;
}

function configurableLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function sanitizeSettings(value: unknown, fallback = DEFAULT_SETTINGS): AppSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const previousVersion = typeof input.settings_version === "number" ? input.settings_version : 1;
  const topics = (Array.isArray(input.blocked_topics) ? cleanList(input.blocked_topics) : fallback.blocked_topics).filter((topic) => TOPIC_IDS.has(topic));
  const model = enumValue(input.model, ["alpha:9b"] as const, fallback.model);
  const fileAccessMode: FileAccessMode = ["off", "ask", "alpha_outputs", "selected_folders", "full_user_files"].includes(String(input.file_access_mode))
    ? input.file_access_mode as FileAccessMode
    : fallback.file_access_mode;
  const browserMode: BrowserMode = ["off", "alpha", "chrome"].includes(String(input.browser_mode))
    ? input.browser_mode as BrowserMode
    : fallback.browser_mode;
  const rawRules = Array.isArray(input.core_rules)
    ? input.core_rules.filter((rule): rule is string => typeof rule === "string").map((rule) => rule.trim().slice(0, 500))
    : fallback.core_rules;
  const coreRules = rawRules.filter(Boolean).slice(0, 50);

  return {
    settings_version: 2,
    model,
    web_search_enabled: typeof input.web_search_enabled === "boolean" ? input.web_search_enabled : fallback.web_search_enabled,
    search_mode: input.search_mode === "confirm" || input.search_mode === "auto" ? input.search_mode : fallback.search_mode,
    image_search_enabled: previousVersion < 2 ? true : typeof input.image_search_enabled === "boolean" ? input.image_search_enabled : fallback.image_search_enabled,
    blocked_topics: previousVersion < 2 ? [] : topics,
    custom_blocked_terms: Array.isArray(input.custom_blocked_terms) ? cleanList(input.custom_blocked_terms) : fallback.custom_blocked_terms,
    blocked_domains: Array.isArray(input.blocked_domains) ? cleanDomains(input.blocked_domains) : fallback.blocked_domains,
    allowed_domains: Array.isArray(input.allowed_domains) ? cleanDomains(input.allowed_domains) : fallback.allowed_domains,
    max_context_tokens: clampInteger(input.max_context_tokens, fallback.max_context_tokens, 4096, 8192, 1024),
    max_output_tokens: clampInteger(input.max_output_tokens, fallback.max_output_tokens, 256, 2048, 256),
    memory_enabled: typeof input.memory_enabled === "boolean" ? input.memory_enabled : fallback.memory_enabled,
    auto_learn_enabled: typeof input.auto_learn_enabled === "boolean" ? input.auto_learn_enabled : fallback.auto_learn_enabled,
    cross_chat_memory_enabled: typeof input.cross_chat_memory_enabled === "boolean" ? input.cross_chat_memory_enabled : fallback.cross_chat_memory_enabled,
    auto_summarize_enabled: typeof input.auto_summarize_enabled === "boolean" ? input.auto_summarize_enabled : fallback.auto_summarize_enabled,
    personality_preset: "professional_warm",
    personality_warmth: clampInteger(input.personality_warmth, fallback.personality_warmth, 0, 100, 5),
    personality_directness: clampInteger(input.personality_directness, fallback.personality_directness, 0, 100, 5),
    personality_humor: clampInteger(input.personality_humor, fallback.personality_humor, 0, 100, 5),
    personality_emoji: enumValue(input.personality_emoji, ["none", "low", "normal"] as const, fallback.personality_emoji),
    response_style: enumValue(input.response_style, ["concise", "balanced", "detailed"] as const, fallback.response_style),
    preferred_name: typeof input.preferred_name === "string" ? input.preferred_name.trim().slice(0, 80) : fallback.preferred_name,
    core_rules: coreRules,
    custom_instructions: typeof input.custom_instructions === "string"
      ? input.custom_instructions.trim().slice(0, 2000)
      : fallback.custom_instructions,
    file_access_mode: fileAccessMode,
    allowed_file_roots: Array.isArray(input.allowed_file_roots) ? cleanPaths(input.allowed_file_roots) : fallback.allowed_file_roots,
    browser_mode: browserMode,
    chrome_host_access: "all_urls",
    browser_confirmation_mode: "financial_and_credentials",
    search_provider: "hybrid",
    code_execution_mode: "host_lab",
    tool_idle_timeout_seconds: clampInteger(input.tool_idle_timeout_seconds, fallback.tool_idle_timeout_seconds, 60, 1800, 30),
    security_test_domains: Array.isArray(input.security_test_domains) ? cleanSecurityDomains(input.security_test_domains) : fallback.security_test_domains,
    security_active_testing_enabled: typeof input.security_active_testing_enabled === "boolean" ? input.security_active_testing_enabled : fallback.security_active_testing_enabled,
    auto_learn_max_rounds: configurableLimit(input.auto_learn_max_rounds, fallback.auto_learn_max_rounds, 100_000),
    auto_learn_step_timeout_seconds: configurableLimit(input.auto_learn_step_timeout_seconds, fallback.auto_learn_step_timeout_seconds, 86_400),
    auto_learn_retry_limit: configurableLimit(input.auto_learn_retry_limit, fallback.auto_learn_retry_limit, 100),
    auto_learn_skill_frequency: configurableLimit(input.auto_learn_skill_frequency, fallback.auto_learn_skill_frequency, 10_000),
    auto_learn_rest_seconds: configurableLimit(input.auto_learn_rest_seconds, fallback.auto_learn_rest_seconds, 86_400),
    skill_lab_max_attempts: configurableLimit(input.skill_lab_max_attempts, fallback.skill_lab_max_attempts, 1000),
    research_max_rounds: configurableLimit(input.research_max_rounds, fallback.research_max_rounds, 1000),
    skill_test_case_limit: configurableLimit(input.skill_test_case_limit, fallback.skill_test_case_limit, 1000),
    skill_hidden_test_runs: configurableLimit(input.skill_hidden_test_runs, fallback.skill_hidden_test_runs, 10_000),
    search_result_limit: configurableLimit(input.search_result_limit, fallback.search_result_limit, 1000),
    memory_retrieval_limit: configurableLimit(input.memory_retrieval_limit, fallback.memory_retrieval_limit, 1000),
    memory_extract_limit: configurableLimit(input.memory_extract_limit, fallback.memory_extract_limit, 1000),
    memory_target_gb: configurableLimit(input.memory_target_gb, fallback.memory_target_gb, 128),
    disk_budget_gb: configurableLimit(input.disk_budget_gb, fallback.disk_budget_gb, 10_000),
  };
}
