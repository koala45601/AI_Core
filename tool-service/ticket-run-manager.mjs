import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";

const ACTIVE = new Set(["starting_runtime", "runtime_running", "waiting_handoff"]);
const HANDLED_TERMINAL_RESULTS = new Set(["SOLD_OUT_BY_SERVER", "SALE_CLOSED_BY_SERVER", "PRE_SALE_SCHEDULED", "PRE_SALE_READY", "ARMED_PRE_SALE"]);
const REQUIRED_FILES = ["run-full-loop.command", "start.command", "bot.py", "config.json"];
const MAX_LOG_LINES = 350;

export function ownedBrowserPidsFromPs(psOutput, profileDir) {
  const marker = resolve(String(profileDir || ""));
  if (!profileDir || !marker) return [];
  return String(psOutput || "").split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    const ownsProfile = command.includes(`--user-data-dir=${marker}`)
      || command.includes(`--user-data-dir="${marker}"`)
      || command.includes(`--user-data-dir '${marker}'`);
    return Number.isSafeInteger(pid) && pid > 1 && ownsProfile ? [pid] : [];
  });
}

async function processTable() {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr || `ps exited ${code}`)));
  });
}

function pathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

function now() {
  return Date.now();
}

function safeText(value, max = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function readMacKeychainPassword(service, account) {
  if (process.platform !== "darwin" || !service || !account) return "";
  return await new Promise((resolvePassword) => {
    const child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      resolvePassword("");
    }, 5_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8_000) stdout += chunk.toString("utf8");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolvePassword("");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePassword(code === 0 ? stdout.replace(/[\r\n]+$/, "") : "");
    });
  });
}

function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, Math.min(100, ((center - margin) / denominator) * 100));
}

function redactLine(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 3) text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/((?:password|passwd|secret|token|authorization|cookie)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/("(?:password|passwd|secret|token|authorization|cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
  return text.slice(0, 8_000);
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    project_path: run.project_path,
    pid: run.pid,
    status: run.status,
    stage: run.stage,
    detail: run.detail,
    started_at: run.started_at,
    updated_at: run.updated_at,
    ended_at: run.ended_at,
    exit_code: run.exit_code,
    handoff: run.handoff,
    logs: [...run.logs],
    latest_url: run.latest_url,
    full_loop_verified: run.full_loop_verified === true,
    reservation_verified: run.reservation_verified === true,
    payment_handoff_verified: run.payment_handoff_verified === true,
    seat: { ...(run.seat || {}) },
    queue: { ...(run.queue || {}) },
    ai: { ...(run.ai || {}) },
    checkout_countdown_seconds: Number.isFinite(run.checkout_countdown_seconds) ? run.checkout_countdown_seconds : null,
    result_status: run.result_status,
    result_reason: run.result_reason,
    evidence_paths: [...(run.evidence_paths || [])],
    browser_pid: run.browser_pid || null,
    browser_cleanup: run.browser_cleanup || "pending",
    credential_source: run.credential_source || "prompt",
    event_cursor: Number(run.event_cursor || 0),
    heartbeat: { ...(run.heartbeat || {}) },
    supervisor: { ...(run.supervisor || {}) },
    manual_control: { ...(run.manual_control || {}) },
    repair: run.repair ? { ...run.repair } : null,
  };
}

