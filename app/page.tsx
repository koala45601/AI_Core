"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { AppSettings, ArtifactRecord, DEFAULT_SETTINGS, HealthStatus, SearchResult, SkillSummary } from "@/lib/types";
import { ALPHA_DISPLAY_VERSION } from "@/lib/version";
import CreateVideoStudio from "@/components/create-video-studio"; // alpha-beta23-create-video-phase1-v1

type View = "chat" | "video" | "memory" | "skills" | "tickets" | "settings";
type LearningTab = "memory" | "auto" | "lab";
type SkillDetailTab = "overview" | "verification" | "runs" | "files" | "history";

interface Usage {
  prompt_tokens: number;
  response_tokens: number;
  total_tokens: number;
  context_limit: number;
  unlimited_messages: boolean;
}

// alpha-beta4-task-ui-v1
interface AgentRunView {
  id: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "blocked";
  stage: string;
  label: string;
  detail: string;
  tool: string;
  updated_at: number;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  confirmationQuery?: string;
  confirmationUserId?: string;
  permission?: { confirmationId: string; summary: string; tool: string };
  artifacts?: ArtifactRecord[];
  error?: boolean;
}

interface ChatRecord {
  id: string;
  title: string;
  rolling_summary: string;
  status: "active" | "archived";
  pinned: number;
  message_count: number;
  last_preview: string;
  created_at: number;
  updated_at: number;
}

interface MemoryRecord {
  id: number;
  content: string;
  source: "manual" | "auto" | "research" | "correction";
  category: string;
  pinned: number;
  created_at: number;
}

interface TrainingRound {
  round: number;
  query: string;
  confidence: number;
  gaps: string[];
}

type TrainingMode = "skill" | "research";

interface AutoLearnFinding {
  title: string;
  mode: TrainingMode;
  success: boolean;
  why_new: string;
  progression_from: string;
  summary: string;
  confidence: number;
  recalled?: boolean;
  rounds?: number;
  reason?: string;
  checkpoint?: { attempts_completed?: number } | null;
  skill?: { id?: string; name?: string } | null;
}

interface AutoLearnJob {
  id?: string;
  status: "idle" | "running" | "completed" | "stopped";
  stage?: string;
  current_topic?: string;
  duration_minutes?: number;
  started_at?: number;
  deadline?: number;
  ended_at?: number;
  findings?: AutoLearnFinding[];
  log?: Array<{ at: number; label: string; detail: string }>;
  report?: {
    summary?: string;
    duration_minutes?: number;
    stop_reason?: string;
    skill_summary?: { tested?: number; installed?: number; failed?: number; recalled?: number };
    cleanup?: { containers_removed?: number; staging_removed?: boolean; orphaned_path?: string; error?: string };
  } | null;
  artifacts?: ArtifactRecord[];
  stop_reason?: string;
  last_activity_at?: number;
  current_round?: number;
  current_attempt?: number;
  current_tool?: string;
  skill_backlog_count?: number;
  events?: AutoLearnEvent[];
}

interface AutoLearnEvent {
  id: number;
  at: number;
  type: string;
  label: string;
  detail: string;
  round: number;
  attempt: number;
  stage: string;
  current_tool: string;
}

interface SkillDetail {
  directory: string;
  manifest: SkillSummary & { entrypoint?: string; test_cases?: unknown[]; hidden_test_result?: { passed: number; total: number } };
  report: Record<string, unknown>;
  files: Array<{ path: string }>;
}

interface TicketEventChoice {
  id: string;
  name: string;
  url: string;
  start_date?: string;
  end_date?: string;
  sale_open_at?: string;
  sale_status?: "open" | "upcoming" | "sold_out" | "closed" | "ended" | "cancelled" | "unknown";
  source?: string;
  selectable?: boolean;
  status_evidence?: string;
  inventory_status?: "not_checked" | "available" | "sold_out" | "unknown";
  inventory_evidence?: string;
  show_dates?: Array<{ raw?: string; iso?: string }>;
  performance_options?: TicketPerformanceOption[];
  queue_open_at?: string;
  schedule_checked_at?: number;
  schedule_status?: "fresh" | "cached" | "unavailable";
  cached_inspection?: TicketFormInspection;
}

type TicketSaleStatus = NonNullable<TicketEventChoice["sale_status"]>;
type TicketStatusFilter = "all" | TicketSaleStatus;

interface TicketPerformanceOption {
  selector?: string;
  label?: string;
  semantic_role?: string;
  context_text?: string;
  schedule?: string;
  data_button?: string;
  target_url?: string;
  product_name?: string;
  product_type?: "in_person" | "live_stream" | "rerun" | string;
  status?: "open" | "upcoming" | "sold_out" | "closed" | string;
  selectable?: boolean;
  announced_before_sale?: boolean;
}

interface TicketFormInspection {
  page?: { url?: string; title?: string; requested_url?: string; inspection_url?: string; used_public_fallback?: boolean };
  candidates: Record<string, Array<{ selector?: string; selector_confidence?: number; label?: string; name?: string; id?: string; type?: string }>>;
  ambiguous_roles: string[];
  api_calls: Array<Record<string, unknown>>;
  api_warning?: string;
  facts?: {
    event_name?: string;
    event_url?: string;
    show_dates?: Array<{ raw?: string; iso?: string }>;
    sale_open_at?: string;
    sale_open_at_raw?: string;
    queue_open_at?: string;
    queue_open_at_raw?: string;
    sale_status?: string;
    ticket_status?: string;
    venue?: string;
    prices?: number[];
    purchase_controls?: Array<{ selector?: string; label?: string }>;
    sale_entry_controls?: TicketPerformanceOption[];
    performance_options?: TicketPerformanceOption[];
    zones?: string[];
    seat_rows?: string[];
    seat_map_detected?: boolean;
    evidence?: Array<{ field?: string; text?: string; source?: string }>;
  };
  functional_preflight?: {
    passed?: boolean;
    public_page_verified?: boolean;
    purchase_controls_ready?: boolean;
    sale_entry_controls_ready?: boolean;
    sale_opens_within_30_minutes?: boolean;
    sale_remaining_seconds?: number | null;
    workflow_state?: string;
    unresolved?: string[];
    can_build?: boolean;
    can_run_live_selection?: boolean;
    runtime_discovery_required?: boolean;
    inspection_warning?: string;
  };
}

interface TicketBuildReport {
  ok: boolean;
  stage: string;
  generator_version?: string;
  project_path: string;
  created_files: string[];
  verification?: {
    structure_passed?: boolean;
    fixture_tests_passed?: boolean;
    queue_fixture_verified?: boolean;
    live_public_page_verified?: boolean;
    live_queue_observed?: boolean;
    live_checkout_verified?: boolean;
    workflow_state?: string;
    purchase_controls_ready?: boolean;
    expected_files?: string[];
    found_files?: string[];
    live_purchase_attempted?: boolean;
    handoff_points?: string[];
  };
  live_facts?: TicketFormInspection["facts"];
  output?: Record<string, unknown>;
}

interface TicketRunView {
  id: string;
  project_path: string;
  pid?: number | null;
  status: "starting_runtime" | "runtime_running" | "waiting_handoff" | "completed" | "not_verified" | "failed" | "stopped";
  stage: string;
  detail?: string;
  started_at?: number;
  updated_at?: number;
  ended_at?: number | null;
  exit_code?: number | null;
  latest_url?: string;
  full_loop_verified?: boolean;
  payment_handoff_verified?: boolean;
  result_status?: string;
  result_reason?: string;
  handoff?: { field?: string; prompt?: string; options?: string[]; secret?: boolean } | null;
  logs?: Array<{ at: number; stream: string; text: string }>;
}

const TOPICS = [
  { id: "adult_images", label: "ภาพโป๊และภาพลามก", detail: "บล็อกก่อนส่งคำค้นออกจากเครื่อง" },
  { id: "adult_content", label: "เนื้อหาผู้ใหญ่ทั้งหมด", detail: "บล็อกข้อความเกี่ยวกับสื่อลามก" },
  { id: "illegal_activity", label: "กิจกรรมผิดกฎหมาย", detail: "เช่น ขโมยรหัสหรือฟอกเงิน" },
  { id: "weapons", label: "การสร้างอาวุธ", detail: "บล็อกคำแนะนำเชิงปฏิบัติ" },
  { id: "personal_data", label: "ข้อมูลส่วนตัวของผู้อื่น", detail: "ป้องกันการค้นข้อมูลอ่อนไหว" },
  { id: "gambling", label: "การพนัน", detail: "บล็อกเว็บพนันและวิธีโกงเกม" },
];