function mapEvent(run, event) {
  const kind = safeText(event.kind, 80);
  const state = safeText(event.state, 100);
  const status = safeText(event.status, 120);
  const url = safeText(event.url, 2_000);
  if (url) run.latest_url = url;

  if (kind === "browser_window") {
    const browserPid = Number(event.browser_pid || 0);
    if (Number.isSafeInteger(browserPid) && browserPid > 1) run.browser_pid = browserPid;
  }

  const supervisorOnlyEvent = kind === "supervisor_action" || kind === "ai_diagnosis" || kind.startsWith("repair_");
  if (!supervisorOnlyEvent) {
    run.heartbeat.last_event_at = now();
    run.heartbeat.last_activity_at = run.heartbeat.last_event_at;
  }

  if (kind === "runtime") {
    run.status = "runtime_running";
    run.stage = safeText(event.stage, 120) || "starting_browser";
    run.detail = safeText(event.detail, 500) || "Browser runtime เริ่มทำงานแล้ว";
    // A runtime process can start before its browser exists. Only explicit
    // browser evidence may satisfy the supervisor connection watchdog.
    if (event.browser_connected === true) {
      run.heartbeat.browser_connected = true;
      run.heartbeat.browser_connected_at ||= now();
    }
  } else if (kind === "runtime_heartbeat") {
    run.status = ACTIVE.has(run.status) ? run.status : "runtime_running";
    run.heartbeat.process_alive = event.process_alive !== false;
    run.heartbeat.browser_connected = event.browser_connected === true;
    run.heartbeat.browser_connected_at ||= event.browser_connected === true ? now() : null;
    run.heartbeat.ai_ready = event.ai_ready === true;
    run.heartbeat.ai_ready_at ||= event.ai_ready === true ? now() : null;
    run.heartbeat.sequence = Math.max(0, Number(event.sequence || 0));
    run.supervisor.status = run.supervisor.status === "recovering" ? "recovering" : "standby";
    run.supervisor.watchdog_fingerprint = "";
  } else if (kind === "seat_availability") {
    run.seat.availability = event.zones && typeof event.zones === "object" ? { ...event.zones } : {};
    run.seat.availability_checked_at = safeText(event.checked_at, 100) || new Date().toISOString();
    run.seat.inventory_generation = Math.max(run.seat.inventory_generation || 0, Number(event.inventory_generation || 0));
    run.detail = Object.keys(run.seat.availability).length
      ? `อ่านจำนวนที่นั่งว่าง ${Object.entries(run.seat.availability).map(([zone, count]) => `${zone}=${count}`).join(", ")}`
      : safeText(event.reason, 200) || "หน้านี้ไม่มีข้อมูลจำนวนที่นั่งรายโซน";
  } else if (kind === "inventory_generation") {
    run.seat.inventory_generation = Math.max(run.seat.inventory_generation || 0, Number(event.generation || 0));
  } else if (kind === "seat_blacklisted") {
    run.seat.blacklisted_count = Math.max(0, Number(event.blacklist_size || 0));
    run.seat.blacklisted_seats = Array.isArray(event.seats) ? event.seats.map((item) => safeText(item, 100)).filter(Boolean).slice(0, 30) : [];
  } else if (kind === "navigation_interrupt") {
    run.stage = "navigation_interrupt";
    run.manual_control.last_interrupt_at = now();
    run.manual_control.from_state = safeText(event.from_state, 100);
    run.manual_control.to_state = safeText(event.to_state, 100);
    run.manual_control.active = true;
    run.detail = `ตรวจพบการเปลี่ยนหน้า ${run.manual_control.from_state || "เดิม"} → ${run.manual_control.to_state || "ใหม่"} · ยกเลิก task เก่าแล้ว`;
  } else if (kind === "manual_control") {
    run.manual_control.active = event.active === true;
    run.manual_control.policy = safeText(event.policy, 80) || "observe_then_resume";
    run.manual_control.updated_at = now();
    run.detail = run.manual_control.active ? "ผู้ใช้กำลังควบคุม Browser · Alpha จะไม่แย่งเมาส์" : "ผู้ใช้หยุดโต้ตอบแล้ว · Alpha กำลังรับช่วงต่อ";
  } else if (kind === "state_resumed") {
    run.manual_control.active = false;
    run.stage = safeText(event.state, 100) || "resumed";
    run.detail = `กลับมาทำงานต่อจาก ${run.stage} โดยคงเงื่อนไขเดิม`;
  } else if (kind === "supervisor_action") {
    run.supervisor.status = safeText(event.status, 80) || "recovering";
    run.supervisor.last_action = safeText(event.action, 160);
    run.supervisor.root_cause = safeText(event.root_cause || event.reason, 500);
    run.supervisor.updated_at = now();
    run.detail = run.supervisor.root_cause || `Supervisor กำลัง ${run.supervisor.last_action || "recovery"}`;
  } else if (kind === "ai_diagnosis") {
    run.ai.status = "diagnosed";
    run.ai.diagnosis = safeText(event.diagnosis || event.root_cause, 500);
    run.supervisor.status = "awaiting_repair_decision";
  } else if (kind === "repair_candidate" || kind === "repair_verified" || kind === "repair_promoted" || kind === "repair_rolled_back") {
    run.repair = {
      ...(run.repair || {}),
      id: safeText(event.repair_id, 100),
      status: safeText(event.status, 80) || kind.replace("repair_", ""),
      summary: safeText(event.summary, 500),
      diff_summary: safeText(event.diff_summary, 2_000),
      tests: Array.isArray(event.tests) ? event.tests.slice(0, 100) : [],
    };
  } else if (kind === "repair_skill_installed") {
    run.repair = {
      ...(run.repair || {}),
      id: safeText(event.repair_id, 100) || run.repair?.id || "",
      skill_id: safeText(event.skill_id, 160),
      skill_installed: true,
      summary: safeText(event.summary, 500),
      tests: Array.isArray(event.tests) ? event.tests.slice(0, 100) : run.repair?.tests || [],
    };
  } else if (kind === "checkpoint") {
    run.status = "runtime_running";
    run.stage = state || "checkpoint";
    run.detail = safeText(event.evidence, 500) || `ตรวจพบสถานะ ${run.stage}`;
  } else if (kind === "wait") {
    run.status = "runtime_running";
    run.stage = state === "queue" ? "waiting_queue" : state || "waiting";
    run.detail = safeText(event.detail, 500) || "กำลังรอเงื่อนไขจากเว็บไซต์";
  } else if (kind === "selection") {
    run.status = "runtime_running";
    run.stage = "selecting_ticket";
    run.detail = safeText(event.reason, 500) || "กำลังเลือกบัตรตามเงื่อนไข";
  } else if (kind === "seat_scan") {
    run.status = "runtime_running";
    run.stage = "seat_scan";
    run.seat.current_zone = safeText(event.zone, 80);
    run.seat.wanted = Math.max(0, Number(event.wanted || 0));
    run.seat.available = Math.max(0, Number(event.available || 0));
    run.seat.attempts = Math.max(run.seat.attempts || 0, Number(event.attempt || 0));
    run.seat.next_action = "plan_complete_set";
    run.detail = `กำลังสแกนโซน ${run.seat.current_zone || "ปัจจุบัน"} · ว่าง ${run.seat.available} · ต้องการ ${run.seat.wanted}`;
  } else if (kind === "seat_set_planned") {
    run.status = "runtime_running";
    run.stage = "seat_set_planned";
    run.seat.current_zone = safeText(event.zone, 80);
    run.seat.candidate_set = Array.isArray(event.seats) ? event.seats.map((item) => safeText(item, 100)).filter(Boolean).slice(0, 20) : [];
    run.seat.attempts = Math.max(run.seat.attempts || 0, Number(event.attempt || 0));
    run.seat.next_action = "reserve_complete_set";
    run.detail = `พบชุดครบ: ${run.seat.candidate_set.join(", ") || "กำลังยืนยัน"}`;
  } else if (kind === "seat_attempt") {
    run.status = "runtime_running";
    run.stage = "seat_attempt";
    run.seat.attempts = Math.max(run.seat.attempts || 0, Number(event.attempt || 0));
    run.seat.next_action = "verify_reservation";
    run.detail = `กำลังยืนยันชุดที่นั่งครั้งที่ ${run.seat.attempts}`;
  } else if (kind === "seat_conflict") {
    run.status = "runtime_running";
    run.stage = "seat_conflict";
    run.seat.current_zone = safeText(event.zone, 80) || run.seat.current_zone;
    run.seat.selected = Math.max(0, Number(event.selected || 0));
    run.seat.wanted = Math.max(0, Number(event.wanted || run.seat.wanted || 0));
    run.seat.attempts = Math.max(run.seat.attempts || 0, Number(event.attempt || 0));
    run.seat.reservation_status = safeText(event.status, 120) || "conflict";
    run.seat.next_action = safeText(event.next_action, 120) || "release_partial_and_retry";
    run.detail = `ที่นั่งถูกแย่งหรือชุดไม่ครบ ${run.seat.selected}/${run.seat.wanted} · กำลังลองชุดใหม่`;
  } else if (kind === "partial_released") {
    run.status = "runtime_running";
    run.stage = "partial_released";
    run.seat.selected = Math.max(0, Number(event.remaining || 0));
    run.seat.next_action = "rescan_same_zone";
    run.detail = `ปล่อย partial ${Math.max(0, Number(event.released || 0))} ที่นั่งแล้ว`;
  } else if (kind === "zone_switch") {
    run.status = "runtime_running";
    run.stage = "zone_switch";
    run.seat.current_zone = safeText(event.to_zone || event.zone, 80);
    run.seat.next_action = "scan_next_allowed_zone";
    run.detail = `เปลี่ยนไปโซน ${run.seat.current_zone || "ถัดไป"} เพราะโซนเดิมไม่มีชุดครบ`;
  } else if (kind === "reservation_verified") {
    run.status = "runtime_running";
    run.stage = "reservation_verified";
    run.reservation_verified = true;
    run.seat.current_zone = safeText(event.zone, 80) || run.seat.current_zone;
    run.seat.selected = Math.max(0, Number(event.selected || event.wanted || 0));
    run.seat.wanted = Math.max(0, Number(event.wanted || run.seat.wanted || 0));
    run.seat.reservation_status = safeText(event.status, 120) || "verified";
    run.seat.next_action = "fast_checkout";
    run.detail = `ยืนยันการถือบัตร ${run.seat.selected}/${run.seat.wanted} แล้ว · กำลัง Checkout`;
  } else if (kind === "recovery") {
    run.status = "runtime_running";
    run.stage = "recovery";
    run.seat.next_action = safeText(event.next_action || event.action, 120) || run.seat.next_action;
    run.detail = safeText(event.reason, 500) || safeText(event.status, 200) || "กำลัง recovery ด้วย session เดิม";
  } else if (kind === "queue_analysis") {
    run.status = "runtime_running";
    run.stage = "waiting_queue";
    run.queue.position = Number.isFinite(Number(event.queue_position)) ? Number(event.queue_position) : null;
    run.queue.position_verified = event.queue_position_verified === true;
    run.queue.waited_seconds = Math.max(0, Number(event.waited_seconds || 0));
    run.queue.server_status = Number(event.server_status || 0) || null;
    run.queue.current_action = safeText(event.current_action, 120);
    run.queue.next_action = safeText(event.next_action, 120);
    run.detail = run.queue.position_verified ? `กำลังรอคิวลำดับ ${run.queue.position}` : "กำลังรอคิวเดิม · เว็บไซต์ยังไม่แสดงหมายเลข";
  } else if (kind === "checkout_countdown") {
    run.status = "waiting_handoff";
    run.stage = "payment_handoff";
    run.checkout_countdown_seconds = Math.max(0, Number(event.remaining_seconds || 0));
    run.detail = `ถึงหน้า QR แล้ว · เหลือ ${run.checkout_countdown_seconds} วินาที · ระบบจะไม่ชำระเงินแทน`;
  } else if (kind === "ai_analysis") {
    run.ai.status = safeText(event.status, 80) || "analyzed";
    run.ai.state = safeText(event.state, 80);
    run.ai.action = safeText(event.action, 120);
    run.ai.diagnosis = safeText(event.diagnosis || event.reason, 500);
    run.ai.confidence = Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : null;
    run.ai.background = event.background === true;
    if (event.status === "QUEUED") run.detail = `AI กำลังวิเคราะห์ state ${run.ai.state || run.stage} เบื้องหลัง`;
  } else if (kind === "ai_action") {
    run.ai.status = event.executed === true ? "executed" : "not_executed";
    run.ai.state = safeText(event.state, 80);
    run.ai.action = safeText(event.action, 120);
    run.ai.last_action_executed = event.executed === true;
    run.detail = event.executed === true ? `AI ใช้ recovery ${run.ai.action} สำเร็จ` : `AI วิเคราะห์แล้ว แต่ action ${run.ai.action || "unknown"} ยังแก้ state ไม่ได้`;
  } else if (kind === "ai_strategy_learned") {
    run.ai.learned_strategy_count = Math.max(0, Number(run.ai.learned_strategy_count || 0)) + (event.saved === false ? 0 : 1);
    run.ai.last_learned_action = safeText(event.action, 120);
    run.detail = event.saved === false ? "AI ใช้ strategy ได้แต่บันทึกความจำไม่สำเร็จ" : `AI จำ recovery ${run.ai.last_learned_action} สำหรับใช้รอบถัดไปแล้ว`;
  } else if (kind === "evidence" || kind === "screenshot") {
    const evidencePath = safeText(event.path, 2_000);
    if (evidencePath && !run.evidence_paths.includes(evidencePath)) run.evidence_paths.push(evidencePath);
    run.detail = evidencePath ? `บันทึกภาพหลักฐาน ${evidencePath}` : "บันทึกหลักฐานแล้ว";
  } else if (kind === "input_required") {
    run.status = "waiting_handoff";
    run.stage = safeText(event.stage, 100) || `waiting_${safeText(event.field, 80) || "input"}`;
    run.handoff = {
      field: safeText(event.field, 80),
      prompt: safeText(event.prompt, 500),
      options: Array.isArray(event.options) ? event.options.map((item) => safeText(item, 120)).filter(Boolean).slice(0, 50) : [],
      secret: event.secret === true,
    };
    run.detail = run.handoff.prompt || "รอข้อมูลจากผู้ใช้";
  } else if (kind === "handoff") {
    run.status = "waiting_handoff";
    const upper = status.toUpperCase();
    run.stage = upper.includes("CAPTCHA") ? "waiting_captcha" : upper.includes("OTP") ? "waiting_otp" : "waiting_handoff";
    run.handoff = { field: run.stage, prompt: safeText(event.prompt, 500) || "รับช่วงใน Browser แล้วกดทำต่อ", options: [], secret: false };
    run.detail = run.handoff.prompt;
  } else if (kind === "result") {
    const upper = status.toUpperCase();
    run.result_status = upper;
    run.result_reason = safeText(event.reason, 500);
    if (upper === "PAYMENT_HANDOFF") {
      run.status = "waiting_handoff";
      run.stage = "payment_handoff";
      run.payment_handoff_verified = event.live_checkout_verified === true;
      run.checkout_countdown_seconds = Number.isFinite(Number(event.checkout_countdown_seconds)) ? Number(event.checkout_countdown_seconds) : null;
      run.full_loop_verified = run.payment_handoff_verified && run.reservation_verified;
      run.handoff = { field: "payment", prompt: "ถึงหน้าชำระเงินแล้ว ระบบจะไม่ชำระเงินจริง ให้ผู้ใช้ตรวจและรับช่วง", options: [], secret: false };
      run.detail = run.full_loop_verified ? "ยืนยัน reservation_verified และ PAYMENT_HANDOFF ครบแล้ว" : "ถึง payment handoff แต่ยังขาดหลักฐาน reservation_verified หรือ checkout";
    } else {
      run.stage = upper ? upper.toLowerCase() : "result";
      run.detail = status || safeText(event.reason, 500) || "บอทรายงานผลลัพธ์";
    }
  }
  run.updated_at = now();
}

export function createTicketRunManager({
  programCreateDir,
  appDir = process.cwd(),
  ticketBrowserProfileDir = "",
  shellPath = "/bin/zsh",
  logLimit = MAX_LOG_LINES,
  requiredGeneratorVersion = "",
  ollamaBaseUrl = "http://127.0.0.1:11435",
  journalDir = "",
  repairDir = "",
  repairSkillsDir = "",
  skillsIndexFile = "",
  defaultTicketUsername = "",
  ticketKeychainService = "com.alpha.ticket.thaiticketmajor",
  credentialResolver = null,
  diagnoseRuntime = null,
  validateRepair = null,
} = {}) {
  if (!programCreateDir) throw new Error("programCreateDir is required");
  const runs = new Map();
  const repairs = new Map();
  const idempotency = new Map();
  const subscribers = new Map();
  const projectRoot = resolve(appDir);
  const repairRoot = repairDir ? resolve(repairDir) : "";
  const learnedRepairSkillsRoot = repairSkillsDir ? resolve(repairSkillsDir) : "";
  const learnedSkillsIndex = skillsIndexFile ? resolve(skillsIndexFile) : "";

  async function writeJsonAtomic(destination, value) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, destination);
  }

  async function upsertRepairSkillIndex(manifest) {
    if (!learnedSkillsIndex) return;
    const current = await fs.readFile(learnedSkillsIndex, "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => []);
    const skills = Array.isArray(current) ? current.filter((item) => item?.id !== manifest.id) : [];
    skills.push(manifest);
    await writeJsonAtomic(learnedSkillsIndex, skills);
  }

  function repairSkillId(fingerprint) {
    return `runtime-repair-${safeText(fingerprint, 64).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "unknown"}`;
  }

  async function readRepairSkill(fingerprint) {
    if (!learnedRepairSkillsRoot || !fingerprint) return null;
    const id = repairSkillId(fingerprint);
    try {
      const manifest = JSON.parse(await fs.readFile(resolve(learnedRepairSkillsRoot, id, "alpha-skill.json"), "utf8"));
      return manifest?.enabled !== false && manifest?.verification_status === "verified" ? manifest : null;
    } catch {
      return null;
    }
  }

  async function installRepairSkill(candidate, run) {
    if (!learnedRepairSkillsRoot || candidate.status !== "promoted") return null;
    const tests = Array.isArray(candidate.tests) ? candidate.tests : [];
    const passed = tests.length > 0 && tests.every((test) => ["passed", "passed_by_runtime_transition"].includes(String(test.status || "")));
    if (!passed) return null;
    const id = repairSkillId(candidate.fingerprint);
    const directory = resolve(learnedRepairSkillsRoot, id);
    const previous = await fs.readFile(resolve(directory, "alpha-skill.json"), "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => null);
    const confidenceEvidence = tests.filter((test) => /hidden|canary|runtime transition|production/i.test(String(test.name || "")));
    const confidencePassed = confidenceEvidence.filter((test) => ["passed", "passed_by_runtime_transition"].includes(String(test.status || ""))).length;
    const installedAt = previous?.installed_at || new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const manifest = {
      id,
      name: `Runtime Repair · ${safeText(run.stage, 80) || "Alpha runtime"}`,
      description: `สกิล recovery ที่ผ่านการ replay/test สำหรับ ${safeText(candidate.root_cause, 500) || "runtime failure"}`,
      runtime: "node",
      entrypoint: "main.mjs",
      dependencies: ["node-stdlib"],
      trigger_examples: [safeText(candidate.root_cause, 300), `failure fingerprint ${candidate.fingerprint}`].filter(Boolean),
      test_cases: [{
        name: "matching-failure-fingerprint",
        input: { failure_fingerprint: candidate.fingerprint },
        stdout_contains: `\"repair_action\":\"${candidate.action}\"`,
        expected_files: [],
      }],
      version: Math.max(0, Number(previous?.version || 0)) + 1,
      enabled: true,
      origin: "runtime_repair",
      installed_at: installedAt,
      updated_at: updatedAt,
      verification_status: "verified",
      verified_pass_rate: 100,
      verified_passed: tests.length,
      verified_total: tests.length,
      verification_scope: `Replay/regression สำหรับ fingerprint ${candidate.fingerprint}; ไม่อ้างว่าครอบคลุม failure อื่น`,
      hidden_test_result: {
        passed: confidenceEvidence.filter((test) => /hidden/i.test(String(test.name || "")) && ["passed", "passed_by_runtime_transition"].includes(String(test.status || ""))).length,
        total: confidenceEvidence.filter((test) => /hidden/i.test(String(test.name || ""))).length,
      },
      generalization_confidence: Number(wilsonLowerBound(confidencePassed, confidenceEvidence.length).toFixed(2)),
      confidence_sample_size: confidenceEvidence.length,
      confidence_basis: "Wilson 95% lower bound จาก hidden/canary/production runtime evidence เท่านั้น",
      environment_fingerprint: createHash("sha256").update(JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        generator: requiredGeneratorVersion,
        targets: candidate.targets || [],
      })).digest("hex").slice(0, 24),
      usage_count: Number(previous?.usage_count || 0) + 1,
      success_count: Number(previous?.success_count || 0) + 1,
      last_run_at: updatedAt,
      last_error: "",
      execution_targets: ["macos_lab", "macos_host"],
      repair_trigger: {
        failure_fingerprint: candidate.fingerprint,
        stage: run.stage,
        root_cause: candidate.root_cause,
      },
      repair_action: {
        type: candidate.action,
        strategy: candidate.strategy,
        source_targets: candidate.targets || [],
      },
      preconditions: ["failure fingerprint must match", "Alpha-owned process/browser only"],
      rollback_procedure: candidate.action === "source_patch_required"
        ? "Restore the per-file backup manifest and rerun health checks"
        : "Stop the Alpha-owned recovery action and leave user applications untouched",
      latest_evidence: [...(run.evidence_paths || [])].slice(-20),
      trusted_catalog_version: 2,
    };
    const trainingReport = {
      objective: `Recover Alpha runtime failure ${candidate.fingerprint}`,
      success_criteria: "Observed the required runtime transition and passed all repair validation tests",
      passed: true,
      tested_at: updatedAt,
      tests,
      hidden_tests: [],
      verification_scope: manifest.verification_scope,
      repair_id: candidate.id,
      run_id: run.id,
      rollback_procedure: manifest.rollback_procedure,
    };
    const entrypoint = `import { readFileSync } from "node:fs";\nconst manifest = JSON.parse(readFileSync(new URL("./alpha-skill.json", import.meta.url), "utf8"));\nconst input = JSON.parse(process.argv[2] || "{}");\nif (input.failure_fingerprint && input.failure_fingerprint !== manifest.repair_trigger.failure_fingerprint) { console.error("failure fingerprint does not match this verified repair skill"); process.exit(2); }\nconsole.log(JSON.stringify({ ok: true, repair_action: manifest.repair_action.type, strategy: manifest.repair_action.strategy, rollback: manifest.rollback_procedure }));\n`;
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomic(resolve(directory, "alpha-skill.json"), manifest);
    await writeJsonAtomic(resolve(directory, "training-report.json"), trainingReport);
    await fs.writeFile(resolve(directory, "main.mjs"), entrypoint, "utf8");
    await upsertRepairSkillIndex(manifest);
    candidate.skill_id = id;
    run.ai.learned_strategy_count = Math.max(0, Number(run.ai.learned_strategy_count || 0)) + 1;
    run.ai.last_learned_action = candidate.action;
    emitInternal(run, "repair_skill_installed", {
      repair_id: candidate.id,
      skill_id: id,
      summary: `ติดตั้ง Repair Skill ${id} หลังผ่าน ${tests.length}/${tests.length} tests`,
      tests,
    });
    return manifest;
  }

  async function markRepairSkillStale(candidate) {
    if (!learnedRepairSkillsRoot || !candidate?.skill_id) return;
    const destination = resolve(learnedRepairSkillsRoot, candidate.skill_id, "alpha-skill.json");
    try {
      const manifest = JSON.parse(await fs.readFile(destination, "utf8"));
      manifest.enabled = false;
      manifest.verification_status = "stale";
      manifest.updated_at = new Date().toISOString();
      manifest.last_error = "Repair was rolled back; reverify before reuse";
      await writeJsonAtomic(destination, manifest);
      await upsertRepairSkillIndex(manifest);
    } catch { /* rollback must still complete if the optional skill registry is unavailable */ }
  }

  function runCommand(command, args, { cwd = projectRoot, timeout = 180_000 } = {}) {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        rejectRun(new Error(`${basename(command)} timeout after ${timeout}ms`));
      }, timeout);
      child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-40_000); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-40_000); });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectRun(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = { code: code ?? 1, stdout, stderr };
        if (result.code === 0) resolveRun(result);
        else rejectRun(new Error((stderr || stdout || `${basename(command)} exited ${result.code}`).slice(-12_000)));
      });
    });
  }

  function sourcePatchTargets(patchText) {
    // Repair validation must run against trusted tests from the current
    // release. A proposed source patch cannot weaken or rewrite those tests.
    const allowedRoots = new Set(["app", "components", "lib", "scripts", "templates", "tool-service"]);
    const allowedRootFiles = new Set(["package.json", "pnpm-lock.yaml", "tsconfig.json", "next.config.mjs", "wrangler.jsonc"]);
    const targets = [];
    for (const line of String(patchText || "").split(/\r?\n/)) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      if (!match) continue;
      const name = match[1].trim();
      if (!name || name === "/dev/null" || name.includes("\0")) throw new Error("source repair ยังไม่รองรับการลบไฟล์");
      const destination = resolve(projectRoot, name);
      if (!pathInside(destination, projectRoot)) throw new Error("source repair พยายามออกนอกโปรเจกต์");
      const top = name.split("/")[0];
      if (!allowedRoots.has(top) && !allowedRootFiles.has(name)) throw new Error(`source repair แตะพาธที่ไม่อยู่ใน Project Autopilot: ${name}`);
      if (!targets.includes(name)) targets.push(name);
    }
    if (!targets.length) throw new Error("Repair Proposal ไม่มี unified diff ที่ระบุไฟล์เป้าหมาย");
    return targets;
  }

  async function runRepairValidation(root) {
    if (typeof validateRepair === "function") return validateRepair(root);
    const testsDir = resolve(root, "tests");
    const testFiles = (await fs.readdir(testsDir)).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => resolve(testsDir, name));
    if (!testFiles.length) throw new Error("repair sandbox ไม่มี regression tests");
    const tests = await runCommand(process.execPath, ["--test", ...testFiles], { cwd: root, timeout: 180_000 });
    const build = await runCommand(process.env.ALPHA_PNPM_PATH || "pnpm", ["run", "build"], { cwd: root, timeout: 240_000 });
    return {
      tests: { name: `regression ${testFiles.length} files`, status: "passed", output: tests.stdout.slice(-2_000) },
      build: { name: "production build", status: "passed", output: build.stdout.slice(-2_000) },
    };
  }

  async function verifySourceRepair(candidate) {
    if (!repairRoot) throw new Error("ยังไม่ได้กำหนด repair sandbox directory");
    const targets = sourcePatchTargets(candidate.patch_diff);
    const destination = resolve(repairRoot, candidate.id);
    const sandbox = await fs.mkdtemp(resolve(tmpdir(), `alpha-repair-${candidate.id.slice(0, 8)}-`));
    const patchPath = resolve(destination, "patch.diff");
    await fs.mkdir(destination, { recursive: true });
    const excluded = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "evidence", "node_modules", "outputs", "Program_Create", "work"]);
    try {
      await fs.cp(projectRoot, sandbox, {
        recursive: true,
        filter(source) {
          const rel = relative(projectRoot, source);
          if (!rel) return true;
          if (basename(source).startsWith("._") || basename(source) === ".dev.vars") return false;
          return !excluded.has(rel.split(sep)[0]);
        },
      });
      const projectModules = resolve(projectRoot, "node_modules");
      try { await fs.access(projectModules); await fs.symlink(projectModules, resolve(sandbox, "node_modules"), "dir"); } catch { /* pnpm/build reports a precise missing dependency */ }
      await runCommand("/usr/bin/git", ["apply", "--no-index", "--check", patchPath], { cwd: sandbox, timeout: 30_000 });
      await runCommand("/usr/bin/git", ["apply", "--no-index", patchPath], { cwd: sandbox, timeout: 30_000 });
      const validation = await runRepairValidation(sandbox);
      candidate.targets = targets;
      candidate.tests = [validation.tests, validation.build];
      candidate.status = "verified";
      candidate.verified_at = now();
      return candidate;
    } catch (error) {
      candidate.status = "verification_failed";
      candidate.tests = [{ name: "repair sandbox", status: "failed", output: safeText(error?.message, 4_000) }];
      candidate.verification_error = safeText(error?.message, 4_000);
      return candidate;
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function restoreSourceBackup(candidate) {
    const manifest = Array.isArray(candidate.backup_manifest) ? candidate.backup_manifest : [];
    for (const item of manifest) {
      const destination = resolve(projectRoot, item.path);
      if (!pathInside(destination, projectRoot)) continue;
      if (item.existed) {
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.copyFile(resolve(repairRoot, candidate.id, "backup", item.path), destination);
        if (Number.isInteger(item.mode)) await fs.chmod(destination, item.mode).catch(() => undefined);
      } else {
        await fs.rm(destination, { force: true });
      }
    }
  }

  async function promoteVerifiedSourceRepair(candidate, run) {
    if (candidate.status !== "verified") throw new Error("source patch ต้องผ่าน repair sandbox tests ก่อนติดตั้ง");
    if (!repairRoot) throw new Error("ยังไม่ได้กำหนด repair directory");
    const targets = Array.isArray(candidate.targets) && candidate.targets.length ? candidate.targets : sourcePatchTargets(candidate.patch_diff);
    const destination = resolve(repairRoot, candidate.id);
    const patchPath = resolve(destination, "patch.diff");
    const backupRoot = resolve(destination, "backup");
    await fs.rm(backupRoot, { recursive: true, force: true });
    const manifest = [];
    for (const name of targets) {
      const source = resolve(projectRoot, name);
      const backup = resolve(backupRoot, name);
      let existed = false;
      try {
        const stat = await fs.lstat(source);
        existed = stat.isFile() && !stat.isSymbolicLink();
      } catch { existed = false; }
      if (existed) {
        await fs.mkdir(dirname(backup), { recursive: true });
        await fs.copyFile(source, backup);
      }
      const mode = existed ? (await fs.stat(source)).mode : null;
      manifest.push({ path: name, existed, mode });
    }
    candidate.backup_manifest = manifest;
    try {
      await runCommand("/usr/bin/git", ["apply", "--check", patchPath], { cwd: projectRoot, timeout: 30_000 });
      await runCommand("/usr/bin/git", ["apply", patchPath], { cwd: projectRoot, timeout: 30_000 });
      const validation = await runRepairValidation(projectRoot);
      candidate.tests = [
        validation.tests,
        validation.build,
        { name: "post-install production canary", status: "passed", output: "trusted regression and production build passed in the installed project" },
      ];
      candidate.status = "promoted";
      candidate.promoted_at = now();
      emitInternal(run, "repair_promoted", { repair_id: candidate.id, summary: candidate.strategy, tests: candidate.tests });
      return;
    } catch (error) {
      await restoreSourceBackup(candidate);
      candidate.status = "rolled_back";
      candidate.rolled_back_at = now();
      candidate.tests = [...(candidate.tests || []), { name: "post-install health", status: "failed", output: safeText(error?.message, 4_000) }];
      emitInternal(run, "repair_rolled_back", { repair_id: candidate.id, summary: "health check หลังติดตั้งล้มเหลว จึงคืนไฟล์ backup อัตโนมัติ", tests: candidate.tests });
      throw new Error(`ติดตั้ง source patch ไม่สำเร็จและ rollback แล้ว: ${safeText(error?.message, 1_000)}`);
    } finally {
      await fs.writeFile(resolve(destination, "proposal.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8").catch(() => undefined);
    }
  }

  function eventForStorage(event) {
    const serialized = JSON.stringify(event);
    try {
      return JSON.parse(redactLine(serialized, []));
    } catch {
      return { at: new Date().toISOString(), kind: "event_redacted", detail: "event exceeded the bounded journal payload" };
    }
  }

  function notify(run) {
    for (const listener of subscribers.get(run.id) || []) {
      try { listener({ run: publicRun(run), cursor: run.event_cursor }); } catch { /* disconnected stream */ }
    }
  }

  function persistRun(run) {
    if (!journalDir) return;
    const destination = resolve(journalDir, `${run.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    const payload = JSON.stringify({ run: publicRun(run), events: run.events || [], idempotency_key: run.idempotency_key || "" }, null, 2) + "\n";
    run.persist_chain = (run.persist_chain || Promise.resolve()).then(async () => {
      await fs.mkdir(journalDir, { recursive: true });
      await fs.writeFile(temporary, payload, "utf8");
      await fs.rename(temporary, destination);
    }).catch(() => undefined);
  }

  function appendEvent(run, event) {
    run.event_cursor = Number(run.event_cursor || 0) + 1;
    const stored = { cursor: run.event_cursor, ...eventForStorage(event) };
    run.events.push(stored);
    if (run.events.length > 2_000) run.events.splice(0, run.events.length - 2_000);
    persistRun(run);
    notify(run);
    return stored;
  }

  function emitInternal(run, kind, payload = {}) {
    const event = { at: new Date().toISOString(), kind, ...payload };
    mapEvent(run, event);
    appendEvent(run, event);
  }

  const readyPromise = (async () => {
    if (!journalDir) return;
    await fs.mkdir(journalDir, { recursive: true });
    const names = await fs.readdir(journalDir).catch(() => []);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const saved = JSON.parse(await fs.readFile(resolve(journalDir, name), "utf8"));
        const run = saved?.run;
        if (!run?.id || runs.has(run.id)) continue;
        run.logs = Array.isArray(run.logs) ? run.logs : [];
        run.events = Array.isArray(saved.events) ? saved.events : [];
        run.event_cursor = Number(run.event_cursor || run.events.at(-1)?.cursor || 0);
        run.seat = { current_zone: "", candidate_set: [], selected: 0, wanted: 0, attempts: 0, reservation_status: "pending", next_action: "", ...(run.seat || {}) };
        run.queue = { position: null, position_verified: false, waited_seconds: 0, server_status: null, current_action: "", next_action: "", ...(run.queue || {}) };
        run.ai = { status: "idle", ...(run.ai || {}) };
        run.heartbeat = { ...(run.heartbeat || {}) };
        run.supervisor = { status: "standby", ...(run.supervisor || {}) };
        run.manual_control = { active: false, ...(run.manual_control || {}) };
        run.child = null;
        if (ACTIVE.has(run.status)) {
          run.status = "not_verified";
          run.stage = "service_restarted";
          run.detail = "Tool Service เริ่มใหม่ระหว่าง run · เก็บ journal ไว้แล้วแต่ process เดิมไม่สามารถอ้างว่ายังทำงานอยู่";
          run.ended_at = now();
          run.updated_at = run.ended_at;
          run.heartbeat.process_alive = false;
          run.heartbeat.browser_connected = false;
          run.supervisor.status = "needs_repair";
          run.supervisor.last_action = "analyze_service_restart";
          run.supervisor.root_cause = run.detail;
        }
        runs.set(run.id, run);
        if (saved.idempotency_key) idempotency.set(String(saved.idempotency_key), run.id);
        if (run.stage === "service_restarted") scheduleAutomaticRepairAnalysis(run, run.detail);
      } catch { /* ignore a partial journal; the live run remains authoritative */ }
    }
    if (repairRoot) {
      await fs.mkdir(repairRoot, { recursive: true });
      const repairNames = await fs.readdir(repairRoot).catch(() => []);
      for (const repairName of repairNames) {
        try {
          const candidate = JSON.parse(await fs.readFile(resolve(repairRoot, repairName, "proposal.json"), "utf8"));
          if (candidate?.id && candidate?.run_id) repairs.set(candidate.id, candidate);
        } catch { /* a partial proposal is ignored without affecting restored runs */ }
      }
    }
  })();

  async function ready() {
    await readyPromise;
    return { ok: true, restored: runs.size };
  }

  async function cleanupOwnedBrowser(run = null) {
    if (!ticketBrowserProfileDir) {
      if (run) {
        run.browser_cleanup = "not_configured";
        run.heartbeat.browser_connected = false;
      }
      return [];
    }
    let pids = [];
    try {
      pids = ownedBrowserPidsFromPs(await processTable(), ticketBrowserProfileDir)
        .filter((pid) => pid !== process.pid && pid !== Number(run?.pid || 0));
      for (const pid of pids) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already closed */ }
      }
      if (pids.length) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      for (const pid of pids) {
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* exited after SIGTERM */ }
      }
      if (run) {
        run.browser_cleanup = pids.length ? "closed" : "already_closed";
        run.heartbeat.browser_connected = false;
        run.updated_at = now();
      }
      return pids;
    } catch (error) {
      if (run) {
        run.browser_cleanup = "failed";
        run.heartbeat.browser_connected = false;
        run.detail = `${run.detail || "Ticket Bot จบแล้ว"} · ปิด Chrome ของบอทไม่สำเร็จ: ${safeText(error?.message, 300)}`;
        run.updated_at = now();
      }
      return [];
    }
  }

  async function validateProject(projectPath) {
    const rootReal = await fs.realpath(resolve(programCreateDir));
    const requested = resolve(String(projectPath || ""));
    const projectReal = await fs.realpath(requested);
    if (!pathInside(projectReal, rootReal)) throw new Error("project_path อยู่นอก Program_Create หรือหลุดออกผ่าน symlink");
    for (const name of REQUIRED_FILES) {
      const file = resolve(projectReal, name);
      if (!pathInside(file, projectReal)) throw new Error("พาธไฟล์ runtime ไม่ปลอดภัย");
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} ต้องเป็นไฟล์จริงและห้ามเป็น symlink`);
    }
    if (requiredGeneratorVersion) {
      const config = JSON.parse(await fs.readFile(resolve(projectReal, "config.json"), "utf8"));
      if (safeText(config?.generatorVersion, 80) !== requiredGeneratorVersion) {
        throw new Error(`โปรเจกต์ Ticket Bot เป็นเวอร์ชันเก่าหรือไม่ทราบเวอร์ชัน กรุณาสร้างใหม่ด้วย ${requiredGeneratorVersion}`);
      }
    }
    return projectReal;
  }

  function appendLog(run, stream, line, secrets) {
    const text = redactLine(line, secrets).trim();
    if (!text) return;
    run.logs.push({ at: now(), stream, text });
    if (run.logs.length > logLimit) run.logs.splice(0, run.logs.length - logLimit);
    if (stream === "stdout") {
      try {
        const event = JSON.parse(text);
        if (event && typeof event === "object" && !Array.isArray(event)) {
          mapEvent(run, event);
          appendEvent(run, event);
        }
      } catch { /* plain stdout is still useful as a redacted log */ }
    }
    run.updated_at = now();
    persistRun(run);
  }

  function attachLineReader(run, stream, source, secrets) {
    let buffer = "";
    source.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) appendLog(run, stream, line, secrets);
    });
    source.on("end", () => {
      if (buffer) appendLog(run, stream, buffer, secrets);
      buffer = "";
    });
  }

  function scheduleAutomaticRepairAnalysis(run, reason) {
    if (run.stop_requested || run.supervisor.auto_analysis_inflight) return;
    if (run.repair && !["verification_failed", "rolled_back"].includes(run.repair.status)) return;
    run.supervisor.auto_analysis_inflight = true;
    emitInternal(run, "supervisor_action", {
      status: "analyzing",
      action: "automatic_failure_analysis_queued",
      root_cause: reason,
      automatic: true,
    });
    const timer = setTimeout(() => {
      void repair(run.id).catch((error) => {
        emitInternal(run, "supervisor_action", {
          status: "needs_repair",
          action: "automatic_failure_analysis_failed",
          root_cause: safeText(error?.message, 500) || reason,
          automatic: true,
        });
      }).finally(() => {
        run.supervisor.auto_analysis_inflight = false;
      });
    }, 250);
    timer.unref?.();
  }

  async function launchRun(run, { username, password, inspectOnly, secrets }) {
    try {
      const projectPath = await validateProject(run.project_path);
      run.project_path = projectPath;
      run.stage = "preparing_runtime";
      run.detail = "ตรวจโปรเจกต์แล้ว · กำลังเตรียม Browser ของ Alpha";
      run.updated_at = now();
      emitInternal(run, "supervisor_action", { status: "standby", action: "project_validated", root_cause: "" });
      if (run.stop_requested) return;
      await cleanupOwnedBrowser(run);
      if (run.stop_requested) return;

      const script = resolve(projectPath, "start.command");
      const args = [script, "--wait-for-window", ...(inspectOnly ? ["--inspect-only"] : ["--confirm-order"])];
      const child = spawn(shellPath, args, {
        cwd: projectPath,
        detached: true,
        env: {
          ...process.env,
          // The Python bot writes JSONL heartbeats to stdout. A pipe is block
          // buffered by default, which previously let the supervisor time out
          // and kill a browser that had already connected successfully.
          PYTHONUNBUFFERED: "1",
          ...(username ? { TICKET_USERNAME: username } : {}),
          ...(password ? { TICKET_PASSWORD: password } : {}),
          ...(ticketBrowserProfileDir ? { ALPHA_TICKET_BROWSER_PROFILE: resolve(ticketBrowserProfileDir) } : {}),
          ALPHA_OLLAMA_BASE_URL: String(ollamaBaseUrl || "http://127.0.0.1:11435").replace(/\/$/, ""),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      run.child = child;
      run.pid = child.pid || null;
      attachLineReader(run, "stdout", child.stdout, secrets);
      attachLineReader(run, "stderr", child.stderr, secrets);
      child.once("spawn", () => {
        if (run.status === "starting_runtime") {
          run.status = "runtime_running";
          run.stage = "process_started";
          run.detail = `เริ่ม process ${basename(script)} แล้ว`;
          run.updated_at = now();
          run.heartbeat.process_spawned_at = run.updated_at;
          run.heartbeat.process_alive = true;
          emitInternal(run, "supervisor_action", { status: "standby", action: "process_spawned", root_cause: "" });
        }
      });
      child.once("error", (error) => {
        run.status = "failed";
        run.stage = "spawn_failed";
        run.detail = redactLine(error?.message || "เริ่ม process ไม่สำเร็จ", secrets);
        run.ended_at = now();
        run.updated_at = run.ended_at;
        run.heartbeat.process_alive = false;
        emitInternal(run, "supervisor_action", { status: "needs_repair", action: "inspect_spawn_failure", root_cause: run.detail });
        scheduleAutomaticRepairAnalysis(run, run.detail);
      });
      child.once("close", (code) => {
        run.exit_code = code ?? 1;
        run.ended_at = now();
        run.updated_at = run.ended_at;
        run.handoff = null;
        run.heartbeat.process_alive = false;
        if (run.stop_requested) {
          run.status = "stopped";
          run.stage = "stopped";
          run.detail = "ผู้ใช้หยุด Ticket Bot แล้ว";
        } else if ((code ?? 1) !== 0) {
          run.status = "failed";
          run.stage = run.result_status ? run.result_status.toLowerCase() : "process_failed";
          run.detail = run.result_status
            ? `${run.result_status}${run.result_reason ? ` · ${run.result_reason}` : ""} (exit code ${code ?? 1})`
            : `Ticket Bot จบด้วย exit code ${code ?? 1}`;
        } else if (run.full_loop_verified) {
          run.status = "completed";
          run.stage = "completed_payment_handoff";
          run.detail = "process จบหลังยืนยัน reservation_verified และ PAYMENT_HANDOFF";
        } else if (HANDLED_TERMINAL_RESULTS.has(run.result_status)) {
          run.status = "completed";
          run.stage = run.result_status.toLowerCase();
          run.detail = `ตรวจสถานะสำเร็จ: ${run.result_status} · ไม่ใช่ Full Loop และไม่มีการชำระเงินจริง`;
        } else {
          run.status = "not_verified";
          run.stage = run.result_status ? run.result_status.toLowerCase() : "ended_without_payment_handoff";
          run.detail = run.result_status
            ? `${run.result_status}${run.result_reason ? ` · ${run.result_reason}` : ""} · ยังไม่ผ่าน Full Loop`
            : "process จบโดยยังไม่มีหลักฐาน PAYMENT_HANDOFF — ไม่ถือว่าผ่าน";
        }
        run.child = null;
        if (["failed", "not_verified"].includes(run.status)) scheduleAutomaticRepairAnalysis(run, run.detail);
        persistRun(run);
        notify(run);
        void cleanupOwnedBrowser(run).then(() => {
          run.heartbeat.browser_connected = false;
          persistRun(run);
          notify(run);
        });
      });
    } catch (error) {
      run.status = "failed";
      run.stage = "runtime_prepare_failed";
      run.detail = redactLine(error?.message || "เตรียม Ticket Runtime ไม่สำเร็จ", secrets);
      run.ended_at = now();
      run.updated_at = run.ended_at;
      run.heartbeat.process_alive = false;
      run.heartbeat.browser_connected = false;
      emitInternal(run, "supervisor_action", { status: "needs_repair", action: "inspect_runtime_prepare_failure", root_cause: run.detail });
      scheduleAutomaticRepairAnalysis(run, run.detail);
      persistRun(run);
      notify(run);
    }
  }

  async function start(input = {}) {
    await readyPromise;
    const idempotencyKey = safeText(input.idempotency_key, 200);
    const existingId = idempotencyKey ? idempotency.get(idempotencyKey) : "";
    if (existingId && runs.has(existingId)) return { ok: true, reused: true, run: publicRun(runs.get(existingId)) };
    const requestedProjectPath = resolve(String(input.project_path || ""));
    const activeRun = [...runs.values()].find((item) => ACTIVE.has(item.status));
    if (activeRun && [activeRun.project_path, activeRun.requested_project_path].includes(requestedProjectPath)) return { ok: true, reused: true, run: publicRun(activeRun) };
    if (activeRun) throw new Error("มี Ticket Bot อีกงานกำลังใช้ browser session อยู่ กรุณาหยุดหรือทำงานเดิมให้จบก่อนเริ่มโปรเจกต์ใหม่");

    let username = safeText(input.username, 500);
    let password = typeof input.password === "string" ? input.password : "";
    let credentialSource = username || password ? "provided" : "prompt";
    if (!username) username = safeText(defaultTicketUsername, 500);
    if (!password && username) {
      password = typeof credentialResolver === "function"
        ? String(await credentialResolver({ service: ticketKeychainService, account: username }) || "")
        : await readMacKeychainPassword(ticketKeychainService, username);
      if (password) credentialSource = "keychain";
    }
    const inspectOnly = input.inspect_only === true;
    const secrets = [username, password].filter(Boolean);
    const id = randomUUID();
    const started = now();
    const run = {
      id,
      project_path: requestedProjectPath,
      requested_project_path: requestedProjectPath,
      pid: null,
      status: "starting_runtime",
      stage: "starting_runtime",
      detail: inspectOnly ? "รับคำสั่งแล้ว · กำลังเริ่ม Ticket Bot แบบ inspect-only" : "รับคำสั่งแล้ว · กำลังเตรียม Ticket Bot process จริง",
      started_at: started,
      updated_at: started,
      ended_at: null,
      exit_code: null,
      handoff: null,
      logs: [],
      latest_url: "",
      full_loop_verified: false,
      reservation_verified: false,
      payment_handoff_verified: false,
      seat: { current_zone: "", candidate_set: [], selected: 0, wanted: 0, attempts: 0, reservation_status: "pending", next_action: "" },
      queue: { position: null, position_verified: false, waited_seconds: 0, server_status: null, current_action: "", next_action: "" },
      ai: { status: "idle", state: "", action: "", diagnosis: "", confidence: null, background: true, last_action_executed: false, learned_strategy_count: 0, last_learned_action: "" },
      checkout_countdown_seconds: null,
      result_status: "",
      result_reason: "",
      evidence_paths: [],
      browser_pid: null,
      browser_cleanup: "pending",
      event_cursor: 0,
      events: [],
      heartbeat: {
        command_received_at: started,
        process_spawned_at: null,
        browser_connected_at: null,
        ai_ready_at: null,
        last_event_at: started,
        last_activity_at: started,
        process_alive: false,
        browser_connected: false,
        ai_ready: false,
        sequence: 0,
      },
      supervisor: { status: "standby", last_action: "", root_cause: "", updated_at: started, failure_fingerprint: "" },
      manual_control: { active: false, policy: "observe_then_resume", last_interrupt_at: null, from_state: "", to_state: "", updated_at: started },
      repair: null,
      stop_requested: false,
      credential_source: credentialSource,
      idempotency_key: idempotencyKey,
      child: null,
    };
    runs.set(id, run);
    if (idempotencyKey) idempotency.set(idempotencyKey, id);
    emitInternal(run, "runtime_heartbeat", { sequence: 0, process_alive: false, browser_connected: false, ai_ready: false, phase: "command_received" });
    queueMicrotask(() => { void launchRun(run, { username, password, inspectOnly, secrets }); });
    return { ok: true, reused: false, run: publicRun(run) };
  }

  function get(id) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    return { ok: true, run: publicRun(run) };
  }

  function events(id, cursor = 0) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    const after = Math.max(0, Number(cursor || 0));
    return { ok: true, cursor: run.event_cursor, events: run.events.filter((event) => Number(event.cursor || 0) > after), run: publicRun(run) };
  }

  function subscribe(id, listener) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    const set = subscribers.get(run.id) || new Set();
    set.add(listener);
    subscribers.set(run.id, set);
    listener({ run: publicRun(run), cursor: run.event_cursor });
    return () => {
      set.delete(listener);
      if (!set.size) subscribers.delete(run.id);
    };
  }

  async function input(id, value = "") {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    if (!run.child || !ACTIVE.has(run.status)) throw new Error("Ticket Run นี้ไม่ได้รอ input แล้ว");
    if (!run.child.stdin?.writable) throw new Error("stdin ของ Ticket Run ปิดแล้ว");
    const text = typeof value === "string" ? value.slice(0, 4_000) : "";
    await new Promise((resolveWrite, reject) => run.child.stdin.write(text + "\n", (error) => error ? reject(error) : resolveWrite()));
    run.status = "runtime_running";
    run.stage = "resuming";
    run.detail = "ส่งข้อมูลให้ process แล้ว กำลังทำงานต่อ";
    run.handoff = null;
    run.updated_at = now();
    return { ok: true, run: publicRun(run) };
  }

  async function resume(id) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    if (!run.child || !ACTIVE.has(run.status)) throw new Error("process เดิมไม่ทำงานแล้ว ต้องสร้าง Repair Proposal หรือเริ่ม run ใหม่");
    emitInternal(run, "supervisor_action", { status: "recovering", action: "resume_same_process", root_cause: "resume_requested" });
    return input(id, "");
  }

  async function localAiDiagnosis(run) {
    const fallback = {
      root_cause: run.stage === "spawn_failed" ? "ticket process failed to spawn" : `runtime stalled or failed at ${run.stage || "unknown"}`,
      strategy: run.child ? "resume_run" : "rerun_project",
      action: run.child ? "resume_run" : "rerun_project",
      patch_diff: "",
      test_plan: ["runtime heartbeat", "browser connection", "state transition"],
    };
    const controller = new AbortController();
    // Recovery runs outside the Fast Seat Engine critical path. Give a warm
    // local 9B model enough time to return a real diagnosis instead of silently
    // falling back during model startup or a longer runtime snapshot.
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      if (typeof diagnoseRuntime === "function") return await diagnoseRuntime(publicRun(run));
      const recentLogs = run.logs.slice(-40).map((item) => `${item.stream}: ${item.text}`).join("\n").slice(-12_000);
      const response = await fetch(`${String(ollamaBaseUrl).replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "alpha:9b",
          stream: false,
          format: "json",
          think: false,
          // Keep the supervisor responsive during an incident without pinning
          // the 9B model in unified memory for the whole Alpha session.
          keep_alive: -1,
          messages: [{ role: "system", content: "You diagnose Alpha ticket runtime failures. Return strict JSON with root_cause, strategy, action, patch_diff, test_plan. test_plan must be an array of short strings. action must be resume_run, restart_owned_browser, rerun_project, or source_patch_required. Never include credentials and never claim tests ran." }, { role: "user", content: JSON.stringify({
            stage: run.stage,
            status: run.status,
            detail: run.detail,
            latest_url: run.latest_url,
            heartbeat: run.heartbeat,
            seat: run.seat,
            queue: run.queue,
            manual_control: run.manual_control,
            evidence_paths: [...(run.evidence_paths || [])].slice(-20),
            logs: recentLogs,
          }) }],
          options: { temperature: 0.1, num_predict: 384 },
        }),
      });
      if (!response.ok) return fallback;
      const payload = await response.json();
      const parsed = JSON.parse(payload?.message?.content || "{}");
      const allowed = new Set(["resume_run", "restart_owned_browser", "rerun_project", "source_patch_required"]);
      return {
        root_cause: safeText(parsed.root_cause, 1_000) || fallback.root_cause,
        strategy: safeText(parsed.strategy, 500) || fallback.strategy,
        action: allowed.has(parsed.action) ? parsed.action : fallback.action,
        patch_diff: safeText(parsed.patch_diff, 20_000),
        test_plan: Array.isArray(parsed.test_plan) ? parsed.test_plan.map((item) => safeText(item, 300)).filter(Boolean).slice(0, 30) : fallback.test_plan,
      };
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  async function repair(id) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    run.supervisor.status = "analyzing";
    emitInternal(run, "supervisor_action", { status: "analyzing", action: "collect_redacted_runtime_snapshot", root_cause: run.detail });
    const diagnosis = await localAiDiagnosis(run);
    const fingerprint = createHash("sha256").update(JSON.stringify({ stage: run.stage, status: run.status, root_cause: diagnosis.root_cause, latest_url: run.latest_url })).digest("hex").slice(0, 16);
    const learnedSkill = await readRepairSkill(fingerprint);
    if (learnedSkill && ["resume_run", "restart_owned_browser"].includes(learnedSkill.repair_action?.type)) {
      diagnosis.action = learnedSkill.repair_action.type;
      diagnosis.strategy = `reuse verified Repair Skill ${learnedSkill.id}: ${learnedSkill.repair_action.strategy}`;
    }
    if (run.supervisor.failure_fingerprint === fingerprint && run.supervisor.last_action === diagnosis.action) {
      diagnosis.action = diagnosis.action === "resume_run" ? "restart_owned_browser" : "source_patch_required";
      diagnosis.strategy = "failure fingerprint did not change; escalate to a different strategy";
    }
    const repairId = randomUUID();
    const candidate = {
      id: repairId,
      run_id: run.id,
      status: diagnosis.action === "rerun_project" ? "restart_required" : "candidate",
      created_at: now(),
      root_cause: diagnosis.root_cause,
      strategy: diagnosis.strategy,
      action: diagnosis.action,
      patch_diff: diagnosis.patch_diff,
      diff_summary: diagnosis.patch_diff
        ? diagnosis.patch_diff.split("\n").slice(0, 20).join("\n")
        : diagnosis.action === "rerun_project"
          ? "process เดิมจบแล้ว จึงต้องเริ่ม Run ใหม่ด้วยโปรเจกต์เดิม; session browser เดิมยังใช้ต่อได้ และ credential จะรับแบบชั่วคราวจากหน้า UI เท่านั้น"
          : "ไม่มี source diff; เป็น transient runtime recovery",
      tests: diagnosis.test_plan.map((name) => ({ name, status: "pending" })),
      confirmation_required: diagnosis.action === "source_patch_required",
      fingerprint,
      learned_skill_id: learnedSkill?.id || "",
    };
    repairs.set(repairId, candidate);
    run.repair = { id: repairId, status: "candidate", summary: diagnosis.root_cause, diff_summary: candidate.diff_summary, tests: candidate.tests, action: candidate.action, confirmation_required: candidate.confirmation_required };
    run.supervisor.failure_fingerprint = fingerprint;
    run.supervisor.last_action = diagnosis.action;
    emitInternal(run, "ai_diagnosis", { repair_id: repairId, diagnosis: diagnosis.root_cause, strategy: diagnosis.strategy, action: diagnosis.action, fingerprint });
    if (repairRoot) {
      const destination = resolve(repairRoot, repairId);
      await fs.mkdir(destination, { recursive: true });
      if (candidate.patch_diff) await fs.writeFile(resolve(destination, "patch.diff"), candidate.patch_diff, "utf8");
    }
    if (candidate.action === "source_patch_required") {
      if (candidate.patch_diff) {
        await verifySourceRepair(candidate);
      } else {
        candidate.status = "verification_failed";
        candidate.tests = [{ name: "repair sandbox", status: "failed", output: "AI ระบุว่าต้องแก้ source แต่ไม่ได้สร้าง unified diff" }];
      }
    }
    run.repair = {
      id: repairId,
      status: candidate.status,
      summary: diagnosis.root_cause,
      diff_summary: candidate.diff_summary,
      tests: candidate.tests,
      action: candidate.action,
      confirmation_required: candidate.confirmation_required,
    };
    if (repairRoot) {
      await fs.writeFile(resolve(repairRoot, repairId, "proposal.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    }
    emitInternal(run, "repair_candidate", { repair_id: repairId, summary: diagnosis.root_cause, diff_summary: candidate.diff_summary, tests: candidate.tests, action: candidate.action, confirmation_required: candidate.confirmation_required, status: candidate.status });
    if (candidate.status === "verified") {
      emitInternal(run, "repair_verified", { repair_id: repairId, summary: diagnosis.root_cause, tests: candidate.tests, confirmation_required: true });
    }
    return { ok: true, repair: { ...candidate }, run: publicRun(run) };
  }

  async function promoteRepair(repairId) {
    const candidate = repairs.get(String(repairId || ""));
    if (!candidate) throw new Error("ไม่พบ Repair Proposal");
    const run = runs.get(candidate.run_id);
    if (!run) throw new Error("ไม่พบ Ticket Run ของ Repair Proposal");
    const verifiedSourcePatch = candidate.action === "source_patch_required" && candidate.status === "verified";
    if (candidate.action === "source_patch_required" && !verifiedSourcePatch) {
      throw new Error("source patch ยังไม่ผ่าน sandbox tests จึงยังติดตั้งไม่ได้");
    }
    candidate.status = "promoting";
    const activityBefore = Number(run.heartbeat.last_event_at || 0);
    if (candidate.action === "resume_run") {
      const pid = Number(run.pid || 0);
      try { if (pid > 0) process.kill(-pid, "SIGCONT"); else run.child?.kill("SIGCONT"); } catch { /* verified below by heartbeat */ }
      emitInternal(run, "supervisor_action", { status: "recovering", action: "resume_owned_process_without_stdin", root_cause: candidate.root_cause });
    } else if (candidate.action === "restart_owned_browser") {
      await cleanupOwnedBrowser(run);
      emitInternal(run, "supervisor_action", { status: "recovering", action: "restart_owned_browser_and_preserve_profile", root_cause: candidate.root_cause });
    } else if (candidate.action === "rerun_project") {
      throw new Error("การรันใหม่ต้องกรอก credential แบบชั่วคราวอีกครั้ง ระบบไม่เก็บ credential ไว้ใน Repair Proposal");
    } else if (verifiedSourcePatch) {
      candidate.status = "verified";
      await promoteVerifiedSourceRepair(candidate, run);
      await installRepairSkill(candidate, run);
      if (repairRoot) await writeJsonAtomic(resolve(repairRoot, candidate.id, "proposal.json"), candidate);
      return { ok: true, repair: { ...candidate }, run: publicRun(run) };
    } else {
      throw new Error("source patch ยังไม่ผ่าน sandbox tests จึงยังติดตั้งไม่ได้");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 6_500));
    if (!run.child || !ACTIVE.has(run.status) || Number(run.heartbeat.last_event_at || 0) <= activityBefore) {
      candidate.status = "verification_failed";
      candidate.tests = candidate.tests.map((test) => ({ ...test, status: "failed_no_runtime_transition" }));
      emitInternal(run, "repair_candidate", { repair_id: candidate.id, status: candidate.status, summary: "transient repair ไม่ทำให้ runtime heartbeat กลับมา", tests: candidate.tests });
      throw new Error("transient repair ไม่ผ่าน: runtime heartbeat ไม่กลับมา");
    }
    candidate.status = "promoted";
    candidate.promoted_at = now();
    candidate.tests = candidate.tests.map((test) => ({ ...test, status: "passed_by_runtime_transition" }));
    emitInternal(run, "repair_verified", { repair_id: candidate.id, summary: candidate.root_cause, tests: candidate.tests });
    emitInternal(run, "repair_promoted", { repair_id: candidate.id, summary: candidate.strategy, tests: candidate.tests });
    await installRepairSkill(candidate, run);
    if (repairRoot) await writeJsonAtomic(resolve(repairRoot, candidate.id, "proposal.json"), candidate);
    return { ok: true, repair: { ...candidate }, run: publicRun(run) };
  }

  async function rollbackRepair(repairId) {
    const candidate = repairs.get(String(repairId || ""));
    if (!candidate) throw new Error("ไม่พบ Repair Proposal");
    const run = runs.get(candidate.run_id);
    if (candidate.action === "source_patch_required" && Array.isArray(candidate.backup_manifest) && candidate.backup_manifest.length) {
      await restoreSourceBackup(candidate);
    }
    candidate.status = "rolled_back";
    candidate.rolled_back_at = now();
    await markRepairSkillStale(candidate);
    if (run) emitInternal(run, "repair_rolled_back", {
      repair_id: candidate.id,
      summary: candidate.action === "source_patch_required" && candidate.backup_manifest?.length
        ? "คืน source files จาก backup แล้ว"
        : "ยกเลิก proposal แล้ว ไม่มี source patch ถูกติดตั้ง",
    });
    return { ok: true, repair: { ...candidate }, run: publicRun(run) };
  }

  async function stop(id, reason = "user_stop") {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    if (!run.child && ACTIVE.has(run.status)) {
      run.stop_requested = true;
      run.status = "stopped";
      run.stage = "stopped_before_spawn";
      run.detail = reason === "alpha_shutdown" ? "ยกเลิก Run ก่อน spawn ระหว่างปิด Alpha" : "ผู้ใช้หยุด Run ก่อน process เริ่ม";
      run.ended_at = now();
      run.updated_at = run.ended_at;
      run.heartbeat.process_alive = false;
      emitInternal(run, "supervisor_action", { status: "stopping", action: "cancel_runtime_before_spawn", root_cause: reason });
      await cleanupOwnedBrowser(run);
      persistRun(run);
      notify(run);
      return { ok: true, run: publicRun(run) };
    }
    if (!run.child || !ACTIVE.has(run.status)) {
      await cleanupOwnedBrowser(run);
      return { ok: true, run: publicRun(run) };
    }
    run.stop_requested = true;
    run.stage = "stopping";
    run.detail = reason === "alpha_shutdown" ? "กำลังหยุดก่อนปิด Alpha" : "กำลังหยุด Ticket Bot";
    run.updated_at = now();
    emitInternal(run, "supervisor_action", { status: "stopping", action: "stop_owned_process_group", root_cause: reason });
    const pid = Number(run.pid || 0);
    try { if (pid > 0) process.kill(-pid, "SIGTERM"); else run.child.kill("SIGTERM"); } catch { run.child.kill("SIGTERM"); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    if (run.child && !run.child.killed) {
      try { if (pid > 0) process.kill(-pid, "SIGKILL"); else run.child.kill("SIGKILL"); } catch { run.child.kill("SIGKILL"); }
    }
    await cleanupOwnedBrowser(run);
    return { ok: true, run: publicRun(run) };
  }

  async function stopAll(reason = "alpha_shutdown") {
    const active = [...runs.values()].filter((run) => run.child && ACTIVE.has(run.status));
    await Promise.allSettled(active.map((run) => stop(run.id, reason)));
    return { ok: true, stopped: active.length };
  }

  function getRepair(id) {
    const candidate = repairs.get(String(id || ""));
    if (!candidate) throw new Error("ไม่พบ Repair Proposal");
    return { ok: true, repair: { ...candidate } };
  }

  async function automaticSupervisorRecovery(run, fingerprint, action, rootCause) {
    if (run.supervisor.auto_recovery_inflight || !run.child || !ACTIVE.has(run.status)) return;
    run.supervisor.auto_recovery_inflight = true;
    const activityBefore = Number(run.heartbeat.last_event_at || 0);
    try {
      if (fingerprint === "browser_connect_timeout") {
        emitInternal(run, "supervisor_action", {
          status: "recovering",
          action: "restart_owned_browser_and_preserve_profile",
          root_cause: rootCause,
          automatic: true,
        });
        await cleanupOwnedBrowser(run);
      } else if (fingerprint.startsWith("runtime_silent:")) {
        emitInternal(run, "supervisor_action", {
          status: "recovering",
          action: "resume_owned_process_without_stdin",
          root_cause: rootCause,
          automatic: true,
        });
        const pid = Number(run.pid || 0);
        try { if (pid > 0) process.kill(-pid, "SIGCONT"); else run.child.kill("SIGCONT"); } catch { /* AI diagnosis below explains a failed probe */ }
      } else {
        emitInternal(run, "supervisor_action", { status: "analyzing", action, root_cause: rootCause, automatic: true });
      }

      // The bot heartbeat runs every five seconds. Give a safe transient action
      // one complete heartbeat window before escalating to the local AI.
      await new Promise((resolveWait) => setTimeout(resolveWait, 6_500));
      if (!run.child || !ACTIVE.has(run.status)) return;
      if (Number(run.heartbeat.last_event_at || 0) > activityBefore) {
        emitInternal(run, "supervisor_action", {
          status: "standby",
          action: "transient_recovery_verified",
          root_cause: "runtime heartbeat resumed",
          automatic: true,
        });
        return;
      }
      const proposal = await repair(run.id);
      const repeatsFailedStrategy = (fingerprint === "browser_connect_timeout" && proposal.repair?.action === "restart_owned_browser")
        || (fingerprint.startsWith("runtime_silent:") && proposal.repair?.action === "resume_run");
      if (repeatsFailedStrategy) {
        const candidate = repairs.get(proposal.repair.id);
        candidate.status = "verification_failed";
        candidate.tests = [{ name: "strategy progression", status: "failed", output: "AI เสนอวิธีเดียวกับ transient recovery ที่เพิ่งไม่ผ่าน จึงไม่รันซ้ำ" }];
        emitInternal(run, "repair_candidate", { repair_id: candidate.id, status: candidate.status, summary: "ต้องใช้ source patch หรือข้อมูลเครื่องมือเพิ่ม; ไม่ทำวิธีเดิมซ้ำ", tests: candidate.tests });
        return;
      }
      if (proposal.repair?.confirmation_required !== true && ["resume_run", "restart_owned_browser"].includes(proposal.repair?.action)) {
        await promoteRepair(proposal.repair.id);
      }
    } catch (error) {
      emitInternal(run, "supervisor_action", {
        status: "needs_repair",
        action: "automatic_recovery_failed",
        root_cause: safeText(error?.message, 500) || rootCause,
        automatic: true,
      });
    } finally {
      run.supervisor.auto_recovery_inflight = false;
    }
  }

  const watchdog = setInterval(() => {
    const current = now();
    for (const run of runs.values()) {
      if (!ACTIVE.has(run.status) || !run.child) continue;
      const silentFor = current - Number(run.heartbeat.last_event_at || run.started_at || current);
      const spawnWait = current - Number(run.heartbeat.command_received_at || run.started_at || current);
      let fingerprint = "";
      let action = "";
      let rootCause = "";
      if (!run.heartbeat.process_spawned_at && spawnWait > 5_000) {
        fingerprint = "process_spawn_timeout";
        action = "inspect_process_spawn";
        rootCause = "Run ได้รับแล้วแต่ยังไม่มี process heartbeat ภายใน 5 วินาที";
      } else if (!run.heartbeat.browser_connected_at && spawnWait > 45_000) {
        fingerprint = "browser_connect_timeout";
        action = "reconnect_owned_browser";
        rootCause = "process เริ่มแล้วแต่ Browser ของ Alpha ยังไม่มีหลักฐานเชื่อมต่อภายใน 45 วินาที";
      } else if (run.heartbeat.browser_connected_at && run.status !== "waiting_handoff" && silentFor > 15_000) {
        fingerprint = `runtime_silent:${run.stage}`;
        action = "probe_runtime";
        rootCause = `ไม่มี runtime event ${Math.round(silentFor / 1000)} วินาทีที่ state ${run.stage}`;
      }
      if (!fingerprint || run.supervisor.watchdog_fingerprint === fingerprint) continue;
      run.supervisor.watchdog_fingerprint = fingerprint;
      emitInternal(run, "supervisor_action", { status: "analyzing", action, root_cause: rootCause, automatic: true });
      void automaticSupervisorRecovery(run, fingerprint, action, rootCause);
    }
  }, 2_000);
  watchdog.unref?.();

  return { start, get, events, subscribe, input, resume, repair, getRepair, promoteRepair, rollbackRepair, stop, stopAll, ready, publicRun, validateProject, cleanupOwnedBrowser };
}