function formatBytes(bytes: number) {
  if (!bytes) return "0 GB";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const TICKET_SALE_STATUS_ORDER: TicketSaleStatus[] = ["open", "upcoming", "sold_out", "closed", "ended", "cancelled", "unknown"];
const TICKET_SALE_STATUS: Record<TicketSaleStatus, { label: string; className: string }> = {
  open: { label: "เปิดช่วงขาย — ยังไม่ยืนยันที่นั่ง", className: "open" },
  upcoming: { label: "กำลังจะเปิดช่วงขาย", className: "upcoming" },
  sold_out: { label: "พบป้าย SOLD OUT", className: "sold-out" },
  closed: { label: "ปิดขาย", className: "closed" },
  ended: { label: "งานจบแล้ว", className: "ended" },
  cancelled: { label: "ยกเลิก", className: "cancelled" },
  unknown: { label: "ยังยืนยันไม่ได้", className: "unknown" },
};

function ticketSaleStatus(status: TicketEventChoice["sale_status"]) {
  return TICKET_SALE_STATUS[status || "unknown"];
}

function ticketPerformanceValue(option: TicketPerformanceOption) {
  const schedule = String(option?.schedule || option?.context_text || option?.label || "").trim();
  return [schedule, option?.data_button || option?.target_url || option?.product_type || "performance"].join("#");
}

function ticketPerformanceLabel(option: TicketPerformanceOption) {
  const performance = String(option?.context_text || option?.label || option?.schedule || "")
    .replace(/\s*(?:ซื้อบัตร|จองบัตร|buy\s*(?:now|ticket))\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const product = String(option?.product_name || "").trim();
  const status = option?.status === "sold_out" ? "ขายหมด" : option?.status === "closed" ? "ปิดขาย" : option?.status === "upcoming" ? "ยังไม่เปิดขาย" : "เปิดขาย";
  return `${product ? `${product} · ` : ""}${performance} · ${status}`;
}

function normalizedTicketPerformanceOptions(options?: TicketPerformanceOption[]) {
  const source = Array.isArray(options) ? options : [];
  const datedTimes = new Set(source.flatMap((option) => {
    const value = ticketPerformanceValue(option);
    const text = `${value} ${option.context_text || ""} ${option.label || ""}`;
    const dated = /^\d{4}-\d{2}-\d{2}T/.test(value) || /\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}/.test(text);
    return dated ? (text.match(/\b\d{1,2}:\d{2}\b/g) || []) : [];
  }));
  const seen = new Set<string>();
  return source.filter((option) => {
    const value = ticketPerformanceValue(option);
    const text = `${value} ${option.context_text || ""} ${option.label || ""}`;
    const time = text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "";
    const dated = /^\d{4}-\d{2}-\d{2}T/.test(value) || /\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}/.test(text);
    if (!dated && time && datedTimes.has(time)) return false;
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function ticketRunLogLabel(text: string) {
  try {
    const item = JSON.parse(text) as Record<string, unknown>;
    const kind = String(item.kind || "");
    if (kind === "action") return `ทำงาน: ${String(item.action || "action")}${item.label ? ` — ${String(item.label)}` : ""}`;
    if (kind === "checkpoint") return `ตรวจหน้า: ${String(item.state || "unknown")} · ${String(item.url || "")}`;
    if (kind === "api") return `API: ${String(item.method || "GET")} ${String(item.url || "")} → ${String(item.status || "")}`;
    if (kind === "wait") return `กำลังรอ: ${String(item.state || "เงื่อนไขจากเว็บ")}`;
    if (kind === "result") return `ผล: ${String(item.status || "ยังไม่ยืนยัน")}${item.reason ? ` — ${String(item.reason)}` : ""}`;
    if (kind === "input_required") return `รอผู้ใช้: ${String(item.prompt || item.field || "ตรวจหน้า Browser")}`;
    if (kind === "runtime") return String(item.detail || "เปิด Browser แยกแล้ว");
  } catch { /* plain process output */ }
  return text;
}

function automaticTicketProjectName(event?: TicketEventChoice) {
  if (!event) return "ticket-bot";
  let urlSlug = "";
  try {
    urlSlug = new URL(event.url).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "") || "";
  } catch {
    urlSlug = "";
  }
  const base = (urlSlug.replace(/^concert-/, "") || event.id || "ticket")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${base || "ticket"}-ticket-bot`;
}

function Toggle({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function ListEditor({ items, onChange, placeholder }: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim().toLowerCase();
    if (!value || items.includes(value)) return;
    onChange([...items, value]);
    setDraft("");
  }

  return (
    <div className="list-editor">
      <div className="tag-list">
        {items.length === 0 && <span className="empty-inline">ยังไม่มีรายการ</span>}
        {items.map((item) => (
          <span className="tag" key={item}>
            {item}
            <button type="button" aria-label={`ลบ ${item}`} onClick={() => onChange(items.filter((value) => value !== item))}>×</button>
          </span>
        ))}
      </div>
      <div className="inline-add">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add}>เพิ่ม</button>
      </div>
    </div>
  );
}

function LimitField({ label, value, onChange, suffix = "", hint = "0 = ไม่จำกัด" }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; hint?: string }) {
  return <label className="limit-field"><span><strong>{label}</strong><small>{hint}</small></span><div><input type="number" min="0" value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} />{suffix && <em>{suffix}</em>}</div></label>;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          code({ children, className }) {
            const language = /language-([\w-]+)/.exec(className || "")?.[1];
            const code = String(children).replace(/\n$/, "");
            if (!language) return <code className={className}>{children}</code>;
            return (
              <div className="code-block">
                <div className="code-toolbar"><span>{language}</span><button type="button" onClick={() => void navigator.clipboard.writeText(code)}>คัดลอก</button></div>
                <SyntaxHighlighter language={language} style={oneLight} PreTag="div" customStyle={{ margin: 0, background: "#f7faf8", fontSize: "12px" }}>{code}</SyntaxHighlighter>
              </div>
            );
          },
          a({ children, href }) {
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >{content}</ReactMarkdown>
    </div>
  );
}

function ArtifactCard({ artifact, onOpen, onRun }: {
  artifact: ArtifactRecord;
  onOpen: () => void;
  onRun: () => void;
}) {
  const runnable = [".py", ".js", ".mjs"].some((extension) => artifact.name.toLowerCase().endsWith(extension));
  return (
    <article className="artifact-card">
      <div className="artifact-icon">{artifact.kind === "archive" ? "ZIP" : "FILE"}</div>
      <div className="artifact-copy"><strong>{artifact.name}</strong><span>{formatFileSize(artifact.size)} · {artifact.path}</span></div>
      <div className="artifact-actions">
        <a href={`/api/artifacts/${encodeURIComponent(artifact.id)}`} download={artifact.name}>ดาวน์โหลด</a>
        <button type="button" onClick={onOpen}>เปิด Finder</button>
        {runnable && <button type="button" onClick={onRun}>Run/Test</button>}
      </div>
    </article>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("chat");
  const [learningTab, setLearningTab] = useState<LearningTab>("memory");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [usage, setUsage] = useState<Usage>({
    prompt_tokens: 0,
    response_tokens: 0,
    total_tokens: 0,
    context_limit: DEFAULT_SETTINGS.max_context_tokens,
    unlimited_messages: true,
  });
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRunView | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [trainingTopic, setTrainingTopic] = useState("");
  const [trainingMode, setTrainingMode] = useState<TrainingMode>("skill");
  const [trainingCriteria, setTrainingCriteria] = useState("");
  const [trainingRounds, setTrainingRounds] = useState(3);
  const [trainingActive, setTrainingActive] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState("");
  const [trainingLog, setTrainingLog] = useState<TrainingRound[]>([]);
  const [trainingResult, setTrainingResult] = useState<{ summary: string; confidence: number; rounds: number; reached_target: boolean; success?: boolean; reason?: string; cleanup?: string; skill_name?: string } | null>(null);
  const [autoLearnDuration, setAutoLearnDuration] = useState(0);
  const [autoLearnJob, setAutoLearnJob] = useState<AutoLearnJob | null>(null);
  const [autoLearnError, setAutoLearnError] = useState("");
  const [autoLearnEvents, setAutoLearnEvents] = useState<AutoLearnEvent[]>([]);
  const [autoLearnEventCursor, setAutoLearnEventCursor] = useState(0);
  const [autoLearnHasMore, setAutoLearnHasMore] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillTotal, setSkillTotal] = useState(0);
  const [skillCursor, setSkillCursor] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillStatus, setSkillStatus] = useState("");
  const [skillOrigin, setSkillOrigin] = useState("");
  const [skillSort, setSkillSort] = useState("latest");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [skillDetailTab, setSkillDetailTab] = useState<SkillDetailTab>("overview");
  const [skillActionStatus, setSkillActionStatus] = useState("");
  const [skillListScrollTop, setSkillListScrollTop] = useState(0);
  const [ticketSourceUrl, setTicketSourceUrl] = useState("https://www.thaiticketmajor.com/index.html");
  const [ticketEvents, setTicketEvents] = useState<TicketEventChoice[]>([]);
  const [ticketStatusFilter, setTicketStatusFilter] = useState<TicketStatusFilter>("all");
  const [ticketSelectedId, setTicketSelectedId] = useState("");
  const [ticketInspection, setTicketInspection] = useState<TicketFormInspection | null>(null);
  const [ticketStage, setTicketStage] = useState<"idle" | "inspecting" | "event_ready" | "form_inspecting" | "preferences" | "building" | "ready" | "error">("idle");
  const [ticketStatus, setTicketStatus] = useState("ใส่ลิงก์หน้ารวมคอนเสิร์ต แล้วให้อัลฟ่าตรวจทุกสถานะจากเว็บไซต์ต้นทาง");
  const [ticketSchedule, setTicketSchedule] = useState("");
  const [ticketQueueOpenAt, setTicketQueueOpenAt] = useState("");
  const [ticketSeatMode, setTicketSeatMode] = useState<"reserved" | "standing" | "general_admission">("reserved");
  const [ticketSeatGrouping, setTicketSeatGrouping] = useState<"adjacent" | "same_zone" | "any">("adjacent");
  const [ticketZones, setTicketZones] = useState("");
  const [ticketRows, setTicketRows] = useState("");
  const [ticketSeatNumbers, setTicketSeatNumbers] = useState("");
  const [ticketSeatFallback, setTicketSeatFallback] = useState<"exact" | "nearest" | "zone_any">("nearest");
  const [ticketQuantity, setTicketQuantity] = useState(1);
  const [ticketBudget, setTicketBudget] = useState(0);
  const [ticketCustomerName, setTicketCustomerName] = useState("");
  const [ticketAttendeeNames, setTicketAttendeeNames] = useState("");
  const [ticketAddress, setTicketAddress] = useState("");
  const [ticketCity, setTicketCity] = useState("");
  const [ticketProvince, setTicketProvince] = useState("");
  const [ticketPostalCode, setTicketPostalCode] = useState("");
  const [ticketDelivery, setTicketDelivery] = useState<"pickup" | "postal">("pickup");
  const [ticketProtect, setTicketProtect] = useState(false);
  const [ticketPayment, setTicketPayment] = useState<"qr" | "promptpay">("qr");
  const [ticketProjectName, setTicketProjectName] = useState("");
  const [ticketBuildReport, setTicketBuildReport] = useState<TicketBuildReport | null>(null);
  const [ticketRun, setTicketRun] = useState<TicketRunView | null>(null); // alpha-beta21-ticket-runtime-v1
  const [ticketUsername, setTicketUsername] = useState("");
  const [ticketPassword, setTicketPassword] = useState("");
  const [ticketRunInput, setTicketRunInput] = useState("");
  const ticketInspectPendingRef = useRef(false);
  const ticketRunPendingRef = useRef(false);
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [feedbackMessageId, setFeedbackMessageId] = useState<string | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [rememberCorrection, setRememberCorrection] = useState(true);
  const [toolTestStatus, setToolTestStatus] = useState("");
  // alpha-beta9-auto-grow-composer-v1
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const followLatestRef = useRef(true);
  const skillListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const textarea = composerInputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const viewportCap = typeof window === "undefined" ? 320 : Math.min(320, Math.max(140, Math.floor(window.innerHeight * 0.35)));
    const nextHeight = Math.max(38, Math.min(textarea.scrollHeight, viewportCap));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > viewportCap ? "auto" : "hidden";
  }, [draft]);
  // alpha-beta13-nonblocking-post-response-v1
  const postprocessTimerRef = useRef<number | null>(null);
  const postprocessAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    if (postprocessTimerRef.current !== null) window.clearTimeout(postprocessTimerRef.current);
    postprocessAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!ticketRun?.id || !["starting_runtime", "runtime_running", "waiting_handoff"].includes(ticketRun.status)) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_status", run_id: ticketRun.id }), cache: "no-store" });
        const data = await response.json() as { run?: TicketRunView; error?: string };
        if (response.ok && data.run && !stopped) {
          setTicketRun(data.run);
          setTicketStatus(data.run.detail || `Ticket Bot: ${data.run.stage}`);
        }
      } catch { /* next poll retries */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [ticketRun?.id, ticketRun?.status]);

  const loadChat = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(id)}/messages`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as {
        messages: Array<{ id: string; role: "user" | "assistant"; content: string; metadata?: { sources?: SearchResult[]; artifacts?: ArtifactRecord[]; error?: boolean; tool_events?: Array<Record<string, unknown>> } }>;
      };
      setMessages(data.messages.map((message) => {
        const permissionEvent = [...(message.metadata?.tool_events ?? [])].reverse().find((item) =>
          item.type === "permission_required" && typeof item.confirmation_id === "string"
        );
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          sources: message.metadata?.sources,
          artifacts: message.metadata?.artifacts,
          error: message.metadata?.error,
          permission: permissionEvent ? {
            confirmationId: String(permissionEvent.confirmation_id),
            summary: String(permissionEvent.summary || "อนุญาตให้ใช้เครื่องมือนี้หรือไม่?"),
            tool: String(permissionEvent.tool || "tool"),
          } : undefined,
        };
      }));
      setActiveChatId(id);
      setView("chat");
      followLatestRef.current = true;
    } catch { /* server restart: keep the current chat and retry on the next action */ }
  }, []);

  const loadChats = useCallback(async (query = "") => {
    try {
      const response = await fetch(`/api/chats?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (!response.ok) return [] as ChatRecord[];
      const data = await response.json() as { chats: ChatRecord[] };
      setChats(data.chats);
      return data.chats;
    } catch { return [] as ChatRecord[]; }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (response.ok) setSettings(await response.json());
    } catch { /* health polling will reconnect after a restart */ }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const [response, toolsResponse] = await Promise.all([
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/tools/health", { cache: "no-store" }),
      ]);
      if (response.ok) setHealth(await response.json());
      if (toolsResponse.ok) {
        const tools = await toolsResponse.json() as { pairing_code?: string };
        setPairingCode(tools.pairing_code ?? "");
      }
    } catch {
      setHealth(null);
    }
  }, []);

  const loadMemories = useCallback(async () => {
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json() as { memories: MemoryRecord[] };
        setMemories(data.memories);
      }
    } catch { /* retain loaded memories while reconnecting */ }
  }, []);

  const loadAutoLearn = useCallback(async () => {
    try {
      const response = await fetch("/api/auto-learn", { cache: "no-store" });
      const data = await response.json() as { job?: AutoLearnJob; error?: string };
      if (!response.ok) throw new Error(data.error || "อ่านสถานะ Auto Learn ไม่สำเร็จ");
      setAutoLearnJob(data.job ?? { status: "idle" });
      setAutoLearnError("");
      if (data.job && ["completed", "stopped"].includes(data.job.status)) void loadMemories();
    } catch (error) {
      setAutoLearnError(error instanceof Error ? error.message : "เชื่อมต่อ Auto Learn ไม่สำเร็จ");
    }
  }, [loadMemories]);

  const loadAutoLearnEvents = useCallback(async (reset = false) => {
    const cursor = reset ? 0 : autoLearnEventCursor;
    const runId = autoLearnJob?.id ? `&run_id=${encodeURIComponent(autoLearnJob.id)}` : "";
    try {
      const response = await fetch(`/api/auto-learn/events?cursor=${cursor}&limit=50${runId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { events?: AutoLearnEvent[]; next_cursor?: number; has_more?: boolean };
      const incoming = data.events ?? [];
      setAutoLearnEvents((current) => reset ? incoming : [...current, ...incoming.filter((item) => !current.some((old) => old.id === item.id))]);
      setAutoLearnEventCursor(Number(data.next_cursor || cursor));
      setAutoLearnHasMore(Boolean(data.has_more));
    } catch { /* status card still works when event endpoint is temporarily unavailable */ }
  }, [autoLearnEventCursor, autoLearnJob?.id]);

  const loadSkillDetail = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { skill?: SkillDetail };
      setSelectedSkill(data.skill ?? null);
      setSelectedSkillId(id);
    } catch { setSkillActionStatus("กำลังเชื่อมต่อใหม่…"); }
  }, []);

  const loadSkills = useCallback(async (reset = true, cursorOverride: string | null = null) => {
    try {
      const params = new URLSearchParams({ q: skillQuery, status: skillStatus, origin: skillOrigin, sort: skillSort, limit: "50" });
      if (!reset && cursorOverride) params.set("cursor", cursorOverride);
      const response = await fetch(`/api/skills?${params}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { skills?: SkillSummary[]; total?: number; next_cursor?: string | null };
      const incoming = data.skills ?? [];
      setSkills((current) => reset ? incoming : [...current, ...incoming.filter((item) => !current.some((old) => old.id === item.id))]);
      setSkillTotal(Number(data.total || 0));
      setSkillCursor(data.next_cursor ?? null);
      setSkillActionStatus("");
      if (reset && incoming[0]) void loadSkillDetail(incoming[0].id);
    } catch { setSkillActionStatus("กำลังเชื่อมต่อใหม่…"); }
  }, [loadSkillDetail, skillOrigin, skillQuery, skillSort, skillStatus]);

  const runSkillAction = useCallback(async (action: "run" | "test" | "reverify" | "retrain" | "export" | "open") => {
    if (!selectedSkillId) return;
    setSkillActionStatus(`กำลัง ${action}...`);
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(selectedSkillId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: action === "run" ? JSON.stringify({ input: {} }) : "{}" });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error || "คำสั่งไม่สำเร็จ"));
      if (action === "retrain") {
        setTrainingTopic(String(data.objective || ""));
        setTrainingCriteria(String(data.success_criteria || ""));
        setLearningTab("lab");
        setView("memory");
        setSkillActionStatus("ย้ายเป้าหมายไป Skill Lab แล้ว");
        return;
      }
      const artifacts = data.artifacts as ArtifactRecord[] | undefined;
      if (action === "export" && artifacts?.[0]) window.location.href = `/api/artifacts/${encodeURIComponent(artifacts[0].id)}`;
      setSkillActionStatus(`${action} สำเร็จ`);
      await Promise.all([loadSkills(true), loadSkillDetail(selectedSkillId)]);
    } catch (error) { setSkillActionStatus(error instanceof Error ? error.message : "คำสั่งสกิลไม่สำเร็จ"); }
  }, [loadSkillDetail, loadSkills, selectedSkillId]);

  const toggleSelectedSkill = useCallback(async () => {
    if (!selectedSkill) return;
    const enabled = selectedSkill.manifest.enabled !== false;
    const response = await fetch(`/api/skills/${encodeURIComponent(selectedSkill.manifest.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
    if (response.ok) await Promise.all([loadSkills(true), loadSkillDetail(selectedSkill.manifest.id)]);
  }, [loadSkillDetail, loadSkills, selectedSkill]);

  const deleteSelectedSkill = useCallback(async () => {
    if (!selectedSkill) return;
    if (!window.confirm(`ยืนยันย้ายสกิล “${selectedSkill.manifest.name}” ไป Trash?`)) return;
    const response = await fetch(`/api/skills/${encodeURIComponent(selectedSkill.manifest.id)}`, { method: "DELETE" });
    if (!response.ok) return;
    setSelectedSkill(null);
    setSelectedSkillId(null);
    await loadSkills(true);
  }, [loadSkills, selectedSkill]);

  useEffect(() => {
    const bootTimer = window.setTimeout(() => {
      void Promise.all([loadSettings(), loadHealth(), loadMemories(), loadChats(), loadAutoLearn()]).then((results) => {
        const initialChats = results[3] as ChatRecord[];
        if (initialChats[0]) void loadChat(initialChats[0].id);
      });
    }, 0);
    const timer = window.setInterval(loadHealth, 15_000);
    return () => {
      window.clearTimeout(bootTimer);
      window.clearInterval(timer);
    };
  }, [loadAutoLearn, loadChat, loadChats, loadHealth, loadMemories, loadSettings]);

  useEffect(() => {
    if (autoLearnJob?.status !== "running") return;
    const timer = window.setInterval(() => {
      void loadAutoLearn();
      void loadAutoLearnEvents();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [autoLearnJob?.status, loadAutoLearn, loadAutoLearnEvents]);

  useEffect(() => {
    setAutoLearnEvents([]);
    setAutoLearnEventCursor(0);
    const runId = autoLearnJob?.id;
    if (!runId) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/auto-learn/events?cursor=0&limit=50&run_id=${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { events?: AutoLearnEvent[]; next_cursor?: number; has_more?: boolean };
        setAutoLearnEvents(data.events ?? []);
        setAutoLearnEventCursor(Number(data.next_cursor || 0));
        setAutoLearnHasMore(Boolean(data.has_more));
      } catch { /* live polling will retry */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoLearnJob?.id]);

  useEffect(() => {
    if (view !== "skills") return;
    const timer = window.setTimeout(() => { void loadSkills(true); }, 220);
    return () => window.clearTimeout(timer);
  }, [view, skillQuery, skillStatus, skillOrigin, skillSort, loadSkills]);

  const latestInstalledSkillEvent = [...autoLearnEvents].reverse().find((item) => item.type === "skill_installed")?.id ?? 0;
  useEffect(() => {
    if (!latestInstalledSkillEvent) return;
    void loadSkills(true);
  }, [latestInstalledSkillEvent, loadSkills]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadChats(chatSearch); }, 250);
    return () => window.clearTimeout(timer);
  }, [chatSearch, loadChats]);

  useEffect(() => {
    if (followLatestRef.current) {
      messageEndRef.current?.scrollIntoView({ block: "end" });
      setShowScrollLatest(false);
    } else if (messages.length) {
      setShowScrollLatest(true);
    }
  }, [messages, isThinking]);

  function handleMessageScroll() {
    const element = messageScrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    followLatestRef.current = distance < 80;
    setShowScrollLatest(distance > 160);
  }

  function scrollToLatest() {
    followLatestRef.current = true;
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setShowScrollLatest(false);
  }

  async function persistSettings(next: AppSettings, quiet = false) {
    setSettings(next);
    if (!quiet) setSaveState("saving");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error("save failed");
      const saved = await response.json() as AppSettings;
      setSettings(saved);
      setUsage((current) => ({ ...current, context_limit: saved.max_context_tokens }));
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
      void loadHealth();
    } catch {
      setSaveState("error");
    }
  }

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setSaveState("idle");
  }

  async function toggleInternet(value: boolean) {
    await persistSettings({ ...settings, web_search_enabled: value }, true);
  }

  function cancelPendingChatPostprocess() {
    if (postprocessTimerRef.current !== null) {
      window.clearTimeout(postprocessTimerRef.current);
      postprocessTimerRef.current = null;
    }
    postprocessAbortRef.current?.abort();
    postprocessAbortRef.current = null;
  }

  function scheduleChatPostprocess(task: { chat_id: string; user_message_id: string; assistant_message_id: string }) {
    cancelPendingChatPostprocess();
    postprocessTimerRef.current = window.setTimeout(async () => {
      postprocessTimerRef.current = null;
      const controller = new AbortController();
      postprocessAbortRef.current = controller;
      try {
        const response = await fetch(`/api/chats/${encodeURIComponent(task.chat_id)}/postprocess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_message_id: task.user_message_id,
            assistant_message_id: task.assistant_message_id,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = await response.json() as { memories_added?: number; summarized?: boolean };
        if ((result.memories_added ?? 0) > 0) void loadMemories();
        if (result.summarized) void loadChats(chatSearch);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Alpha chat post-processing failed", error);
        }
      } finally {
        if (postprocessAbortRef.current === controller) postprocessAbortRef.current = null;
      }
    }, 8_000);
  }

  useEffect(() => {
    if (!activeRunId) return;
    let stopped = false;
    let clearTimer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/tasks/" + encodeURIComponent(activeRunId), { cache: "no-store" });
        if (!response.ok || stopped) return;
        const data = await response.json() as { run?: AgentRunView };
        if (data.run) {
          setActiveRun(data.run);
          if (["completed", "failed", "blocked"].includes(data.run.status) && clearTimer === undefined) {
            clearTimer = window.setTimeout(() => {
              if (!stopped) {
                setActiveRunId(null);
                setActiveRun(null);
              }
            }, 3500);
          }
        }
      } catch { /* next poll retries */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 800);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (clearTimer !== undefined) window.clearTimeout(clearTimer);
    };
  }, [activeRunId]);
  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {
    const cleanContent = content.trim();
    if (!cleanContent || isThinking) return;
    cancelPendingChatPostprocess();

    const userMessage: UiMessage = { id: existingUserId || crypto.randomUUID(), role: "user", content: cleanContent };
    const assistantId = crypto.randomUUID();
    setActiveRunId(userMessage.id);
    setActiveRun({ id: userMessage.id, status: "running", stage: "received", label: "รับคำขอแล้ว", detail: "", tool: "", updated_at: Date.now() });
    const visible = addUser ? [...messages, userMessage] : messages.filter((message) => message.id !== removeMessageId);

    followLatestRef.current = true;
    setMessages([...visible, { id: assistantId, role: "assistant", content: "" }]);
    setDraft("");
    setIsThinking(true);
    setThinkingSteps(["รับคำถามแล้ว", "กำลังตรวจสอบกฎ"]);
    let pendingPostprocess: { chat_id: string; user_message_id: string; assistant_message_id: string } | null = null;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: activeChatId,
          message: cleanContent,
          message_id: userMessage.id,
          force_search: forceSearch,
        }),
      });

      if (!response.body) throw new Error("ไม่พบข้อมูลคำตอบ");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const packets = buffer.split("\n\n");
        buffer = packets.pop() ?? "";

        for (const packet of packets) {
          const dataLine = packet.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6)) as Record<string, unknown> & { type: string };

          if (event.type === "status" && typeof event.label === "string") {
            setThinkingSteps((steps) => steps.includes(event.label as string) ? steps : [...steps, event.label as string].slice(-5));
          }
          if (event.type === "chat_created" && event.chat && typeof event.chat === "object") {
            const created = event.chat as unknown as ChatRecord;
            setActiveChatId(created.id);
            setChats((current) => [created, ...current.filter((chat) => chat.id !== created.id)]);
          }
          if (event.type === "token" && typeof event.text === "string") {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, content: message.content + event.text }
              : message));
          }
          if (event.type === "meta" && Array.isArray(event.sources)) {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, sources: event.sources as SearchResult[] }
              : message));
          }
          if (event.type === "tool_status" && typeof event.label === "string") {
            setThinkingSteps((steps) => [...steps, event.label as string].slice(-5));
          }
          if (event.type === "artifact" && Array.isArray(event.artifacts)) {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, artifacts: [...(message.artifacts ?? []), ...(event.artifacts as ArtifactRecord[])], content: message.content || "สร้างไฟล์จริงเรียบร้อยแล้ว" }
              : message));
          }
          if (event.type === "permission_required" && typeof event.confirmation_id === "string") {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? {
                ...message,
                content: message.content || "อัลฟ่าพร้อมทำงานนี้แล้ว แต่ต้องได้รับอนุญาตจากคุณก่อน",
                permission: {
                  confirmationId: event.confirmation_id as string,
                  summary: String(event.summary || "อนุญาตให้ใช้เครื่องมือนี้หรือไม่?"),
                  tool: String(event.tool || "tool"),
                },
              }
              : message));
          }
          if (event.type === "browser_state" && event.handoff_required === true) {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, content: `${message.content}\n\nต้องให้คุณรับช่วง: ${String(event.reason || "พบขั้นตอนที่ต้องยืนยันด้วยตัวเอง")}`.trim() }
              : message));
          }
          if (event.type === "tool_error" && typeof event.message === "string") {
            setThinkingSteps((steps) => [...steps, `เครื่องมือ: ${event.message as string}`].slice(-5));
            setMessages((current) => current.map((message) => message.id === assistantId && !message.content
              ? { ...message, content: event.message as string, error: true }
              : message));
          }
          if (event.type === "needs_confirmation" && typeof event.query === "string") {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, content: "คำถามนี้ควรตรวจสอบข้อมูลจากเว็บ คุณอนุญาตให้อัลฟ่าค้นเว็บครั้งนี้ไหม?", confirmationQuery: event.query as string, confirmationUserId: String(event.message_id || userMessage.id) }
              : message));
          }
          if ((event.type === "blocked" || event.type === "error") && typeof event.message === "string") {
            setMessages((current) => current.map((message) => message.id === assistantId
              ? { ...message, content: event.message as string, error: true }
              : message));
          }
          if (event.type === "usage") {
            setUsage(event as unknown as Usage);
          }
          if (event.type === "memory_updated") {
            setThinkingSteps((steps) => [...steps, "บันทึกสิ่งที่ควรจำแล้ว"].slice(-5));
            void loadMemories();
          }
          if (event.type === "search_backend" && typeof event.backend === "string") {
            const backend = event.backend === "searxng" ? "SearXNG" : event.backend === "duckduckgo" ? "DuckDuckGo สำรอง" : "ไม่ทราบระบบค้น";
            setThinkingSteps((steps) => [...steps, `ค้นผ่าน ${backend}`].slice(-5));
          }
          if (event.type === "message_saved" && event.message && typeof event.message === "object") {
            const saved = event.message as { id?: string; role?: string };
            if (saved.role === "assistant" && saved.id) {
              setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, id: saved.id! } : message));
            }
          }
          if (event.type === "done" && event.postprocess && typeof event.postprocess === "object") {
            const task = event.postprocess as Record<string, unknown>;
            if (typeof task.chat_id === "string" && typeof task.user_message_id === "string" && typeof task.assistant_message_id === "string") {
              pendingPostprocess = task as { chat_id: string; user_message_id: string; assistant_message_id: string };
            }
          }
        }
      }
      if (pendingPostprocess) scheduleChatPostprocess(pendingPostprocess);
    } catch (error) {
      const message = error instanceof Error ? error.message : "เชื่อมต่ออัลฟ่าไม่สำเร็จ";
      setMessages((current) => current.map((item) => item.id === assistantId
        ? { ...item, content: message, error: true }
        : item));
    } finally {
      setIsThinking(false);
      setThinkingSteps([]);
      void loadHealth();
      void loadChats(chatSearch);
    }
  }

  // alpha-beta3-resume-v1
  async function confirmPermission(messageId: string, confirmationId: string, approved: boolean) {
    const permissionIndex = messages.findIndex((item) => item.id === messageId);
    const previousUser = permissionIndex > 0
      ? [...messages.slice(0, permissionIndex)].reverse().find((item) => item.role === "user")
      : undefined;
    let statusTimer: number | undefined;
    let resumed = false;

    if (approved) {
      setIsThinking(true);
      setThinkingSteps(["ได้รับอนุญาตแล้ว", "กำลังดำเนินการที่ได้รับอนุญาต"]);
      statusTimer = window.setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/tools/status?id=${encodeURIComponent(confirmationId)}`, { cache: "no-store" });
          if (!statusResponse.ok) return;
          const status = await statusResponse.json() as { status?: string };
          const label = status.status === "running"
            ? "กำลังติดตั้ง/ดำเนินการบน Mac"
            : status.status === "completed"
              ? "ขั้นที่อนุญาตเสร็จแล้ว กำลังเตรียมทำงานเดิมต่อ"
              : status.status === "pending"
                ? "คำขออนุญาตถูกเก็บไว้แล้ว กำลังเริ่มทำงาน"
                : "กำลังตรวจผลของขั้นที่ได้รับอนุญาต";
          setThinkingSteps((steps) => [...steps.filter((item) => item !== label), label].slice(-5));
        } catch { /* ตัว POST หลักยังเป็นแหล่งผลลัพธ์หลัก */ }
      }, 1_000);
    }

    try {
      const response = await fetch("/api/tools/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_id: confirmationId, approved, message_id: messageId }),
      });
      const result = await response.json() as {
        ok?: boolean;
        error?: string;
        message?: string;
        artifacts?: ArtifactRecord[];
        stdout?: string;
        stderr?: string;
        denied?: boolean;
        expired?: boolean;
        retryable?: boolean;
        resume?: boolean;
        resume_prompt?: string;
        package?: string;
        version?: string;
      };
      if (!response.ok) throw new Error(result.error || "ยืนยันไม่สำเร็จ");

      const conciseStatus = result.denied
        ? "ไม่ได้ดำเนินการ เพราะคุณไม่อนุญาต"
        : String(result.message || (result.ok === false ? result.error || "ดำเนินการไม่สำเร็จ" : "ขั้นที่ได้รับอนุญาตเสร็จแล้ว"));
      setMessages((current) => current.map((message) => message.id === messageId
        ? {
          ...message,
          permission: undefined,
          error: result.ok === false && !result.denied,
          artifacts: result.artifacts ? [...(message.artifacts ?? []), ...result.artifacts] : message.artifacts,
          content: conciseStatus,
        }
        : message));
      void loadHealth();

      if (approved && result.resume === true && previousUser && !result.denied && result.ok !== false) {
        const resumePrompt = [
          String(result.resume_prompt || "ขั้นที่ต้องขออนุญาตเสร็จแล้ว ให้ดำเนินงานเดิมต่อจากจุดที่ค้าง"),
          `คำขอเดิมของผู้ใช้: ${previousUser.content}`,
          `ผลขั้นล่าสุด: ${conciseStatus}`,
          "ตรวจสถานะ/capability ใหม่ก่อน แล้วทำขั้นถัดไปอัตโนมัติ ถ้ายังขาด dependency อื่นให้ใช้ tool ที่เหมาะสมต่อ ห้ามหยุดเพียงเพราะขั้นติดตั้งเสร็จ",
        ].join("\n\n");
        resumed = true;
        setIsThinking(false);
        setThinkingSteps([]);
        window.setTimeout(() => {
          void runChat(resumePrompt, false, false, messageId, previousUser.id);
        }, 0);
        return;
      }
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === messageId
        ? { ...message, permission: undefined, content: `${message.content}\n\n${error instanceof Error ? error.message : "ยืนยันไม่สำเร็จ"}`, error: true }
        : message));
    } finally {
      if (statusTimer !== undefined) window.clearInterval(statusTimer);
      if (!resumed) {
        setIsThinking(false);
        setThinkingSteps([]);
      }
    }
  }

  async function openArtifact(id: string) {
    await fetch(`/api/artifacts/${encodeURIComponent(id)}/open`, { method: "POST" });
  }

  async function requestRun(messageId: string, artifactId: string) {
    try {
      const response = await fetch("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifact_id: artifactId }),
      });
      const result = await response.json() as { confirmation_id?: string; summary?: string; error?: string };
      if (response.status !== 409 || !result.confirmation_id) throw new Error(result.error || "เตรียม Docker sandbox ไม่สำเร็จ");
      setMessages((current) => current.map((message) => message.id === messageId
        ? { ...message, permission: { confirmationId: result.confirmation_id!, summary: result.summary || "อนุญาตให้รันไฟล์นี้หรือไม่?", tool: "run_artifact" } }
        : message));
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === messageId
        ? { ...message, content: `${message.content}\n\n${error instanceof Error ? error.message : "เตรียมรันไม่สำเร็จ"}`, error: true }
        : message));
    }
  }

  async function createNewChat() {
    if (activeChatId && messages.length) void fetch(`/api/chats/${encodeURIComponent(activeChatId)}/summarize`, { method: "POST" });
    const response = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) return;
    const data = await response.json() as { chat: ChatRecord };
    setChats((current) => [data.chat, ...current]);
    setActiveChatId(data.chat.id);
    setMessages([]);
    setUsage((current) => ({ ...current, prompt_tokens: 0, response_tokens: 0, total_tokens: 0 }));
    setView("chat");
  }

  async function patchChat(id: string, patch: Partial<Pick<ChatRecord, "title" | "status">> & { pinned?: boolean }) {
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    await loadChats(chatSearch);
  }

  async function archiveChat(id: string) {
    if (!window.confirm("เก็บแชตนี้เข้าคลังใช่ไหม? ข้อมูลยังไม่ถูกลบ")) return;
    await patchChat(id, { status: "archived" });
    if (activeChatId === id) await createNewChat();
  }

  async function permanentlyDeleteChat(id: string) {
    if (!window.confirm("ลบแชตนี้ถาวรพร้อมข้อความทั้งหมดใช่ไหม? การทำงานนี้ย้อนกลับไม่ได้")) return;
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (activeChatId === id) {
      setActiveChatId(null);
      setMessages([]);
    }
    await loadChats(chatSearch);
  }

  async function submitFeedback(messageId: string, rating: 1 | -1, correction = "") {
    const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, correction, remember_correction: rating === -1 && rememberCorrection }),
    });
    if (response.ok) {
      setFeedbackMessageId(null);
      setCorrectionDraft("");
      if (rememberCorrection) void loadMemories();
    }
  }

  async function patchMemory(id: number, patch: { content?: string; pinned?: boolean }) {
    await fetch("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    await loadMemories();
  }

  async function testCapability(kind: "read" | "search" | "browser") {
    setToolTestStatus("กำลังทดสอบ...");
    const response = await fetch("/api/tools/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
    const data = await response.json() as { label?: string; error?: string };
    setToolTestStatus(data.label || data.error || "ทดสอบเสร็จแล้ว");
    void loadHealth();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void runChat(draft);
  }

  async function addManualMemory(event: FormEvent) {
    event.preventDefault();
    if (!memoryDraft.trim()) return;
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: memoryDraft }),
    });
    if (response.ok) {
      setMemoryDraft("");
      await loadMemories();
    }
  }

  async function removeMemory(id: number) {
    await fetch(`/api/memory?id=${id}`, { method: "DELETE" });
    await loadMemories();
  }

  async function trainAlpha(event: FormEvent) {
    event.preventDefault();
    if (!trainingTopic.trim() || trainingActive) return;
    setTrainingActive(true);
    setTrainingStatus("กำลังเริ่มโหมดฝึก");
    setTrainingLog([]);
    setTrainingResult(null);

    try {
      const response = await fetch("/api/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: trainingMode,
          objective: trainingTopic,
          success_criteria: trainingCriteria,
          max_attempts: trainingRounds,
          target_confidence: 85,
        }),
      });
      if (!response.body) throw new Error("ไม่พบข้อมูลจากโหมดฝึก");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const packets = buffer.split("\n\n");
        buffer = packets.pop() ?? "";
        for (const packet of packets) {
          const line = packet.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6)) as Record<string, unknown> & { type: string };
          if (data.type === "status" && typeof data.label === "string") setTrainingStatus(data.label);
          if (data.type === "round" || data.type === "attempt") {
            setTrainingLog((current) => [...current, {
              round: Number(data.round),
              query: String(data.query),
              confidence: Number(data.confidence),
              gaps: Array.isArray(data.gaps) ? data.gaps.map(String) : [],
            }]);
          }
          if (data.type === "skill_plan") setTrainingStatus(`วางแผนสกิล ${String((data.skill as { name?: unknown } | undefined)?.name || "ใหม่")} แล้ว`);
          if (data.type === "notice" && typeof data.message === "string") setTrainingStatus(data.message);
          if (data.type === "usage") setUsage(data as unknown as Usage);
          if (data.type === "complete") {
            setTrainingResult({
              summary: String(data.summary),
              confidence: Number(data.confidence),
              rounds: Number(data.rounds),
              reached_target: Boolean(data.reached_target),
              success: typeof data.success === "boolean" ? data.success : undefined,
              reason: typeof data.reason === "string" ? data.reason : undefined,
              cleanup: typeof data.cleanup === "string" ? data.cleanup : undefined,
              skill_name: String((data.skill as { name?: unknown } | undefined)?.name || ""),
            });
            setTrainingStatus(data.mode === "skill" ? (data.success ? "ทดสอบผ่านและติดตั้งสกิลแล้ว" : "จบ Full loop แต่ยังไม่ผ่านเป้าหมาย") : "บันทึกลงคลังความรู้แล้ว");
            void loadMemories();
          }
          if (data.type === "error") throw new Error(String(data.message));
        }
      }
    } catch (error) {
      setTrainingStatus(error instanceof Error ? error.message : "โหมดฝึกทำงานไม่สำเร็จ");
    } finally {
      setTrainingActive(false);
    }
  }

  async function startAutoLearning() {
    if (autoLearnJob?.status === "running") return;
    setAutoLearnError("");
    try {
      const response = await fetch("/api/auto-learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_minutes: autoLearnDuration }),
      });
      const data = await response.json() as { job?: AutoLearnJob; error?: string };
      if (!response.ok) throw new Error(data.error || "เริ่ม Auto Learn ไม่สำเร็จ");
      setAutoLearnJob(data.job ?? null);
    } catch (error) {
      setAutoLearnError(error instanceof Error ? error.message : "เริ่ม Auto Learn ไม่สำเร็จ");
    }
  }

  async function stopAutoLearning() {
    setAutoLearnError("");
    try {
      const response = await fetch("/api/auto-learn", { method: "DELETE" });
      const data = await response.json() as { job?: AutoLearnJob; error?: string };
      if (!response.ok) throw new Error(data.error || "เรียกอัลฟ่ากลับไม่สำเร็จ");
      setAutoLearnJob(data.job ?? null);
      window.setTimeout(() => { void loadAutoLearn(); }, 1_000);
    } catch (error) {
      setAutoLearnError(error instanceof Error ? error.message : "เรียกอัลฟ่ากลับไม่สำเร็จ");
    }
  }

  function selectorsFromTicketInspection(inspection: TicketFormInspection | null): Record<string, string> {
    if (!inspection) return {};
    const roleMap: Record<string, string[]> = {
      event: ["event"],
      schedule: ["schedule"],
      seat_or_zone: ["preferredZone"],
      quantity: ["quantity"],
      customer_name: ["customerName"],
      address: ["address.address", "address.city", "address.province", "address.postalCode"],
      payment_method: ["qrPayment"],
      purchase_action: ["buyButton", "continueButton"],
    };
    const selectors: Record<string, string> = {};
    for (const [role, keys] of Object.entries(roleMap)) {
      const candidate = [...(inspection.candidates[role] ?? [])]
        .filter((item) => typeof item.selector === "string" && item.selector.trim())
        .sort((left, right) => Number(right.selector_confidence || 0) - Number(left.selector_confidence || 0))[0];
      if (!candidate?.selector) continue;
      for (const key of keys) selectors[key] = candidate.selector;
    }
    return selectors;
  }

  async function inspectTicketEvents() {
    if (!ticketSourceUrl.trim() || ticketStage === "inspecting" || ticketInspectPendingRef.current) return;
    ticketInspectPendingRef.current = true;
    setTicketStage("inspecting");
    setTicketStatus("กำลังอ่านสถานะช่วงขายจากหน้ารวม — ยังไม่สรุปว่ามีที่นั่งจนกว่าจะเข้า inventory จริง…");
    setTicketEvents([]);
    setTicketStatusFilter("all");
    setTicketSelectedId("");
    setTicketInspection(null);
    setTicketBuildReport(null);
    try {
      const response = await fetch("/api/ticket-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect", url: ticketSourceUrl }),
      });
      const data = await response.json() as { events?: TicketEventChoice[]; message?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "ตรวจรายการคอนเสิร์ตไม่สำเร็จ");
      const events = data.events ?? [];
      setTicketEvents(events);
      setTicketStatus(data.message || `พบ ${events.length} รายการ`);
      setTicketStage(events.some((event) => event.selectable !== false && ["open", "upcoming"].includes(event.sale_status || "unknown")) ? "event_ready" : "idle");
    } catch (error) {
      setTicketStage("error");
      setTicketStatus(error instanceof Error ? error.message : "ตรวจรายการคอนเสิร์ตไม่สำเร็จ");
    } finally {
      ticketInspectPendingRef.current = false;
    }
  }

  async function inspectSelectedTicketEvent(selectedOverride?: TicketEventChoice) {
    const selected = selectedOverride ?? ticketEvents.find((event) => event.id === ticketSelectedId);
    if (!selected || ticketStage === "form_inspecting" || ticketInspectPendingRef.current) return;
    ticketInspectPendingRef.current = true;
    setTicketStage("form_inspecting");
    setTicketStatus(`กำลังอ่านรอบ ฟอร์ม และ API แบบ passive ของ ${selected.name}…`);
    setTicketInspection(null);
    setTicketBuildReport(null);
    try {
      const response = await fetch("/api/ticket-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect_form", url: selected.url, source_url: ticketSourceUrl, event_id: selected.id, event_name: selected.name, discover_api: true }),
      });
      const data = await response.json() as TicketFormInspection & { error?: string };
      if (!response.ok) throw new Error(data.error || "ตรวจหน้าเลือกบัตรไม่สำเร็จ");
      setTicketInspection({
        page: data.page,
        candidates: data.candidates ?? {},
        ambiguous_roles: data.ambiguous_roles ?? [],
        api_calls: data.api_calls ?? [],
        api_warning: data.api_warning,
        facts: data.facts ?? {},
        functional_preflight: data.functional_preflight ?? {},
      });
      const performanceOptions = normalizedTicketPerformanceOptions(data.facts?.performance_options);
      setTicketEvents((current) => current.map((event) => event.id !== selected.id ? event : {
        ...event,
        show_dates: data.facts?.show_dates ?? event.show_dates,
        performance_options: performanceOptions,
        sale_open_at: data.facts?.sale_open_at || event.sale_open_at,
        sale_status: data.facts?.sale_status || event.sale_status,
        inventory_status: data.facts?.ticket_status === "sold_out" ? "sold_out" : data.facts?.ticket_status === "available" || data.facts?.ticket_status === "mixed_availability" ? "available" : event.inventory_status,
        queue_open_at: data.facts?.queue_open_at || event.queue_open_at,
        schedule_status: "fresh",
      }));
      const verifiedSchedule = data.facts?.show_dates?.[0]?.iso || data.facts?.show_dates?.[0]?.raw || selected.start_date || "";
      setTicketSchedule(performanceOptions.length === 1 ? ticketPerformanceValue(performanceOptions[0]) : performanceOptions.length > 1 ? "" : verifiedSchedule);
      setTicketQueueOpenAt(data.facts?.queue_open_at || "");
      const workflowState = data.functional_preflight?.workflow_state || "unknown";
      const workflowLabel = workflowState === "armed_pre_sale" ? "เตรียมพร้อม — เปิดขายภายใน 30 นาที"
        : workflowState === "pre_sale" ? "ยังไม่เปิดขาย — เหลือมากกว่า 30 นาที"
          : workflowState === "sale_entry" ? "เปิดขายและพบทางเข้าซื้อจริง"
            : workflowState;
      const unresolved = data.functional_preflight?.unresolved ?? [];
      setTicketStatus(data.functional_preflight?.public_page_verified
        ? `ยืนยันข้อมูลหน้าจริงแล้ว · พบ ${performanceOptions.length || data.facts?.show_dates?.length || 1} รอบ · ${workflowLabel}${data.functional_preflight.purchase_controls_ready ? " · พบทางเข้าซื้อ" : " · เก็บรอบไว้ก่อนและจะจับคู่ปุ่มซื้อหลังเปิดขาย"}`
        : `หลักฐานหน้าจริงยังไม่ครบ: ${unresolved.join(", ") || "ไม่พบวันแสดง/วันเปิดขาย"}`);
      setTicketStage("preferences");
    } catch (error) {
      const warning = error instanceof Error ? error.message : "ตรวจหน้าเลือกบัตรไม่สำเร็จ";
      const listingFacts: NonNullable<TicketFormInspection["facts"]> = {
        event_name: selected.name,
        event_url: selected.url,
        show_dates: selected.start_date ? [{ raw: selected.start_date }] : [],
        sale_open_at: selected.sale_open_at || "",
        sale_open_at_raw: selected.sale_open_at || "",
        sale_status: selected.sale_status || "unknown",
        evidence: [{ field: "sale_status", text: selected.sale_status || "unknown", source: "public_listing" }],
      };
      setTicketInspection({
        page: { requested_url: selected.url, inspection_url: selected.url },
        candidates: {},
        ambiguous_roles: [],
        api_calls: [],
        api_warning: warning,
        facts: listingFacts,
        functional_preflight: {
          passed: false,
          public_page_verified: false,
          purchase_controls_ready: false,
          workflow_state: "runtime_discovery",
          unresolved: ["schedule", "sale_open_at", "form_controls"].filter((field) => field !== "schedule" || !selected.start_date),
          can_build: ["open", "upcoming"].includes(selected.sale_status || "unknown"),
          can_run_live_selection: false,
          runtime_discovery_required: true,
          inspection_warning: warning,
        },
      });
      setTicketSchedule(selected.start_date || "");
      setTicketQueueOpenAt("");
      setTicketStage("preferences");
      setTicketStatus(`หน้ารายละเอียดถูกเว็บไซต์ปฏิเสธ แต่สร้างบอทได้ — โปรแกรมจะอ่านรอบ โซน และฟอร์มจริงหลัง Login ตอนรัน (${warning})`);
    } finally {
      ticketInspectPendingRef.current = false;
    }
  }

  async function startTicketRuntime(projectPath: string) {
    if (!projectPath) throw new Error("ไม่พบ project path สำหรับเริ่มบอท");
    setTicketStatus("กำลังเริ่ม process ของ Ticket Bot จริง…");
    const response = await fetch("/api/ticket-bot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", project_path: projectPath, username: ticketUsername, password: ticketPassword }),
    });
    const data = await response.json() as { run?: TicketRunView; error?: string };
    setTicketPassword("");
    if (!response.ok || !data.run) throw new Error(data.error || "เริ่ม Ticket Bot process ไม่สำเร็จ");
    setTicketRun(data.run);
    setTicketRunInput("");
    setTicketStatus(data.run.detail || "Ticket Bot process เริ่มทำงานแล้ว");
    return data.run;
  }

  async function sendTicketRuntimeInput() {
    if (!ticketRun?.id) return;
    const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_input", run_id: ticketRun.id, value: ticketRunInput }) });
    const data = await response.json() as { run?: TicketRunView; error?: string };
    setTicketRunInput("");
    if (!response.ok || !data.run) { setTicketStatus(data.error || "ส่งข้อมูลให้ Ticket Bot ไม่สำเร็จ"); return; }
    setTicketRun(data.run);
    setTicketStatus(data.run.detail || "ส่งข้อมูลแล้ว กำลังทำต่อ");
  }

  async function stopTicketRuntime() {
    if (!ticketRun?.id) return;
    const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_stop", run_id: ticketRun.id }) });
    const data = await response.json() as { run?: TicketRunView; error?: string };
    if (!response.ok || !data.run) { setTicketStatus(data.error || "หยุด Ticket Bot ไม่สำเร็จ"); return; }
    setTicketRun(data.run);
    setTicketStatus("ส่งคำสั่งหยุด Ticket Bot แล้ว");
  }

  async function buildTicketBot(event: FormEvent) {
    event.preventDefault();
    const selected = ticketEvents.find((item) => item.id === ticketSelectedId);
    if (!selected || ticketStage === "building" || ticketRunPendingRef.current) return;
    if (ticketDelivery === "postal" && !ticketAddress.trim()) {
      setTicketStage("error");
      setTicketStatus("เลือกจัดส่งทางไปรษณีย์จึงต้องใส่ที่อยู่ก่อน");
      return;
    }
    const performanceOptions = normalizedTicketPerformanceOptions(ticketInspection?.facts?.performance_options);
    const selectedPerformance = performanceOptions.find((option) => ticketPerformanceValue(option) === ticketSchedule);
    if (performanceOptions.length > 1 && !selectedPerformance) {
      setTicketStage("error");
      setTicketStatus("คอนเสิร์ตนี้มีหลายวัน กรุณาเลือกรอบก่อนเริ่มบอท ระบบจะจำรอบนี้ไว้ตลอดคิว");
      return;
    }
    ticketRunPendingRef.current = true;
    setTicketStage("building");
    try {
      const reusableCurrentProject = ticketBuildReport?.project_path
        && ticketBuildReport.generator_version === "1.1.0-beta.23"
        && ticketRun
        && ["completed", "not_verified", "stopped"].includes(ticketRun.status);
      if (reusableCurrentProject) {
        setTicketStatus("กำลังเริ่มโปรเจกต์เวอร์ชันปัจจุบันอีกครั้ง…");
        await startTicketRuntime(ticketBuildReport.project_path);
        setTicketStage("ready");
        return;
      }

      // Failed, missing-version and pre-beta22 projects are rebuilt instead of
      // silently rerunning stale generated code.
      setTicketStatus("กำลังสร้างโปรเจกต์ Ticket Bot เวอร์ชันปัจจุบันและตรวจไฟล์…");
      setTicketBuildReport(null);
      const response = await fetch("/api/ticket-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "build",
          input: {
            event_url: selected.url,
            event_candidates: ticketEvents,
            selected_event_id: selected.id,
            selected_event_name: selected.name,
            schedule: selectedPerformance?.schedule || ticketSchedule || selected.start_date,
            selected_performance: selectedPerformance ?? null,
            sale_open_at: ticketInspection?.facts?.sale_open_at,
            queue_open_at: ticketQueueOpenAt,
            seat_mode: ticketSeatMode,
            seat_grouping: ticketSeatGrouping,
            preferred_zones: ticketZones.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
            preferred_rows: ticketRows.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
            preferred_seat_numbers: ticketSeatNumbers.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
            seat_fallback_mode: ticketSeatFallback,
            quantity: ticketQuantity,
            budget: ticketBudget,
            customer_name: ticketCustomerName,
            attendee_names: ticketAttendeeNames.split(/\n/).map((item) => item.trim()).filter(Boolean),
            shipping_address: {
              address: ticketAddress,
              city: ticketCity,
              province: ticketProvince,
              postalCode: ticketPostalCode,
            },
            delivery_method: ticketDelivery,
            ticket_protect: ticketProtect,
            payment_method: ticketPayment,
            selectors: selectorsFromTicketInspection(ticketInspection),
            captured_api: ticketInspection?.api_calls ?? [],
            event_facts: ticketInspection?.facts ?? {},
            functional_preflight: ticketInspection?.functional_preflight ?? {},
            project_name: effectiveTicketProjectName,
          },
        }),
      });
      const data = await response.json() as TicketBuildReport & { error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "สร้างหรือทดสอบโปรเจกต์ไม่ผ่าน");
      setTicketBuildReport(data);
      setTicketStage("ready");
      setTicketStatus(`สร้างโปรเจกต์ ${data.created_files?.length ?? 0} ไฟล์และ fixture ผ่านแล้ว · กำลังเริ่ม runtime จริง`);
      await startTicketRuntime(data.project_path);
    } catch (error) {
      setTicketStage("error");
      setTicketStatus(error instanceof Error ? error.message : "สร้างโปรเจกต์ไม่สำเร็จ");
    } finally {
      ticketRunPendingRef.current = false;
    }
  }

  const tokenPercent = useMemo(() => Math.min(100, (usage.total_tokens / Math.max(1, usage.context_limit)) * 100), [usage]);
  const memoryPercent = health ? Math.min(100, (health.model_memory_bytes / Math.max(1, health.memory_target_bytes)) * 100) : 0;
  const runtimeReady = Boolean(health?.ollama_connected && health?.model_installed);
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const selectedTicketEvent = ticketEvents.find((event) => event.id === ticketSelectedId);
  const currentTicketPerformanceOptions = normalizedTicketPerformanceOptions(ticketInspection?.facts?.performance_options);
  const generatedTicketProjectName = automaticTicketProjectName(selectedTicketEvent);
  const effectiveTicketProjectName = ticketProjectName.trim() || generatedTicketProjectName;
  const ticketRunActive = Boolean(ticketRun && ["starting_runtime", "runtime_running", "waiting_handoff"].includes(ticketRun.status));
  const autoLearnProgress = autoLearnJob?.status === "running" && autoLearnJob.started_at && autoLearnJob.deadline
    ? Math.min(100, Math.max(1, ((Date.now() - autoLearnJob.started_at) / (autoLearnJob.deadline - autoLearnJob.started_at)) * 100))
    : autoLearnJob && ["completed", "stopped"].includes(autoLearnJob.status) ? 100 : 0;
  const autoLearnUnlimited = Boolean(autoLearnJob?.status === "running" && autoLearnJob.duration_minutes === 0 && !autoLearnJob.deadline);
  const autoLearnStage = ({
    starting: "กำลังเริ่มระบบเรียนรู้",
    choosing: "กำลังเลือกหัวข้อจากงานล่าสุด",
    researching: "กำลังค้นคว้าและตรวจหลายแหล่ง",
    building_skill: "กำลังสร้างและทดสอบสกิลใน Docker",
    resting: "พักโมเดลก่อนเริ่มหัวข้อใหม่",
    stopping: "กำลังเรียกกลับและสร้างรายงาน",
    finished: "สรุปและเก็บกวาดเรียบร้อยแล้ว",
  } as Record<string, string>)[autoLearnJob?.stage ?? ""] || "พร้อมเริ่มเรียนรู้";
  const autoLearnStalled = Boolean(autoLearnJob?.status === "running" && autoLearnJob.last_activity_at
    && settings.auto_learn_step_timeout_seconds > 0
    && Date.now() - autoLearnJob.last_activity_at > settings.auto_learn_step_timeout_seconds * 1000);
  const skillRowHeight = 118;
  const skillStart = Math.max(0, Math.floor(skillListScrollTop / skillRowHeight) - 3);
  const skillEnd = Math.min(skills.length, skillStart + 14);
  const visibleSkills = skills.slice(skillStart, skillEnd);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true">α</span>
          <div><strong>อัลฟ่า</strong><span>ผู้ช่วย AI ส่วนตัวของคุณ · v{ALPHA_DISPLAY_VERSION}</span></div>
        </div>

        <button className="new-chat" type="button" onClick={() => void createNewChat()}>
          <span aria-hidden="true">＋</span>แชตใหม่
        </button>

        <nav className="sidebar-nav" aria-label="เมนูหลัก">
          <button className={`nav-item ${view === "chat" ? "active" : ""}`} type="button" onClick={() => setView("chat")}><span>⌁</span>สนทนา</button>
          <button className={`nav-item ${view === "video" ? "active" : ""}`} type="button" onClick={() => setView("video")}><span>▶</span>Create Video</button>
          <button className={`nav-item ${view === "memory" ? "active" : ""}`} type="button" onClick={() => setView("memory")}><span>◇</span>สอนอัลฟ่า</button>
          <button className={`nav-item ${view === "skills" ? "active" : ""}`} type="button" onClick={() => setView("skills")}><span>⬡</span>ทักษะ</button>
          <button className={`nav-item ${view === "tickets" ? "active" : ""}`} type="button" onClick={() => setView("tickets")}><span>▱</span>บอทบัตร</button>
          <button className={`nav-item ${view === "settings" ? "active" : ""}`} type="button" onClick={() => setView("settings")}><span>⚙</span>ตั้งค่า</button>
        </nav>

        <div className="chat-history">
          <label><span>ประวัติแชต</span><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="ค้นหา..." /></label>
          <div className="chat-history-list">
            {chats.map((chat) => (
              <div className={`chat-history-item ${chat.id === activeChatId ? "active" : ""}`} key={chat.id}>
                <button className="chat-history-open" type="button" onClick={() => void loadChat(chat.id)}>
                  <strong>{chat.pinned ? "★ " : ""}{chat.title}</strong><small>{chat.last_preview || "ยังไม่มีข้อความ"}</small>
                </button>
                <div className="chat-history-actions">
                  <button type="button" title={chat.pinned ? "เลิกปักหมุด" : "ปักหมุด"} onClick={() => void patchChat(chat.id, { pinned: !chat.pinned })}>{chat.pinned ? "★" : "☆"}</button>
                  <button type="button" title="เก็บถาวร" onClick={() => void archiveChat(chat.id)}>▣</button>
                  <button type="button" title="ลบถาวร" onClick={() => void permanentlyDeleteChat(chat.id)}>×</button>
                </div>
              </div>
            ))}
            {chats.length === 0 && <small className="chat-history-empty">ยังไม่มีแชตที่บันทึกไว้</small>}
          </div>
        </div>

        <div className="runtime-card">
          <div className="status-line"><span className={`status-dot ${runtimeReady ? "ready" : "offline"}`} /><strong>{runtimeReady ? "พร้อมใช้งานในเครื่อง" : "ยังไม่พบโมเดล"}</strong></div>
          <p>{settings.model} · Ollama</p>
          <div className="memory-meter"><span style={{ width: `${memoryPercent}%` }} /></div>
          <small>RAM โมเดล {formatBytes(health?.model_memory_bytes ?? 0)} / 10 GB</small>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">{view === "chat" ? "LOCAL AI CHAT" : view === "video" ? "LOCAL AI FILM STUDIO" : view === "memory" ? "LEARNING WORKSPACE" : view === "skills" ? "SKILL REGISTRY" : view === "tickets" ? "TICKET BOT STUDIO" : "CONTROL CENTER"}</span>
            <h1>{view === "chat" ? activeChat?.title || "คุยกับอัลฟ่า" : view === "video" ? "Create Video" : view === "memory" ? "สอนและพัฒนาอัลฟ่า" : view === "skills" ? "ทักษะของอัลฟ่า" : view === "tickets" ? "สร้างบอทบัตรแบบ Full Loop" : "ตั้งค่าอัลฟ่า"}</h1>
          </div>
          {view === "chat" && activeChat && <div className="chat-top-actions"><a href={`/api/chats/${encodeURIComponent(activeChat.id)}/export?format=markdown`}>Export MD</a><a href={`/api/chats/${encodeURIComponent(activeChat.id)}/export?format=json`}>JSON</a></div>}
          <div className="internet-control">
            <div><strong>อินเทอร์เน็ต</strong><span>{settings.web_search_enabled ? "เปิดเมื่อจำเป็น" : "ปิด — อยู่ในเครื่องเท่านั้น"}</span></div>
            <Toggle checked={settings.web_search_enabled} onChange={(value) => void toggleInternet(value)} label="อนุญาตให้อัลฟ่าเข้าถึงอินเทอร์เน็ต" />
          </div>
        </header>

        {view === "chat" && (
          <div className="chat-view">
            <div className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
              {messages.length === 0 ? (
                <div className="welcome-wrap">
                  <div className="orb" aria-hidden="true"><span>α</span></div>
                  <h2>สวัสดี ฉันคืออัลฟ่า</h2>
                  <p>คิด ตอบภาษาไทย ช่วยทำโจทย์ และค้นเว็บเมื่อจำเป็น ทุกคำค้นต้องผ่านกฎของคุณก่อนออกจากเครื่อง</p>
                  <div className="suggestion-grid">
                    <button type="button" onClick={() => setDraft("อธิบายเรื่องปัญญาประดิษฐ์ให้เข้าใจง่าย")}>อธิบายเรื่องยากให้เข้าใจง่าย</button>
                    <button type="button" onClick={() => setDraft("วันนี้มีข่าวเทคโนโลยีสำคัญอะไรบ้าง?")}>ค้นข้อมูลล่าสุดพร้อมอ้างอิง</button>
                    <button type="button" onClick={() => setDraft("ช่วยทำแบบทดสอบนี้และอธิบายเหตุผลของแต่ละข้อ")}>ช่วยทำโจทย์และแบบทดสอบ</button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((message) => (
                    <article className={`message ${message.role} ${message.error ? "error" : ""}`} key={message.id}>
                      <div className="avatar">{message.role === "assistant" ? "α" : "คุณ"}</div>
                      <div className="message-body">
                        <strong>{message.role === "assistant" ? "อัลฟ่า" : "คุณ"}</strong>
                        {message.content ? <MarkdownMessage content={message.content} /> : <span className="typing-dots"><i /><i /><i /></span>}
                        {message.confirmationQuery && (
                          <div className="confirm-row">
                            <button type="button" onClick={() => void runChat(message.confirmationQuery!, true, false, message.id, message.confirmationUserId)}>อนุญาตครั้งนี้</button>
                            <button className="secondary" type="button" onClick={() => setMessages((current) => current.map((item) => item.id === message.id ? { ...item, confirmationQuery: undefined, content: "ไม่ได้ค้นเว็บตามที่คุณเลือก" } : item))}>ไม่อนุญาต</button>
                          </div>
                        )}
                        {message.permission && (
                          <div className="permission-card">
                            <div><strong>ต้องได้รับอนุญาต</strong><p>{message.permission.summary}</p></div>
                            <div className="confirm-row">
                              <button type="button" onClick={() => void confirmPermission(message.id, message.permission!.confirmationId, true)}>อนุญาต</button>
                              <button className="secondary" type="button" onClick={() => void confirmPermission(message.id, message.permission!.confirmationId, false)}>ไม่อนุญาต</button>
                            </div>
                          </div>
                        )}
                        {message.artifacts && message.artifacts.length > 0 && (
                          <div className="artifact-list">
                            {message.artifacts.map((artifact) => (
                              <ArtifactCard
                                key={artifact.id}
                                artifact={artifact}
                                onOpen={() => void openArtifact(artifact.id)}
                                onRun={() => void requestRun(message.id, artifact.id)}
                              />
                            ))}
                          </div>
                        )}
                        {message.sources && message.sources.length > 0 && (
                          <div className="source-list">
                            {message.sources.map((source, index) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>{index + 1}</span>{source.title}</a>)}
                          </div>
                        )}
                        {message.role === "assistant" && message.content && !isThinking && (
                          <div className="feedback-row">
                            <span>คำตอบนี้เป็นอย่างไร?</span>
                            <button type="button" title="มีประโยชน์" onClick={() => void submitFeedback(message.id, 1)}>ดี</button>
                            <button type="button" title="ควรแก้ไข" onClick={() => { setFeedbackMessageId(message.id); setCorrectionDraft(""); }}>ควรแก้</button>
                          </div>
                        )}
                        {feedbackMessageId === message.id && (
                          <div className="feedback-card">
                            <label><span>คำตอบที่ถูกควรเป็น...</span><textarea rows={3} value={correctionDraft} onChange={(event) => setCorrectionDraft(event.target.value)} /></label>
                            <label className="check-line"><input type="checkbox" checked={rememberCorrection} onChange={(event) => setRememberCorrection(event.target.checked)} /> ให้อัลฟ่าจำคำแก้ไขนี้</label>
                            <div className="confirm-row"><button type="button" onClick={() => void submitFeedback(message.id, -1, correctionDraft)}>บันทึก feedback</button><button className="secondary" type="button" onClick={() => setFeedbackMessageId(null)}>ยกเลิก</button></div>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  <div ref={messageEndRef} aria-hidden="true" />
                </div>
              )}
            </div>

            {showScrollLatest && (
              <button className="scroll-latest" type="button" onClick={scrollToLatest} aria-label="ไปยังข้อความล่าสุด">
                <span>↓</span> ข้อความล่าสุด
              </button>
            )}

            {activeRun && (
              <div className={"thinking-bar task-state task-" + activeRun.status} role="status" aria-live="polite">
                <div className="thinking-pulse"><span /><span /><span /></div>
                <div>
                  <strong>{activeRun.status === "completed" ? "✅ งานเสร็จแล้ว" : activeRun.status === "waiting_approval" ? "⏸ รอการอนุญาต" : activeRun.status === "failed" ? "❌ งานล้มเหลว" : activeRun.status === "blocked" ? "⛔ งานถูกบล็อก" : "🟢 อัลฟ่ากำลังทำงาน"}</strong>
                  <span>{activeRun.label}{activeRun.detail ? " — " + activeRun.detail : ""}</span>
                  {activeRun.tool && <small>Tool: {activeRun.tool}</small>}
                </div>
                <div className="thinking-track"><i /></div>
              </div>
            )}

            {isThinking && !activeRun && (
              <div className="thinking-bar" role="status" aria-live="polite">
                <div className="thinking-pulse"><span /><span /><span /></div>
                <div><strong>อัลฟ่ากำลังทำงาน</strong><span>{thinkingSteps[thinkingSteps.length - 1] ?? "กำลังคิด"}</span></div>
                <div className="thinking-track"><i /></div>
              </div>
            )}

            <div className="chat-bottom">
              <form className="composer" onSubmit={submit}>
                <textarea ref={composerInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) void runChat(draft); }
                }} placeholder="พิมพ์ข้อความถึงอัลฟ่า..." aria-label="ข้อความถึงอัลฟ่า" rows={1} />
                <div className="composer-footer">
                  <span className={settings.web_search_enabled ? "online" : "offline"}><i /> {settings.web_search_enabled ? "ค้นเว็บได้เมื่อจำเป็น" : "ไม่ส่งข้อมูลออกอินเทอร์เน็ต"}</span>
                  <button type="submit" aria-label="ส่งข้อความ" disabled={!draft.trim() || isThinking}>↑</button>
                </div>
              </form>
              <div className="token-panel">
                <div className="token-copy"><strong>Token รอบล่าสุด</strong><span>{usage.total_tokens.toLocaleString()} / {usage.context_limit.toLocaleString()}</span></div>
                <div className="token-meter"><span style={{ width: `${tokenPercent}%` }} /></div>
                <div className="token-meta"><span>รับเข้า {usage.prompt_tokens.toLocaleString()} · ตอบ {usage.response_tokens.toLocaleString()}</span><strong>จำนวนแชต ∞ ไม่คิดค่าต่อข้อความ</strong></div>
              </div>
            </div>
          </div>
        )}

        {view === "video" && <CreateVideoStudio />}

        {view === "memory" && (
          <div className={`content-view memory-view tab-${learningTab}`}>
            <nav className="learning-tabs" aria-label="โหมดการเรียนรู้">
              <button type="button" className={learningTab === "memory" ? "active" : ""} onClick={() => setLearningTab("memory")}>ความจำ</button>
              <button type="button" className={learningTab === "auto" ? "active" : ""} onClick={() => setLearningTab("auto")}>Auto Learn</button>
              <button type="button" className={learningTab === "lab" ? "active" : ""} onClick={() => setLearningTab("lab")}>Skill Lab</button>
            </nav>
            {learningTab === "memory" && <section className="hero-card learning-control-card">
              <span className="section-kicker">ALPHA MEMORY</span>
              <h2>ให้อัลฟ่าเรียนรู้แบบที่คุณควบคุมได้</h2>
              <p>เพิ่มข้อเท็จจริง ความชอบ หรือรายละเอียดงาน อัลฟ่าจะดึงมาใช้เมื่อคำถามเกี่ยวข้อง และคุณลบออกได้ทุกเมื่อ</p>
              <form className="teach-form" onSubmit={addManualMemory}>
                <textarea value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} placeholder="ตัวอย่าง: ฉันชอบคำตอบภาษาไทยแบบสั้น กระชับ และมีตัวอย่าง" rows={3} />
                <button type="submit" disabled={!memoryDraft.trim()}>สอนอัลฟ่า</button>
              </form>
            </section>}

            {learningTab === "auto" && <section className="auto-learn-card learning-fill-card">
              <div className="section-heading">
                <div><span className="section-kicker">AUTONOMOUS LEARNING</span><h3>Auto Learn จากงานที่คุณใช้จริง</h3></div>
                <span className={`auto-learn-badge ${autoLearnJob?.status === "running" ? "active" : ""}`}>{autoLearnJob?.status === "running" ? "กำลังเรียนรู้" : autoLearnJob?.status === "completed" ? "ครบเวลาแล้ว" : autoLearnJob?.status === "stopped" ? "เรียกกลับแล้ว" : "พร้อม"}</span>
              </div>
              <p className="training-intro">อัลฟ่าจะวิเคราะห์แนวงานจากแชตล่าสุดแล้วเลือกสิ่งที่ช่วยคุณมากที่สุด เช่น เมื่อเขียนโปรแกรมบ่อยจะต่อยอด framework, debugging, testing, architecture, UX, performance และ cybersecurity โดยเทียบประวัติเพื่อไม่วนเรียนแบบเดิมโดยไม่มีพัฒนาการ</p>
              <div className="auto-learn-controls">
                <label className="round-select"><span>ระยะเวลา</span><select value={autoLearnDuration} disabled={autoLearnJob?.status === "running"} onChange={(event) => setAutoLearnDuration(Number(event.target.value))}><option value="0">∞ ไม่จำกัด — จนกดเรียกกลับ</option><option value="15">15 นาที</option><option value="30">30 นาที</option><option value="60">1 ชั่วโมง</option><option value="120">2 ชั่วโมง</option><option value="240">4 ชั่วโมง</option><option value="480">8 ชั่วโมง</option><option value="1440">ทั้งวัน (24 ชั่วโมง)</option></select></label>
                <button className="auto-start" type="button" disabled={autoLearnJob?.status === "running" || !settings.web_search_enabled} onClick={() => void startAutoLearning()}>▶ เริ่ม Auto Learn</button>
                <button className="auto-stop" type="button" disabled={autoLearnJob?.status !== "running"} onClick={() => void stopAutoLearning()}>↩ เรียกกลับและสรุปผล</button>
                {!settings.web_search_enabled && <span className="auto-note">เปิดสวิตช์อินเทอร์เน็ตก่อนเริ่ม</span>}
              </div>
              {(autoLearnJob?.status === "running" || autoLearnJob?.report) && (
                <div className="auto-learn-status" role="status">
                  <div className="auto-status-line"><div><strong>{autoLearnStage}</strong><span>{autoLearnJob.current_topic || autoLearnJob.report?.summary || "กำลังเตรียมงาน"}</span></div><b>{autoLearnJob.findings?.length ?? 0} รอบ</b></div>
                  <div className="auto-runtime-meta"><span>Tool: {autoLearnJob.current_tool || "—"}</span><span>Attempt: {autoLearnJob.current_attempt || 0}</span><span>Skill backlog: {autoLearnJob.skill_backlog_count ?? health?.tool_service.skill_backlog_count ?? 0}</span>{autoLearnUnlimited && <span>เวลา: ∞ ไม่จำกัด</span>}<span>อัปเดต: {autoLearnJob.last_activity_at ? new Date(autoLearnJob.last_activity_at).toLocaleTimeString("th-TH") : "—"}</span></div>
                  <div className={`auto-progress ${autoLearnUnlimited ? "indeterminate" : ""}`}><i style={autoLearnUnlimited ? undefined : { width: `${autoLearnProgress}%` }} /></div>
                </div>
              )}
              {autoLearnError && <div className="auto-learn-error">{autoLearnError}</div>}
              {autoLearnStalled && <div className="auto-stalled"><strong>อาจค้าง — ไม่มี event ใหม่ตามเวลาที่ตั้งไว้</strong><button type="button" onClick={() => autoLearnJob?.id && void fetch(`/api/auto-learn/runs/${encodeURIComponent(autoLearnJob.id)}/retry`, { method: "POST" })}>Retry</button><button type="button" onClick={() => autoLearnJob?.id && void fetch(`/api/auto-learn/runs/${encodeURIComponent(autoLearnJob.id)}/skip`, { method: "POST" })}>Skip</button><button type="button" onClick={() => void stopAutoLearning()}>เรียกกลับและสรุป</button></div>}
              <div className="auto-panels">
                <section className="auto-panel"><div className="auto-panel-head"><strong>Timeline ทั้งหมด</strong><span>{autoLearnEvents.length} events</span></div><div className="auto-live-log">{autoLearnEvents.map((item) => <article key={item.id}><time>{new Date(item.at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><strong>{item.label}</strong><span>{item.detail || `${item.stage} · ${item.current_tool}`}</span></div></article>)}{autoLearnHasMore && <button className="load-more" type="button" onClick={() => void loadAutoLearnEvents()}>โหลดอีก 50 รายการ</button>}{!autoLearnEvents.length && <div className="empty-state">ยังไม่มี event — เริ่ม Auto Learn เพื่อดูสถานะแบบสด</div>}</div></section>
                <section className="auto-panel"><div className="auto-panel-head"><strong>ผลการเรียนและสกิล</strong><span>{autoLearnJob?.findings?.length ?? 0} รอบ</span></div><div className="auto-results-scroll"><div className="auto-findings">{(autoLearnJob?.findings?.length ?? 0) === 0 && <div className="empty-state">ผลสำเร็จจะปรากฏที่นี่ ไม่ติดตั้งสกิลที่ test ไม่ผ่าน</div>}{autoLearnJob?.findings?.map((item, index) => <article key={`${item.title}-${index}`} className={item.success ? "passed" : "failed"}><span>{item.success ? "✓" : item.recalled ? "↩" : "!"}</span><div><strong>{item.title}</strong><p>{item.summary || item.why_new}{item.progression_from ? ` · ต่อยอดจาก ${item.progression_from}` : ""}</p><small>{item.mode === "skill" ? `${item.skill ? `ติดตั้งสกิลแล้ว: ${item.skill.name || item.skill.id}` : item.recalled ? "Recall ระหว่างทดสอบ—บันทึก checkpoint แล้ว" : "ทดสอบแล้วแต่ยังไม่ผ่าน จึงยังไม่ติดตั้ง"} · ${item.rounds || item.checkpoint?.attempts_completed || 0} attempts` : "ความรู้"} · คะแนนหลักฐาน {item.confidence || 0}%</small></div></article>)}</div>{autoLearnJob?.report && <div className="auto-final-report"><div><strong>สรุปหลังเรียกกลับ</strong><span>{autoLearnJob.report.duration_minutes ?? 0} นาที</span></div><p>{autoLearnJob.report.summary}</p>{autoLearnJob.report.skill_summary && <div className="auto-skill-summary"><span>ทดสอบ {autoLearnJob.report.skill_summary.tested ?? 0}</span><span>พร้อมใช้ {autoLearnJob.report.skill_summary.installed ?? 0}</span><span>ยังไม่ผ่าน {autoLearnJob.report.skill_summary.failed ?? 0}</span><span>มี checkpoint {autoLearnJob.report.skill_summary.recalled ?? 0}</span></div>}<small>{autoLearnJob.report.stop_reason}</small>{autoLearnJob.report.cleanup && <small>Cleanup: container {autoLearnJob.report.cleanup.containers_removed ?? 0} ตัว · staging {autoLearnJob.report.cleanup.staging_removed ? "ลบแล้ว" : autoLearnJob.report.cleanup.orphaned_path ? "พบไฟล์กำพร้า—ไม่ลบเพราะไม่มีทะเบียนเจ้าของ" : "ไม่มี"}</small>}{(autoLearnJob.artifacts?.length ?? 0) > 0 && <div className="auto-report-links">{autoLearnJob.artifacts!.map((artifact) => <a key={artifact.id} href={`/api/artifacts/${encodeURIComponent(artifact.id)}`} download={artifact.name}>ดาวน์โหลด {artifact.name}</a>)}</div>}</div>}</div></section>
              </div>
            </section>}

            {learningTab === "lab" && <section className="training-card learning-fill-card">
              <div className="section-heading">
                <div><span className="section-kicker">ALPHA SKILL LAB</span><h3>Full loop: สร้าง ทดสอบ แก้ แล้วติดตั้งทักษะ</h3></div>
                <span>Docker sandbox · ล้าง env อัตโนมัติ</span>
              </div>
              <p className="training-intro">กำหนดเป้าหมายและเกณฑ์ผ่าน อัลฟ่าจะค้นเอกสารจากเว็บ วางแผน สร้าง environment แยก ทดลอง อ่าน error และแก้ซ้ำเองโดยไม่ถามระหว่างทาง เมื่อผ่านจะเหลือเฉพาะสกิลกับรายงาน ส่วน environment และของชั่วคราวจะถูกลบทิ้ง</p>
              <form className="training-form" onSubmit={trainAlpha}>
                <label className="round-select"><span>โหมด</span><select value={trainingMode} onChange={(event) => setTrainingMode(event.target.value as TrainingMode)}><option value="skill">สร้างความสามารถ</option><option value="research">ค้นคว้าความรู้</option></select></label>
                <div className="field"><span>{trainingMode === "skill" ? "เป้าหมายความสามารถ" : "หัวข้อที่ต้องศึกษา"}</span><input value={trainingTopic} onChange={(event) => setTrainingTopic(event.target.value)} placeholder={trainingMode === "skill" ? "เช่น รับไฟล์ CSV แล้วสร้างกราฟ SVG พร้อมสรุป" : "เช่น วิธีทำข้าวมันไก่ตั้งแต่วัตถุดิบถึงน้ำจิ้ม"} /></div>
                <div className="field"><span>เกณฑ์ที่ถือว่าสำเร็จ</span><input value={trainingCriteria} onChange={(event) => setTrainingCriteria(event.target.value)} disabled={trainingMode === "research"} placeholder={trainingMode === "skill" ? "เช่น ทดสอบ 3 input, ได้ไฟล์ .svg และผลรวมถูกต้อง" : "โหมดค้นคว้าใช้เป้าความครบถ้วน 85%"} /></div>
                <label className="round-select"><span>{trainingMode === "skill" ? "Attempt สูงสุด" : "รอบค้นสูงสุด"}</span><select value={trainingRounds} onChange={(event) => setTrainingRounds(Number(event.target.value))}><option value="1">1 รอบ</option><option value="2">2 รอบ</option><option value="3">3 รอบ</option><option value="4">4 รอบ</option><option value="5">5 รอบ</option>{trainingMode === "skill" && <><option value="6">6 รอบ</option><option value="8">8 รอบ</option></>}</select></label>
                <button type="submit" disabled={trainingActive || !trainingTopic.trim()}>{trainingActive ? "กำลังฝึก..." : "เริ่มฝึกอัลฟ่า"}</button>
              </form>
              {(trainingActive || trainingStatus) && (
                <div className="training-progress" role="status">
                  <div className={`training-spinner ${trainingActive ? "active" : ""}`}>α</div>
                  <div><strong>{trainingStatus}</strong><span>{trainingActive ? "ทำงานอัตโนมัติเต็ม loop และหยุดเมื่อผ่านหรือมีเหตุผลว่าทำต่อไม่ได้" : "จบรอบการฝึก"}</span></div>
                </div>
              )}
              {trainingLog.length > 0 && <div className="training-log">{trainingLog.map((item) => <article key={item.round}><span>{item.round}</span><div><strong>{item.query}</strong><p>ความครบถ้วน {item.confidence}%{item.gaps.length ? ` · ยังขาด: ${item.gaps.join(", ")}` : " · ไม่พบช่องว่างสำคัญ"}</p></div></article>)}</div>}
              {trainingResult && <div className={`training-result ${trainingResult.success === false ? "failed" : ""}`}><div><strong>{trainingResult.success === false ? "ไม่ผ่าน" : `${trainingResult.confidence}%`}</strong><span>{trainingResult.skill_name ? `สกิล ${trainingResult.skill_name} · ` : ""}{trainingResult.rounds} รอบ</span></div><p>{trainingResult.summary}</p><small>{trainingResult.cleanup || (trainingResult.reached_target ? "ถึงเป้าหมายและบันทึกแล้ว" : trainingResult.reason || "ถึงจำนวนรอบสูงสุด")}</small></div>}
            </section>}

            {learningTab === "memory" && <section className="settings-card">
              <div className="setting-row">
                <div><strong>ใช้ความจำในการตอบ</strong><p>ค้นเฉพาะรายการที่เกี่ยวข้องกับคำถาม</p></div>
                <Toggle checked={settings.memory_enabled} onChange={(value) => updateSettings({ memory_enabled: value })} label="ใช้ความจำ" />
              </div>
              <div className="setting-row">
                <div><strong>เรียนรู้จากบทสนทนาอัตโนมัติ</strong><p>คัดเลือกเฉพาะข้อมูลระยะยาว ไม่บันทึกรหัสผ่านหรือข้อมูลอ่อนไหว</p></div>
                <Toggle checked={settings.auto_learn_enabled} onChange={(value) => updateSettings({ auto_learn_enabled: value })} label="เรียนรู้อัตโนมัติ" />
              </div>
              <div className="setting-row">
                <div><strong>จำข้อมูลข้ามแชต</strong><p>ดึงความจำและสรุปแชตเก่าที่เกี่ยวข้องมาใช้ในแชตใหม่</p></div>
                <Toggle checked={settings.cross_chat_memory_enabled} onChange={(value) => updateSettings({ cross_chat_memory_enabled: value })} label="จำข้ามแชต" />
              </div>
              <div className="setting-row">
                <div><strong>สรุปแชตยาวอัตโนมัติ</strong><p>เก็บข้อความเต็มไว้ แต่ใช้บทสรุปเพื่อลด context และ RAM</p></div>
                <Toggle checked={settings.auto_summarize_enabled} onChange={(value) => updateSettings({ auto_summarize_enabled: value })} label="สรุปแชตอัตโนมัติ" />
              </div>
              <button className="save-button compact" type="button" onClick={() => void persistSettings(settings)}>บันทึกการตั้งค่าความจำ</button>
            </section>}

            {learningTab === "memory" && <section className="memory-list-section memory-scroll-card">
              <div className="section-heading"><div><span className="section-kicker">SAVED KNOWLEDGE</span><h3>สิ่งที่อัลฟ่าจำอยู่</h3></div><span>{memories.length} รายการ</span></div>
              <div className="memory-list">
                {memories.length === 0 && <div className="empty-state">ยังไม่มีความจำ ลองสอนอัลฟ่าด้วยช่องด้านบน</div>}
                {memories.map((memory) => (
                  <article key={memory.id}><span className="memory-icon">{memory.pinned ? "★" : "◇"}</span><div><p>{memory.content}</p><small>{memory.source === "auto" ? "เรียนรู้จากบทสนทนา" : memory.source === "research" ? "เรียนรู้จากโหมดฝึก" : memory.source === "correction" ? "คำแก้ไขที่คุณให้ไว้" : "คุณสอนโดยตรง"} · {new Date(memory.created_at).toLocaleDateString("th-TH")}</small></div><div className="memory-actions"><button type="button" onClick={() => void patchMemory(memory.id, { pinned: !memory.pinned })}>{memory.pinned ? "เลิกปัก" : "ปักหมุด"}</button><button type="button" onClick={() => { const value = window.prompt("แก้ไขความจำ", memory.content); if (value?.trim()) void patchMemory(memory.id, { content: value }); }}>แก้ไข</button><button type="button" onClick={() => void removeMemory(memory.id)}>ลบ</button></div></article>
                ))}
              </div>
            </section>}
          </div>
        )}

        {view === "skills" && (
          <div className="skills-workspace">
            <aside className="skills-list-pane">
              <div className="skills-toolbar">
                <input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="ค้นหาชื่อ คำอธิบาย trigger หรือ dependency..." aria-label="ค้นหาสกิล" />
                <div>
                  <select value={skillStatus} onChange={(event) => setSkillStatus(event.target.value)} aria-label="กรองสถานะ"><option value="">ทุกสถานะ</option><option value="enabled">Enabled</option><option value="verified">Verified</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="stale">Stale</option></select>
                  <select value={skillOrigin} onChange={(event) => setSkillOrigin(event.target.value)} aria-label="กรองแหล่งที่มา"><option value="">ทุกแหล่ง</option><option value="auto_learn">Auto Learn</option><option value="skill_lab">Skill Lab</option></select>
                  <select value={skillSort} onChange={(event) => setSkillSort(event.target.value)} aria-label="เรียงสกิล"><option value="latest">ล่าสุด</option><option value="used">ใช้บ่อย</option><option value="success_rate">Success rate</option><option value="confidence">Confidence</option><option value="name">ชื่อ</option></select>
                </div>
                <span>ทั้งหมด {skillTotal.toLocaleString()} สกิล · โหลดแล้ว {skills.length.toLocaleString()}</span>
              </div>
              <div className="skills-virtual-list" ref={skillListRef} onScroll={(event) => {
                const element = event.currentTarget;
                setSkillListScrollTop(element.scrollTop);
                if (skillCursor && element.scrollHeight - element.scrollTop - element.clientHeight < 280) void loadSkills(false, skillCursor);
              }}>
                <div className="skills-virtual-spacer" style={{ height: `${skills.length * skillRowHeight}px` }}>
                  {visibleSkills.map((skill, index) => (
                    <button type="button" key={skill.id} className={`skill-list-item ${selectedSkillId === skill.id ? "active" : ""}`} style={{ top: `${(skillStart + index) * skillRowHeight}px` }} onClick={() => void loadSkillDetail(skill.id)}>
                      <div><strong>{skill.name}</strong><span className={`skill-state ${skill.verification_status}`}>{skill.verification_status || "untested"}</span></div>
                      <p>{skill.description}</p>
                      <small>{skill.runtime} · {skill.origin === "auto_learn" ? "Auto Learn" : "Skill Lab"} · Verified {Number(skill.verified_pass_rate || 0).toFixed(0)}% · Confidence {Number(skill.generalization_confidence || 0).toFixed(1)}%</small>
                    </button>
                  ))}
                </div>
                {!skills.length && <div className="empty-state">ยังไม่มีสกิลที่ติดตั้ง หรือไม่พบสกิลตามตัวกรอง</div>}
              </div>
            </aside>

            <section className="skill-detail-pane">
              {!selectedSkill ? <div className="skill-detail-empty"><span>⬡</span><strong>เลือกสกิลเพื่อดูรายละเอียด</strong><p>สกิลที่ผ่าน test เท่านั้นจึงจะถูกติดตั้งในรายการนี้</p></div> : <>
                <header className="skill-detail-header">
                  <div><span className="section-kicker">{selectedSkill.manifest.origin === "auto_learn" ? "AUTO LEARN SKILL" : "SKILL LAB"}</span><h2>{selectedSkill.manifest.name}</h2><p>{selectedSkill.manifest.description}</p></div>
                  <div className="skill-detail-actions"><button type="button" onClick={() => void runSkillAction("run")}>Run</button><button type="button" onClick={() => void runSkillAction("test")}>Test</button><button type="button" onClick={() => void runSkillAction("reverify")}>Reverify</button><button type="button" onClick={() => void runSkillAction("retrain")}>Retrain</button><button type="button" onClick={() => void toggleSelectedSkill()}>{selectedSkill.manifest.enabled === false ? "Enable" : "Disable"}</button><button type="button" onClick={() => void runSkillAction("export")}>Export ZIP</button><button type="button" onClick={() => void runSkillAction("open")}>เปิดโฟลเดอร์</button><button className="danger" type="button" onClick={() => void deleteSelectedSkill()}>ลบ</button></div>
                </header>
                {skillActionStatus && <div className="skill-action-status">{skillActionStatus}</div>}
                <nav className="skill-detail-tabs">{(["overview", "verification", "runs", "files", "history"] as SkillDetailTab[]).map((tab) => <button type="button" key={tab} className={skillDetailTab === tab ? "active" : ""} onClick={() => setSkillDetailTab(tab)}>{tab === "overview" ? "Overview" : tab === "verification" ? "Verification" : tab === "runs" ? "Runs" : tab === "files" ? "Files" : "History"}</button>)}</nav>
                <div className="skill-detail-scroll">
                  {skillDetailTab === "overview" && <div className="skill-overview-grid"><article><span>Runtime</span><strong>{selectedSkill.manifest.runtime}</strong><small>{selectedSkill.manifest.entrypoint}</small></article><article><span>Execution</span><strong>{selectedSkill.manifest.execution_targets?.includes("macos_host") ? "Dual runtime" : "Sandbox"}</strong><small>{selectedSkill.manifest.execution_targets?.join(" + ") || "sandbox"}</small></article><article><span>Version</span><strong>v{selectedSkill.manifest.version || 1}</strong><small>{selectedSkill.manifest.environment_fingerprint}</small></article><article><span>Dependencies</span><strong>{selectedSkill.manifest.dependencies?.length || 0}</strong><small>{selectedSkill.manifest.dependencies?.join(", ") || "stdlib"}</small></article><article><span>ใช้งาน</span><strong>{selectedSkill.manifest.usage_count || 0}</strong><small>สำเร็จ {selectedSkill.manifest.success_count || 0} ครั้ง</small></article><section><h3>Triggers</h3>{selectedSkill.manifest.trigger_examples?.map((item) => <span className="tag" key={item}>{item}</span>)}</section><section><h3>ขอบเขตที่รับรอง</h3><p>{selectedSkill.manifest.verification_scope || "ยังไม่ได้ระบุ"}</p></section></div>}
                  {skillDetailTab === "verification" && <div className="verification-grid"><article className="verification-score"><span>Verified pass rate</span><strong>{Number(selectedSkill.manifest.verified_pass_rate || 0).toFixed(1)}%</strong><p>ผ่าน {selectedSkill.manifest.verified_passed || 0}/{selectedSkill.manifest.verified_total || 0} tests ในชุดรับรอง</p></article><article className="verification-score confidence"><span>Generalization confidence</span><strong>{Number(selectedSkill.manifest.generalization_confidence || 0).toFixed(1)}%</strong><p>Wilson 95% lower bound · sample {selectedSkill.manifest.confidence_sample_size || selectedSkill.manifest.hidden_test_result?.total || 0}</p></article><section><h3>ความหมายของคะแนน</h3><p>Verified 100% หมายถึงผ่านทุก test ในขอบเขตด้านล่าง ไม่ได้แปลว่าไม่มีทางผิดกับ input หรือเว็บไซต์ที่ไม่เคยทดสอบ ส่วน Confidence ประเมินแบบ conservative จาก hidden validation และประวัติใช้งานจริง ไม่ใช่ตัวเลขที่ LLM เดาเอง</p><pre>{JSON.stringify(selectedSkill.report, null, 2)}</pre></section></div>}
                  {skillDetailTab === "runs" && <div className="detail-list"><article><strong>จำนวนรันทั้งหมด</strong><span>{selectedSkill.manifest.usage_count || 0}</span></article><article><strong>สำเร็จ</strong><span>{selectedSkill.manifest.success_count || 0}</span></article><article><strong>รันล่าสุด</strong><span>{selectedSkill.manifest.last_run_at ? new Date(selectedSkill.manifest.last_run_at).toLocaleString("th-TH") : "ยังไม่เคยรัน"}</span></article><article><strong>Runtime ล่าสุด</strong><span>{selectedSkill.manifest.last_execution_target || "ยังไม่เคยรัน"}</span></article>{selectedSkill.manifest.last_error && <article className="error"><strong>Error ล่าสุด</strong><span>{selectedSkill.manifest.last_error}</span></article>}</div>}
                  {skillDetailTab === "files" && <div className="detail-list">{selectedSkill.files.map((file) => <article key={file.path}><strong>{file.path}</strong><span>อยู่ในโฟลเดอร์สกิล</span></article>)}</div>}
                  {skillDetailTab === "history" && <div className="detail-list"><article><strong>ติดตั้ง</strong><span>{new Date(selectedSkill.manifest.installed_at).toLocaleString("th-TH")}</span></article><article><strong>อัปเดต</strong><span>{new Date(selectedSkill.manifest.updated_at).toLocaleString("th-TH")}</span></article><article><strong>Environment fingerprint</strong><span>{selectedSkill.manifest.environment_fingerprint}</span></article><article><strong>แหล่งที่มา</strong><span>{selectedSkill.manifest.origin}</span></article></div>}
                </div>
              </>}
            </section>
          </div>
        )}

        {view === "tickets" && (
          <div className="ticket-workspace">
            <aside className="ticket-discovery-pane">
              <div className="ticket-pane-header">
                <div><span className="section-kicker">STEP 1 · DISCOVER</span><h2>เลือกคอนเสิร์ต</h2></div>
                <span className={`ticket-stage ${ticketStage}`}>{ticketRun?.payment_handoff_verified ? "Full Loop ผ่าน" : ticketRunActive ? "กำลังรันจริง" : ticketBuildReport ? "Fixture เท่านั้น" : ticketStage === "inspecting" || ticketStage === "form_inspecting" || ticketStage === "building" ? "กำลังทำงาน" : ticketStage === "error" ? "ไม่ผ่าน" : "รอข้อมูล"}</span>
              </div>
              <div className="ticket-source-form">
                <label><span>หน้ารวมคอนเสิร์ตหรือหน้ากิจกรรม</span><input value={ticketSourceUrl} onChange={(event) => setTicketSourceUrl(event.target.value)} placeholder="https://www.thaiticketmajor.com/index.html" /></label>
                <button type="button" disabled={!settings.web_search_enabled || ticketStage === "inspecting"} onClick={() => void inspectTicketEvents()}>{ticketStage === "inspecting" ? "กำลังตรวจ…" : "ตรวจคอนเสิร์ต"}</button>
              </div>
              <div className="ticket-status-card">
                <span className="ticket-status-dot" />
                <div><strong>สถานะการตรวจและรันจริง</strong><p>{ticketStatus}</p></div>
              </div>
              {ticketEvents.length > 0 && <div className="ticket-status-legend" aria-label="กรองสถานะคอนเสิร์ต">
                <button type="button" className={`ticket-status-filter ${ticketStatusFilter === "all" ? "active" : ""}`} onClick={() => setTicketStatusFilter("all")}>ทั้งหมด {ticketEvents.length}</button>
                {TICKET_SALE_STATUS_ORDER.map((status) => {
                  const count = ticketEvents.filter((event) => (event.sale_status || "unknown") === status).length;
                  const meta = ticketSaleStatus(status);
                  return <button type="button" key={status} className={`ticket-sale-pill ticket-status-filter ${meta.className} ${ticketStatusFilter === status ? "active" : ""} ${count === 0 ? "empty" : ""}`} onClick={() => setTicketStatusFilter(status)}>{meta.label} {count}</button>;
                })}
              </div>}
              <div className="ticket-event-list">
                {ticketEvents.filter((event) => ticketStatusFilter === "all" || (event.sale_status || "unknown") === ticketStatusFilter).map((event) => {
                  const selectable = event.selectable !== false && ["open", "upcoming"].includes(event.sale_status || "unknown");
                  const saleMeta = ticketSaleStatus(event.sale_status);
                  return (
                  <label className={`ticket-event-card ${ticketSelectedId === event.id ? "selected" : ""} ${selectable ? "" : "unavailable"}`} key={event.id}>
                    <input type="radio" name="ticket-event" disabled={!selectable} checked={ticketSelectedId === event.id} onChange={() => {
                      setTicketSelectedId(event.id);
                      setTicketProjectName("");
                      const cachedInspection = event.cached_inspection ?? null;
                      const cachedOptions = normalizedTicketPerformanceOptions(event.performance_options ?? cachedInspection?.facts?.performance_options);
                      setTicketSchedule(cachedOptions.length === 1 ? ticketPerformanceValue(cachedOptions[0]) : cachedOptions.length > 1 ? "" : event.show_dates?.[0]?.iso || event.show_dates?.[0]?.raw || event.start_date || "");
                      setTicketQueueOpenAt(event.queue_open_at || cachedInspection?.facts?.queue_open_at || "");
                      setTicketInspection(cachedInspection);
                      setTicketBuildReport(null);
                      setTicketStage(cachedInspection ? "preferences" : "event_ready");
                      setTicketStatus(cachedInspection
                        ? `เลือก ${event.name} แล้ว · ใช้วันแสดงที่ตรวจไว้ในรอบล่าสุดทันที${cachedOptions.length > 1 ? " · กรุณาเลือกวันที่ต้องการก่อนเข้าคิว" : ""}`
                        : `เลือก ${event.name} แล้ว แต่ยังอ่านวันแสดงไม่ได้จากการตรวจรอบนี้ กดตรวจคอนเสิร์ตอีกครั้งหรือใช้ตรวจรายละเอียดเฉพาะงาน`);
                      void inspectSelectedTicketEvent(event);
                    }} />
                    <span>
                      <span className="ticket-event-title"><strong>{event.name}</strong><span className={`ticket-sale-pill ${saleMeta.className}`}>{saleMeta.label}</span></span>
                      <small>{event.start_date ? `วันแสดง ${event.start_date}` : "ตรวจรอบจากหน้าถัดไป"}</small>
                      <small>{event.sale_open_at ? `เวลาเปิดช่วงขาย ${event.sale_open_at}` : event.status_evidence || (selectable ? "เลือกเพื่อตรวจรายละเอียดต่อได้" : "แสดงไว้เพื่อบอกสถานะ แต่สร้างบอทไม่ได้")}</small>
                      {normalizedTicketPerformanceOptions(event.performance_options).length ? <small>รอบที่บันทึกไว้: {normalizedTicketPerformanceOptions(event.performance_options).map(ticketPerformanceLabel).join(" · ")}</small> : null}
                      {event.schedule_status === "cached" ? <small className="ticket-inventory-warning">ใช้วันแสดงจากฐานข้อมูลครั้งก่อน เพราะหน้าเว็บปฏิเสธการตรวจรอบนี้</small> : null}
                      {selectable && <small className="ticket-inventory-warning">สถานะที่นั่ง: ยังไม่ได้ตรวจ — ต้อง Login แล้วเข้าโซน/ผังที่นั่งจริง</small>}
                    </span>
                  </label>
                );})}
                {!ticketEvents.length && <div className="ticket-empty"><span>▱</span><strong>ยังไม่มีรายการคอนเสิร์ต</strong><p>ระบบจะแสดงทุกสถานะที่เว็บไซต์ต้นทางส่งมา</p></div>}
                {ticketEvents.length > 0 && !ticketEvents.some((event) => ticketStatusFilter === "all" || (event.sale_status || "unknown") === ticketStatusFilter) && <div className="ticket-empty"><span>0</span><strong>หน้ารวมไม่พบป้ายสถานะนี้</strong><p>ไม่ได้แปลว่า inventory ทุกงานยังมีบัตร — ต้องตรวจงานที่เลือกหลัง Login</p></div>}
              </div>
              <div className="ticket-discovery-actions">
                <button type="button" disabled={!ticketSelectedId || ticketStage === "form_inspecting"} onClick={() => void inspectSelectedTicketEvent()}>{ticketStage === "form_inspecting" ? "กำลังอ่านหน้าเว็บ…" : "ตรวจรายละเอียดอีกครั้ง"}</button>
              </div>
            </aside>

            <section className="ticket-config-pane">
              <header className="ticket-config-header">
                <div><span className="section-kicker">STEP 2–3 · CONFIGURE & BUILD</span><h2>ตั้งค่าบอทและวิธีชำระเงิน</h2><p>ระบบสร้าง Python+Playwright state machine และแยกผล fixture, หน้าจริง, คิวจริง และ checkout จริงออกจากกัน</p></div>
                <div className="ticket-loop-steps"><span className={ticketEvents.length ? "done" : ""}>1 ตรวจงาน</span><span className={ticketInspection ? "done" : ""}>2 อ่านฟอร์ม</span><span className={ticketBuildReport?.ok ? "done" : ""}>3 สร้างโปรเจกต์</span><span className={ticketRunActive ? "done" : ""}>4 รันจริง</span></div>
              </header>
              <div className="ticket-config-scroll">
                {!ticketSelectedId ? <div className="ticket-config-empty"><span>←</span><strong>เลือกคอนเสิร์ตจากฝั่งซ้ายก่อน</strong><p>จากนั้นอัลฟ่าจะตรวจหน้าเว็บจริงและนำฟิลด์ที่พบมาใช้สร้าง config</p></div> : (
                  <form className="ticket-build-form" onSubmit={buildTicketBot}>
                    <section className="ticket-selected-summary">
                      <div><span>คอนเสิร์ตที่เลือก</span><strong>{ticketEvents.find((event) => event.id === ticketSelectedId)?.name}</strong><small>{ticketEvents.find((event) => event.id === ticketSelectedId)?.url}</small></div>
                      <span className={ticketInspection?.functional_preflight?.public_page_verified ? "verified" : "pending"}>{ticketInspection?.functional_preflight?.public_page_verified ? "ตรวจหน้าแล้ว" : ticketInspection?.functional_preflight?.runtime_discovery_required ? "ค้นต่อเมื่อรัน" : "รอตรวจหน้า"}</span>
                    </section>

                    {ticketInspection && <section className="ticket-evidence-card">
                      <div><strong>หลักฐานจากหน้าเว็บ</strong><span>{ticketInspection.functional_preflight?.public_page_verified ? "ยืนยันข้อมูลสาธารณะแล้ว" : ticketInspection.functional_preflight?.runtime_discovery_required ? "เว็บบล็อกหน้ารายละเอียด — จะค้นต่อเมื่อรัน" : "หลักฐานยังไม่ครบ"} · {ticketInspection.api_calls.length} API calls</span></div>
                      <p>สถานะ: {ticketInspection.functional_preflight?.workflow_state || "unknown"} · วันแสดง: {ticketInspection.facts?.show_dates?.[0]?.raw || ticketInspection.facts?.show_dates?.[0]?.iso || "ไม่พบ"} · เปิดขาย: {ticketInspection.facts?.sale_open_at_raw || ticketInspection.facts?.sale_open_at || "ไม่พบ"}</p>
                      <p>การตรวจสอบรายการใช้หน้าสาธารณะโดยไม่ล็อกอิน{ticketInspection.page?.used_public_fallback ? ` · หน้าแรกถูกปฏิเสธ จึงใช้หน้า official สำรอง ${ticketInspection.page.inspection_url || ""}` : ""} ส่วนโปรแกรมจริงจะต้องยืนยัน Login ก่อน Checkout</p>
                      {ticketInspection.facts?.prices?.length ? <p>ราคาที่อ่านได้: {ticketInspection.facts.prices.map((price) => price.toLocaleString()).join(" / ")} บาท</p> : null}
                      <p>ปุ่มเข้าซื้อ: {ticketInspection.functional_preflight?.purchase_controls_ready ? "พบจาก DOM จริง" : ticketInspection.functional_preflight?.workflow_state === "pre_sale" ? "ยังไม่เปิด (COMING SOON)" : "ยังยืนยันไม่ได้"}</p>
                      {ticketInspection.functional_preflight?.unresolved?.length ? <p>ข้อมูลที่ยังขาด: {ticketInspection.functional_preflight.unresolved.join(", ")} — ระบบจะไม่สร้างผลผ่านปลอม</p> : null}
                      {ticketInspection.ambiguous_roles.length > 0 && <p>ฟิลด์ที่มีหลายตัวเลือก: {ticketInspection.ambiguous_roles.join(", ")} — จะไม่ใช้ปุ่ม submit ทั่วไปแทนปุ่มซื้อ</p>}
                      {ticketInspection.api_warning && <p>{ticketInspection.api_warning}</p>}
                    </section>}

                    <section className="ticket-form-section">
                      <div className="ticket-form-heading"><span>01</span><div><strong>รอบและประเภทบัตร</strong><small>รองรับทั้งเลือกที่นั่งและบัตรยืน/ไม่ระบุที่นั่ง</small></div></div>
                      <div className="ticket-form-grid">
                        <label className="field"><span>รอบ/วันแสดง</span>{currentTicketPerformanceOptions.length ? <select value={ticketSchedule} onChange={(event) => setTicketSchedule(event.target.value)}><option value="">{currentTicketPerformanceOptions.length > 1 ? "กรุณาเลือกวันแสดงก่อนเข้าคิว" : "เลือกรอบ"}</option>{currentTicketPerformanceOptions.map((option, index) => <option key={`${ticketPerformanceValue(option)}-${index}`} value={ticketPerformanceValue(option)} disabled={["sold_out", "closed"].includes(option.status || "")}>{ticketPerformanceLabel(option)}</option>)}</select> : <input value={ticketSchedule} onChange={(event) => setTicketSchedule(event.target.value)} placeholder="ยังไม่พบรอบอัตโนมัติ — ระบุวันที่/เวลาที่ประกาศไว้" />}<small>{currentTicketPerformanceOptions.length ? "ระบบจะแสดงประเภทสินค้าและสถานะรายรอบ ล็อกรอบที่เลือกก่อนเข้าคิว และไม่ถามใหม่หลังผ่านคิว" : "ถ้ายังไม่มีปุ่มซื้อ ระบบจะจับคู่วันที่นี้กับปุ่มที่ปรากฏภายหลังโดยไม่ออกจากคิว"}</small></label>
                        <label className="field"><span>เวลาเริ่มรับคิว (ถ้ามี)</span><input value={ticketQueueOpenAt} onChange={(event) => setTicketQueueOpenAt(event.target.value)} placeholder="เช่น 2026-08-29T09:00:00+07:00" /></label>
                        <label className="field"><span>ประเภทบัตร</span><select value={ticketSeatMode} onChange={(event) => setTicketSeatMode(event.target.value as typeof ticketSeatMode)}><option value="reserved">เลือกที่นั่ง</option><option value="standing">บัตรยืน</option><option value="general_admission">ไม่ระบุที่นั่ง</option></select></label>
                        {ticketSeatMode === "reserved" && <label className="field"><span>การจัดที่นั่งหลายใบ</span><select value={ticketSeatGrouping} onChange={(event) => setTicketSeatGrouping(event.target.value as typeof ticketSeatGrouping)}><option value="adjacent">ต้องติดกันในโซนเดียว</option><option value="same_zone">ไม่ติดกันได้ แต่โซนเดียวกัน</option><option value="any">ใบไหนก็ได้ในโซนเดียวกัน</option></select></label>}
                        <label className="field ticket-field-wide"><span>โซนที่ต้องการ</span><input value={ticketZones} onChange={(event) => setTicketZones(event.target.value.toUpperCase())} placeholder={ticketSeatMode === "reserved" ? "เช่น A1, A2 — เว้นว่างได้ถ้ายังไม่รู้" : "เว้นว่างได้"} />
                          {ticketSeatMode === "reserved" && <small>{ticketInspection?.facts?.zones?.length ? `โซนที่อ่านได้จากหน้าปัจจุบัน: ${ticketInspection.facts.zones.join(", ")}` : "ไม่ต้องเดาโซนล่วงหน้า — ถ้าเว้นว่าง โปรแกรมจริงจะอ่านโซนหลัง Login แล้วถามก่อนเลือก"}</small>}
                        </label>
                        {ticketSeatMode === "reserved" && <>
                          {ticketInspection?.facts?.zones?.length ? <div className="ticket-zone-options ticket-field-wide">{ticketInspection.facts.zones.map((zone) => <button type="button" className="ticket-zone-chip" key={zone} onClick={() => setTicketZones((current) => Array.from(new Set([...current.split(/[,\n]/).map((item) => item.trim()).filter(Boolean), zone.toUpperCase()])).join(", "))}>{zone}</button>)}</div> : null}
                          <label className="field"><span>แถวที่ต้องการ</span><input value={ticketRows} onChange={(event) => setTicketRows(event.target.value.toUpperCase())} placeholder="เช่น K หรือ K, L" /><small>เว้นว่าง = แถวใดก็ได้ในโซนที่เลือก</small></label>
                          <label className="field"><span>เลขที่นั่งที่ต้องการ</span><input value={ticketSeatNumbers} onChange={(event) => setTicketSeatNumbers(event.target.value.toUpperCase())} placeholder="เช่น 10 หรือ 10-12" /><small>รองรับ K10 โดยจะแยกเลข 10 ให้อัตโนมัติ</small></label>
                          <label className="field"><span>ถ้าที่นั่งเป้าหมายไม่ว่าง</span><select value={ticketSeatFallback} onChange={(event) => setTicketSeatFallback(event.target.value as typeof ticketSeatFallback)}><option value="exact">เอาตรงตามที่ระบุเท่านั้น</option><option value="nearest">เลือกเลขใกล้ที่สุดในโซนเดิม</option><option value="zone_any">ใบไหนก็ได้ แต่ต้องอยู่โซนเดิม</option></select></label>
                        </>}
                        <label className="field"><span>จำนวนบัตร</span><input type="number" min="1" max="10" value={ticketQuantity} onChange={(event) => setTicketQuantity(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} /></label>
                        <label className="field"><span>งบสูงสุดรวม (ไม่บังคับ)</span><input type="number" min="0" value={ticketBudget} onChange={(event) => setTicketBudget(Math.max(0, Number(event.target.value) || 0))} placeholder="0 = ไม่จำกัดงบ" /><small>ปล่อยเป็น 0 ได้ บอทจะไม่ใช้ราคาเป็นเงื่อนไขตัดออก</small></label>
                        <div className="ticket-project-destination ticket-field-wide">
                          <span>ตำแหน่งไฟล์โปรแกรม</span>
                          <code>/Volumes/petong/Disk/AI/Program_Create/{effectiveTicketProjectName}/</code>
                          <small>ระบบตั้งชื่อให้แล้ว ถ้าชื่อซ้ำจะสร้างโฟลเดอร์ใหม่โดยเติมเลขท้ายและไม่เขียนทับของเดิม</small>
                          <details>
                            <summary>เปลี่ยนชื่อโฟลเดอร์เอง (ไม่จำเป็น)</summary>
                            <label className="field"><span>ชื่อที่ต้องการ</span><input value={ticketProjectName} onChange={(event) => setTicketProjectName(event.target.value)} placeholder={generatedTicketProjectName} /></label>
                          </details>
                        </div>
                      </div>
                    </section>

                    <section className="ticket-form-section">
                      <div className="ticket-form-heading"><span>02</span><div><strong>ข้อมูลสำหรับกรอกฟอร์ม</strong><small>ชื่อคนไม่ใช่โซน/เลขที่นั่ง; password ใช้เฉพาะตอน run และไม่บันทึก</small></div></div>
                      <div className="ticket-form-grid">
                        <label className="field"><span>ชื่อผู้ซื้อ (ชื่อ-นามสกุลบุคคล)</span><input value={ticketCustomerName} onChange={(event) => setTicketCustomerName(event.target.value)} placeholder="ไม่ใช่โซนหรือเลขที่นั่ง; เว้นว่างได้" /><small>กรอกชื่อบุคคลจริงเฉพาะเมื่อหน้าเว็บถาม</small></label>
                        <label className="field ticket-field-wide"><span>ชื่อผู้เข้าชมแต่ละใบ (หนึ่งคนต่อบรรทัด)</span><textarea value={ticketAttendeeNames} onChange={(event) => setTicketAttendeeNames(event.target.value)} placeholder="ชื่อบุคคลเท่านั้น — ใช้เมื่อคอนบังคับพิมพ์ชื่อบนบัตร" /><small>โซน/แถว/เลขที่นั่งให้กรอกในส่วนเลือกบัตรด้านบน</small></label>
                        <label className="field"><span>วิธีรับบัตร</span><select value={ticketDelivery} onChange={(event) => setTicketDelivery(event.target.value as typeof ticketDelivery)}><option value="pickup">รับบัตรด้วยตนเอง</option><option value="postal">จัดส่งทางไปรษณีย์</option></select></label>
                        {ticketDelivery === "postal" && <><label className="field ticket-field-wide"><span>ที่อยู่</span><input value={ticketAddress} onChange={(event) => setTicketAddress(event.target.value)} placeholder="บ้านเลขที่ ถนน แขวง/ตำบล เขต/อำเภอ" /></label><label className="field"><span>เมือง/อำเภอ</span><input value={ticketCity} onChange={(event) => setTicketCity(event.target.value)} /></label><label className="field"><span>จังหวัด</span><input value={ticketProvince} onChange={(event) => setTicketProvince(event.target.value)} /></label><label className="field"><span>รหัสไปรษณีย์</span><input value={ticketPostalCode} onChange={(event) => setTicketPostalCode(event.target.value)} inputMode="numeric" /></label></>}
                        <label className="field"><span>Ticket Protect</span><select value={ticketProtect ? "on" : "off"} onChange={(event) => setTicketProtect(event.target.value === "on")}><option value="off">ไม่เพิ่ม (ค่าเริ่มต้น)</option><option value="on">เพิ่ม Ticket Protect</option></select></label>
                      </div>
                    </section>

                    <section className="ticket-form-section">
                      <div className="ticket-form-heading"><span>03</span><div><strong>วิธีชำระเงิน</strong><small>บอทจะค้างหน้า QR ให้พี่ตรวจและชำระเอง</small></div></div>
                      <div className="ticket-payment-grid">
                        <label className={ticketPayment === "qr" ? "selected" : ""}><input type="radio" name="ticket-payment" checked={ticketPayment === "qr"} onChange={() => setTicketPayment("qr")} /><span><strong>QR Payment</strong><small>เปิดหน้า QR แล้วส่งต่อให้ผู้ใช้</small></span></label>
                        <label className={ticketPayment === "promptpay" ? "selected" : ""}><input type="radio" name="ticket-payment" checked={ticketPayment === "promptpay"} onChange={() => setTicketPayment("promptpay")} /><span><strong>PromptPay</strong><small>เลือกพร้อมเพย์และค้างหน้าชำระเงิน</small></span></label>
                      </div>
                    </section>

                    <section className="ticket-form-section">
                      <div className="ticket-form-heading"><span>04</span><div><strong>Login สำหรับ run จริง</strong><small>ส่งเข้า process แบบ ephemeral เท่านั้น ไม่เขียน config/localStorage/database</small></div></div>
                      <div className="ticket-form-grid">
                        <label className="field"><span>Email / username</span><input autoComplete="username" value={ticketUsername} onChange={(event) => setTicketUsername(event.target.value)} placeholder="เว้นว่างได้ถ้ามี session อยู่แล้ว" /></label>
                        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={ticketPassword} onChange={(event) => setTicketPassword(event.target.value)} placeholder="ใช้เฉพาะตอนเริ่ม run" /></label>
                      </div>
                    </section>

                    <section className="ticket-handoff-note"><strong>ทำงานเบื้องหลังโดยไม่ยึดเมาส์</strong><span>Login อัตโนมัติจาก session/secure prompt · รับช่วงเฉพาะ CAPTCHA · OTP · Payment</span><p>บอทใช้ DOM ในโปรไฟล์แยก รองรับ image-map ของโซนและไม่ขยับเมาส์ระบบ รหัสผ่านไม่ถูกเขียนลง config ส่วนการจ่ายเงินจริงจะหยุดที่หน้า QR ให้พี่ตรวจเสมอ</p></section>

                    {ticketBuildReport && <section className="ticket-result-card">
                      <div><span>≠</span><div><strong>ผ่านเฉพาะโครงสร้างและ fixture — ยังไม่ใช่ผลซื้อบัตรจริง</strong><p>{ticketBuildReport.project_path}</p></div></div>
                      <div className="ticket-result-files">{ticketBuildReport.created_files.map((file) => <span key={file}>{file}</span>)}</div>
                      <small>โครงสร้าง: {ticketBuildReport.verification?.structure_passed ? "ผ่าน" : "ไม่ผ่าน"} · Fixture: {ticketBuildReport.verification?.fixture_tests_passed ? "ผ่าน" : "ไม่ผ่าน"} · Runtime: {ticketRun ? ticketRun.stage : "ยังไม่เริ่ม"} · PAYMENT_HANDOFF: {ticketRun?.payment_handoff_verified ? "ยืนยันแล้ว" : "ยังไม่ยืนยัน"}</small>
                    </section>}

                    {ticketRun && <section className="ticket-result-card">
                      <div><span>{ticketRun.status === "failed" ? "!" : ticketRun.status === "stopped" ? "■" : "▶"}</span><div><strong>Live Ticket Run · {ticketRun.status}</strong><p>Run {ticketRun.id} · PID {ticketRun.pid || "—"} · Stage {ticketRun.stage}</p></div></div>
                      <small>{ticketRun.detail || "กำลังรอ event จาก process"}{ticketRun.latest_url ? ` · ${ticketRun.latest_url}` : ""}</small>
                      {ticketRun.logs?.length ? <ol className="ticket-run-timeline">{ticketRun.logs.slice(-12).map((item, index) => <li key={`${item.at}-${index}`}>{ticketRunLogLabel(item.text)}</li>)}</ol> : null}
                      {ticketRun.status === "waiting_handoff" && <div className="confirm-row">
                        <span>{ticketRun.handoff?.prompt || "ต้องให้ผู้ใช้รับช่วง"}</span>
                        {!["captcha", "otp", "payment", "continue", "ticket_selection", "checkout_options", "review"].includes(ticketRun.handoff?.field || "") && <input type={ticketRun.handoff?.secret ? "password" : "text"} value={ticketRunInput} onChange={(event) => setTicketRunInput(event.target.value)} placeholder={ticketRun.handoff?.options?.join(", ") || "กรอกข้อมูลที่บอทรอ"} />}
                        <button type="button" onClick={() => void sendTicketRuntimeInput()}>ทำต่อ</button>
                      </div>}
                      {ticketRunActive && <button type="button" className="secondary-action" onClick={() => void stopTicketRuntime()}>หยุดบอท</button>}
                    </section>}

                    <div className="ticket-build-actions"><span className="ticket-build-hint">Fixture ผ่านไม่เท่ากับ runtime ผ่าน · run-full-loop.command · สร้างบอท — ค้นข้อมูลจริงตอนรัน</span><button type="button" className="secondary-action" onClick={() => void inspectSelectedTicketEvent()} disabled={ticketStage === "form_inspecting" || ticketRunActive}>ตรวจเพิ่ม</button><button className="save-button" type="submit" disabled={!["open", "upcoming"].includes(ticketEvents.find((event) => event.id === ticketSelectedId)?.sale_status || "unknown") || ticketStage === "building" || ticketRunActive}>{ticketRunActive ? "บอทกำลังทำงาน" : ticketStage === "building" ? "กำลังเริ่ม…" : ticketBuildReport?.project_path ? "เริ่มบอทจริง" : "สร้างและเริ่มบอท"}</button></div>
                  </form>
                )}
              </div>
            </section>
          </div>
        )}

        {view === "settings" && (
          <div className="content-view settings-view">
            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">MODEL & LIMITS</span><h2>โมเดลและการใช้ทรัพยากร</h2></div><span className={`health-badge ${runtimeReady ? "ready" : ""}`}>{runtimeReady ? "พร้อม" : "ต้องตั้งค่า"}</span></div>
              <div className="model-grid">
                {(["qwen3:4b-instruct", "qwen3.5:9b"] as const).map((model) => (
                  <button key={model} type="button" className={settings.model === model ? "selected" : ""} onClick={() => updateSettings({ model })}>
                    <strong>{model === "qwen3:4b-instruct" ? "Qwen3 4B Instruct" : "Qwen3.5 9B"}</strong>
                    <span>{model === "qwen3:4b-instruct" ? "ตอบตรง เร็ว และประหยัด RAM" : "ฉลาดขึ้น เหมาะกับโหมดคุณภาพสูง"}</span>
                  </button>
                ))}
              </div>
              <label className="range-control"><span><strong>Context tokens</strong><em>{settings.max_context_tokens.toLocaleString()}</em></span><input aria-label="Context tokens" type="range" min="4096" max="8192" step="1024" value={settings.max_context_tokens} onChange={(event) => updateSettings({ max_context_tokens: Number(event.target.value) })} /></label>
              <label className="range-control"><span><strong>จำนวน token คำตอบสูงสุด</strong><em>{settings.max_output_tokens.toLocaleString()}</em></span><input aria-label="จำนวน token คำตอบสูงสุด" type="range" min="256" max="2048" step="256" value={settings.max_output_tokens} onChange={(event) => updateSettings({ max_output_tokens: Number(event.target.value) })} /></label>
            </section>

            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">PERSONALITY</span><h2>บุคลิกของอัลฟ่า</h2></div><span className="configured">มืออาชีพอบอุ่น</span></div>
              <p className="settings-note">อัลฟ่าจะพูดเป็นธรรมชาติ ตรงประเด็น ไม่แนะนำตัวซ้ำ และไม่ลงท้ายทุกคำตอบด้วยคำถามเดิม ๆ</p>
              <div className="personality-grid">
                <label className="range-control"><span><strong>ความอบอุ่น</strong><em>{settings.personality_warmth}%</em></span><input aria-label="ความอบอุ่น" type="range" min="0" max="100" step="5" value={settings.personality_warmth} onChange={(event) => updateSettings({ personality_warmth: Number(event.target.value) })} /></label>
                <label className="range-control"><span><strong>ความตรง</strong><em>{settings.personality_directness}%</em></span><input aria-label="ความตรง" type="range" min="0" max="100" step="5" value={settings.personality_directness} onChange={(event) => updateSettings({ personality_directness: Number(event.target.value) })} /></label>
                <label className="range-control"><span><strong>อารมณ์ขัน</strong><em>{settings.personality_humor}%</em></span><input aria-label="อารมณ์ขัน" type="range" min="0" max="100" step="5" value={settings.personality_humor} onChange={(event) => updateSettings({ personality_humor: Number(event.target.value) })} /></label>
              </div>
              <div className="two-column-fields">
                <label className="field"><span>เรียกคุณว่า</span><input value={settings.preferred_name} onChange={(event) => updateSettings({ preferred_name: event.target.value })} placeholder="เว้นว่างได้" /></label>
                <label className="field"><span>ความยาวคำตอบ</span><select value={settings.response_style} onChange={(event) => updateSettings({ response_style: event.target.value as AppSettings["response_style"] })}><option value="concise">กระชับ</option><option value="balanced">สมดุล</option><option value="detailed">ละเอียด</option></select></label>
                <label className="field"><span>การใช้ Emoji</span><select value={settings.personality_emoji} onChange={(event) => updateSettings({ personality_emoji: event.target.value as AppSettings["personality_emoji"] })}><option value="none">ไม่ใช้</option><option value="low">น้อยมาก</option><option value="normal">พอประมาณ</option></select></label>
              </div>
            </section>

            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">EFFECTIVE RULES</span><h2>กฎหลักของอัลฟ่า</h2></div><span>เพิ่ม ลบ แก้ และปล่อยว่างได้ทั้งหมด</span></div>
              <div className="rules-list">
                {settings.core_rules.map((rule, index) => (
                  <label key={index}><span>{index + 1}</span><textarea value={rule} rows={2} onChange={(event) => {
                    const next = [...settings.core_rules] as AppSettings["core_rules"];
                    next[index] = event.target.value;
                    updateSettings({ core_rules: next });
                  }} /><button type="button" aria-label={`ลบกฎ ${index + 1}`} onClick={() => updateSettings({ core_rules: settings.core_rules.filter((_item, itemIndex) => itemIndex !== index) })}>ลบ</button></label>
                ))}
                {!settings.core_rules.length && <div className="empty-state">ไม่มีกฎหลักที่เปิดใช้</div>}
              </div>
              <button className="secondary-action" type="button" onClick={() => updateSettings({ core_rules: [...settings.core_rules, ""] })}>＋ เพิ่มกฎ</button>
              <label className="field"><span>กฎเพิ่มเติม</span><textarea rows={3} value={settings.custom_instructions} onChange={(event) => updateSettings({ custom_instructions: event.target.value })} /></label>
            </section>

            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">SAFETY CONTROLS</span><h2>หมวดที่ห้ามตอบหรือค้นหา</h2></div><span>ตรวจก่อนใช้อินเทอร์เน็ต</span></div>
              <div className="topic-grid">
                {TOPICS.map((topic) => {
                  const checked = settings.blocked_topics.includes(topic.id);
                  return <label key={topic.id} className={checked ? "checked" : ""}><input aria-label={topic.label} type="checkbox" checked={checked} onChange={() => updateSettings({ blocked_topics: checked ? settings.blocked_topics.filter((id) => id !== topic.id) : [...settings.blocked_topics, topic.id] })} /><span><strong>{topic.label}</strong><small>{topic.detail}</small></span></label>;
                })}
              </div>
              <div className="field"><span>คำหรือหัวข้อที่ต้องการบล็อกเพิ่ม</span><ListEditor items={settings.custom_blocked_terms} onChange={(items) => updateSettings({ custom_blocked_terms: items })} placeholder="เช่น ชื่อเว็บไซต์หรือหัวข้อ" /></div>
            </section>

            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">WEB ACCESS</span><h2>การเข้าถึงอินเทอร์เน็ต</h2></div><span className={health?.search_ready ? "configured" : "not-configured"}>{health?.search_ready ? `พร้อม · ${health.search_backend}` : "ระบบค้นยังไม่พร้อม"}</span></div>
              <div className="setting-row"><div><strong>อนุญาตค้นเว็บ</strong><p>สวิตช์เดียวกับหน้าแชต การปิดจะไม่ส่งคำถามออกจากเครื่อง</p></div><Toggle checked={settings.web_search_enabled} onChange={(value) => updateSettings({ web_search_enabled: value })} label="อนุญาตค้นเว็บ" /></div>
              <div className="segmented"><button type="button" className={settings.search_mode === "auto" ? "active" : ""} onClick={() => updateSettings({ search_mode: "auto" })}>ค้นอัตโนมัติ</button><button type="button" className={settings.search_mode === "confirm" ? "active" : ""} onClick={() => updateSettings({ search_mode: "confirm" })}>ถามก่อนทุกครั้ง</button></div>
              <div className="capability-grid">
                <span className={health?.ollama_connected ? "ready" : ""}>Ollama {health?.ollama_connected ? "เชื่อมแล้ว" : "ไม่ทำงาน"}</span>
                <span className={health?.tool_service.connected ? "ready" : ""}>Tool Service {health?.tool_service.connected ? "เชื่อมแล้ว" : "ไม่ทำงาน"}</span>
                <span className={health?.web_read_ready ? "ready" : ""}>อ่าน URL {health?.web_read_ready ? "พร้อม" : "ไม่พร้อม"}</span>
                <span className={health?.search_ready ? "ready" : ""}>ค้นเว็บ {health?.search_ready ? health.search_backend : "ไม่พร้อม"}</span>
                <span className={health?.tool_service.docker_connected ? "ready" : ""}>Docker {health?.tool_service.docker_connected ? "เชื่อมแล้ว" : "ปิดอยู่"}</span>
                <span className={health?.browser_ready ? "ready" : ""}>Browser {health?.browser_ready ? "พร้อม" : "ไม่พร้อม"}</span>
              </div>
              {health?.search_degraded_reason && <p className="health-warning">{health.search_degraded_reason}</p>}
              {health?.tool_service.last_tool_error && <p className="health-warning">ข้อผิดพลาดล่าสุด: {health.tool_service.last_tool_error}</p>}
              <div className="capability-tests"><button type="button" onClick={() => void testCapability("read")}>ทดสอบอ่าน URL</button><button type="button" onClick={() => void testCapability("search")}>ทดสอบค้นเว็บ</button><button type="button" onClick={() => void testCapability("browser")}>ทดสอบ Browser</button><span>{toolTestStatus}</span></div>
              <div className="security-lab-settings">
                <div className="section-heading"><div><span className="section-kicker">API DISCOVERY LAB</span><h3>ค้น API จาก DevTools Network</h3></div><span>สำหรับเว็บของคุณ</span></div>
                <p className="settings-note">Passive discovery และ GET/HEAD/OPTIONS ใช้ได้กับเว็บสาธารณะทุกเว็บ ส่วนการยิง request ที่แก้ข้อมูลให้เพิ่มโดเมนครั้งเดียว ระบบจะไม่ขอหลักฐานหรือถามยืนยันซ้ำ และจะลบ token, cookie กับรหัสผ่านออกจาก log</p>
                <div className="field"><span>Active Test Domains</span><ListEditor items={settings.security_test_domains} onChange={(items) => updateSettings({ security_test_domains: items })} placeholder="เช่น myapp.com หรือ localhost" /></div>
                <div className="setting-row"><div><strong>Active API Testing</strong><p>อนุญาต POST, PUT, PATCH และ DELETE อัตโนมัติเฉพาะโดเมนด้านบน</p></div><Toggle checked={settings.security_active_testing_enabled} onChange={(value) => updateSettings({ security_active_testing_enabled: value })} label="Active API Testing" /></div>
              </div>
              <div className="setting-row"><div><strong>ค้นหาและสร้างรูปภาพ</strong><p>Allow by default; ปิดได้จากสวิตช์นี้และจะแสดงชื่อ setting เมื่อเป็นต้นเหตุที่บล็อก</p></div><Toggle checked={settings.image_search_enabled} onChange={(value) => updateSettings({ image_search_enabled: value })} label="ค้นหาและสร้างรูปภาพ" /></div>
              <div className="two-column-fields"><div className="field"><span>เว็บไซต์ที่ห้ามใช้</span><ListEditor items={settings.blocked_domains} onChange={(items) => updateSettings({ blocked_domains: items })} placeholder="example.com" /></div><div className="field"><span>อนุญาตเฉพาะเว็บไซต์เหล่านี้</span><ListEditor items={settings.allowed_domains} onChange={(items) => updateSettings({ allowed_domains: items })} placeholder="example.org" /></div></div>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div><span className="section-kicker">FILES & CODE</span><h2>ไฟล์จริงและการรันโปรแกรม</h2></div>
                <span className={health?.tool_service.connected ? "configured" : "not-configured"}>{health?.tool_service.connected ? "Tool Service พร้อม" : "Tool Service ปิดอยู่"}</span>
              </div>
              <label className="field"><span>สิทธิ์เข้าถึงไฟล์</span>
                <select value={settings.file_access_mode} onChange={(event) => updateSettings({ file_access_mode: event.target.value as AppSettings["file_access_mode"] })}>
                  <option value="off">ปิดการสร้างและแก้ไฟล์</option>
                  <option value="ask">ถามก่อนทุกครั้ง (แนะนำ)</option>
                  <option value="alpha_outputs">ทำงานอัตโนมัติเฉพาะ Alpha Outputs</option>
                  <option value="selected_folders">ทำงานในโฟลเดอร์ที่เลือก</option>
                  <option value="full_user_files">Full — ไฟล์ผู้ใช้ทั้งหมด + Host actions อัตโนมัติ</option>{/* alpha-beta11-full-host-permission-v1 */}
                </select>
              </label>
              {settings.file_access_mode === "selected_folders" && (
                <label className="field"><span>พาธโฟลเดอร์ที่อนุญาต (หนึ่งบรรทัดต่อหนึ่งโฟลเดอร์)</span><textarea rows={3} value={settings.allowed_file_roots.join("\n")} onChange={(event) => updateSettings({ allowed_file_roots: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="/Users/ชื่อคุณ/Documents/Projects" /></label>
              )}
              <div className="setting-row"><div><strong>Run/Test ใน Docker sandbox</strong><p>ปิดเครือข่าย จำกัด RAM/เวลา และถามยืนยันก่อนรันเสมอ</p></div><span className={`mini-status ${health?.tool_service.docker_connected ? "ready" : ""}`}>{health?.tool_service.docker_connected ? "Docker พร้อม" : "Docker ยังไม่เปิด"}</span></div>
              <p className="settings-note">ไฟล์ที่อัลฟ่าสร้างจะอยู่ใน <code>{health?.tool_service.outputs_directory || "outputs/Alpha Outputs"}</code> และระบบจะสำรองไฟล์เดิมก่อนเขียนทับ</p>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div><span className="section-kicker">BROWSER TOOLS</span><h2>เบราว์เซอร์ของอัลฟ่า</h2></div>
                <span>{settings.browser_mode === "alpha" ? "โปรไฟล์แยก" : settings.browser_mode === "chrome" ? "Chrome เดิม" : "ปิด"}</span>
              </div>
              <div className="segmented three-way">
                <button type="button" className={settings.browser_mode === "off" ? "active" : ""} onClick={() => updateSettings({ browser_mode: "off" })}>ปิด</button>
                <button type="button" className={settings.browser_mode === "alpha" ? "active" : ""} onClick={() => updateSettings({ browser_mode: "alpha" })}>Alpha Browser</button>
                <button type="button" className={settings.browser_mode === "chrome" ? "active" : ""} onClick={() => updateSettings({ browser_mode: "chrome" })}>Chrome เดิม</button>
              </div>
              <div className="health-grid">
                <span className={health?.tool_service.storage_connected !== false ? "ready" : ""}>External HDD {health?.tool_service.storage_connected !== false ? "เชื่อมต่อแล้ว" : "ไม่ได้เชื่อมต่อ"}</span>
                <span className={health?.tool_service.searxng_connected ? "ready" : ""}>SearXNG {health?.tool_service.searxng_connected ? "ทำงาน" : "พร้อมเปิดเมื่อค้น"}</span>
                <span className={health?.tool_service.alpha_browser_running ? "ready" : ""}>Alpha Browser {health?.tool_service.alpha_browser_running ? "เปิดอยู่" : "ปิดอยู่"}</span>
                <span className={health?.tool_service.chrome_extension_connected ? "ready" : ""}>Chrome Extension {health?.tool_service.chrome_extension_connected ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}</span>
                <span>Full Disk Access ตรวจเมื่อสั่งใช้จริง</span>
              </div>
              <p className="settings-note">Storage: <code>{health?.tool_service.storage_root || health?.tool_service.outputs_directory || "ยังไม่พร้อม"}</code></p>
              {settings.browser_mode === "chrome" && <div className="pairing-card"><span>รหัสจับคู่ Extension</span><strong>{pairingCode || "เปิดอัลฟ่าใหม่เพื่อรับรหัส"}</strong><small>รหัสเปลี่ยนทุกครั้งที่เปิดบริการ และใช้ได้เฉพาะเครื่องนี้</small></div>}
              <label className="range-control"><span><strong>ปิดบริการหนักหลังว่าง</strong><em>{Math.round(settings.tool_idle_timeout_seconds / 60)} นาที</em></span><input aria-label="เวลาปิดบริการหลังว่าง" type="range" min="60" max="1800" step="60" value={settings.tool_idle_timeout_seconds} onChange={(event) => updateSettings({ tool_idle_timeout_seconds: Number(event.target.value) })} /></label>
              <p className="settings-note">อัลฟ่าจะหยุดและให้คุณรับช่วงเมื่อพบ CAPTCHA, รหัสผ่าน, OTP, บัตร หรือการชำระเงิน</p>
            </section>

            <section className="settings-card">
              <div className="section-heading"><div><span className="section-kicker">ADVANCED RESOURCES</span><h2>ทรัพยากรของ Auto Learn และ Skill Lab</h2></div><span>ค่า 0 หมายถึงไม่จำกัด</span></div>
              <div className="limits-grid">
                <LimitField label="จำนวนรอบ Auto Learn" value={settings.auto_learn_max_rounds} onChange={(value) => updateSettings({ auto_learn_max_rounds: value })} />
                <LimitField label="Timeout ต่อขั้น" value={settings.auto_learn_step_timeout_seconds} suffix="วินาที" onChange={(value) => updateSettings({ auto_learn_step_timeout_seconds: value })} />
                <LimitField label="Retry ต่อขั้น" value={settings.auto_learn_retry_limit} onChange={(value) => updateSettings({ auto_learn_retry_limit: value })} />
                <LimitField label="สร้างสกิลทุกกี่รอบ" value={settings.auto_learn_skill_frequency} onChange={(value) => updateSettings({ auto_learn_skill_frequency: value })} hint="0 = ให้เลือกเอง" />
                <LimitField label="เวลาพักระหว่างรอบ" value={settings.auto_learn_rest_seconds} suffix="วินาที" onChange={(value) => updateSettings({ auto_learn_rest_seconds: value })} hint="0 = ไม่พัก" />
                <LimitField label="Skill Lab attempts" value={settings.skill_lab_max_attempts} onChange={(value) => updateSettings({ skill_lab_max_attempts: value })} />
                <LimitField label="Research rounds" value={settings.research_max_rounds} onChange={(value) => updateSettings({ research_max_rounds: value })} />
                <LimitField label="Test cases" value={settings.skill_test_case_limit} onChange={(value) => updateSettings({ skill_test_case_limit: value })} />
                <LimitField label="Hidden tests" value={settings.skill_hidden_test_runs} onChange={(value) => updateSettings({ skill_hidden_test_runs: value })} />
                <LimitField label="ผลค้นหาต่อรอบ" value={settings.search_result_limit} onChange={(value) => updateSettings({ search_result_limit: value })} />
                <LimitField label="ความจำที่ดึงมาใช้" value={settings.memory_retrieval_limit} onChange={(value) => updateSettings({ memory_retrieval_limit: value })} />
                <LimitField label="ความจำที่สกัดต่อรอบ" value={settings.memory_extract_limit} onChange={(value) => updateSettings({ memory_extract_limit: value })} />
                <LimitField label="RAM target" value={settings.memory_target_gb} suffix="GB" onChange={(value) => updateSettings({ memory_target_gb: value })} />
                <LimitField label="Disk budget" value={settings.disk_budget_gb} suffix="GB" onChange={(value) => updateSettings({ disk_budget_gb: value })} />
              </div>
            </section>

            <section className="settings-card effective-rules-card">
              <div className="section-heading"><div><span className="section-kicker">EFFECTIVE RULES</span><h2>กฎที่มีผลจริงตอนนี้</h2></div><span>Allow by default</span></div>
              <div className="effective-rules-list">
                <span>กฎหลักที่ไม่ว่าง: {settings.core_rules.filter(Boolean).length}</span>
                <span>หมวดที่บล็อก: {settings.blocked_topics.length ? settings.blocked_topics.join(", ") : "ไม่มี"}</span>
                <span>คำที่บล็อกเอง: {settings.custom_blocked_terms.length ? settings.custom_blocked_terms.join(", ") : "ไม่มี"}</span>
                <span>โดเมนที่บล็อก: {settings.blocked_domains.length ? settings.blocked_domains.join(", ") : "ไม่มี"}</span>
                <span>อินเทอร์เน็ต: {settings.web_search_enabled ? "เปิด" : "ปิดโดย setting web_search_enabled"}</span>
                <span>รูปภาพ: {settings.image_search_enabled ? "เปิด" : "ปิดโดย setting image_search_enabled"}</span>
              </div>
            </section>

            <div className="save-dock"><span>{saveState === "saving" ? "กำลังบันทึก..." : saveState === "saved" ? "บันทึกแล้ว" : saveState === "error" ? "บันทึกไม่สำเร็จ" : "การเปลี่ยนแปลงยังไม่ถูกบันทึก"}</span><button className="save-button" type="button" onClick={() => void persistSettings(settings)}>บันทึกการตั้งค่า</button></div>
          </div>
        )}
      </section>
    </main>
  );
}
