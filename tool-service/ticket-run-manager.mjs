import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve, sep } from "node:path";

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

  if (kind === "runtime") {
    run.status = "runtime_running";
    run.stage = safeText(event.stage, 120) || "starting_browser";
    run.detail = safeText(event.detail, 500) || "Browser runtime เริ่มทำงานแล้ว";
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

export function createTicketRunManager({ programCreateDir, ticketBrowserProfileDir = "", shellPath = "/bin/zsh", logLimit = MAX_LOG_LINES, requiredGeneratorVersion = "" } = {}) {
  if (!programCreateDir) throw new Error("programCreateDir is required");
  const runs = new Map();

  async function cleanupOwnedBrowser(run = null) {
    if (!ticketBrowserProfileDir) {
      if (run) run.browser_cleanup = "not_configured";
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
        run.updated_at = now();
      }
      return pids;
    } catch (error) {
      if (run) {
        run.browser_cleanup = "failed";
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
        if (event && typeof event === "object" && !Array.isArray(event)) mapEvent(run, event);
      } catch { /* plain stdout is still useful as a redacted log */ }
    }
    run.updated_at = now();
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

  async function start(input = {}) {
    const projectPath = await validateProject(input.project_path);
    const activeRun = [...runs.values()].find((run) => ACTIVE.has(run.status));
    if (activeRun?.project_path === projectPath) return { ok: true, reused: true, run: publicRun(activeRun) };
    if (activeRun) throw new Error("มี Ticket Bot อีกงานกำลังใช้ browser session อยู่ กรุณาหยุดหรือทำงานเดิมให้จบก่อนเริ่มโปรเจกต์ใหม่");
    await cleanupOwnedBrowser();

    const username = safeText(input.username, 500);
    const password = typeof input.password === "string" ? input.password : "";
    const inspectOnly = input.inspect_only === true;
    delete input.username;
    delete input.password;
    const secrets = [username, password].filter(Boolean);
    const id = randomUUID();
    const script = resolve(projectPath, "start.command");
    const args = [script, "--wait-for-window", ...(inspectOnly ? ["--inspect-only"] : ["--confirm-order"])];
    const child = spawn(shellPath, args, {
      cwd: projectPath,
      detached: true,
      env: {
        ...process.env,
        ...(username ? { TICKET_USERNAME: username } : {}),
        ...(password ? { TICKET_PASSWORD: password } : {}),
        ...(ticketBrowserProfileDir ? { ALPHA_TICKET_BROWSER_PROFILE: resolve(ticketBrowserProfileDir) } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const started = now();
    const run = {
      id,
      project_path: projectPath,
      pid: child.pid || null,
      status: "starting_runtime",
      stage: "starting_runtime",
      detail: inspectOnly ? "กำลังเริ่ม Ticket Bot แบบ inspect-only" : "กำลังเริ่ม Ticket Bot process จริง",
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
      stop_requested: false,
      child,
    };
    runs.set(id, run);
    attachLineReader(run, "stdout", child.stdout, secrets);
    attachLineReader(run, "stderr", child.stderr, secrets);
    child.once("spawn", () => {
      if (run.status === "starting_runtime") {
        run.status = "runtime_running";
        run.stage = "process_started";
        run.detail = `เริ่ม process ${basename(script)} แล้ว`;
        run.updated_at = now();
      }
    });
    child.once("error", (error) => {
      run.status = "failed";
      run.stage = "spawn_failed";
      run.detail = redactLine(error?.message || "เริ่ม process ไม่สำเร็จ", secrets);
      run.ended_at = now();
      run.updated_at = run.ended_at;
    });
    child.once("close", (code) => {
      run.exit_code = code ?? 1;
      run.ended_at = now();
      run.updated_at = run.ended_at;
      run.handoff = null;
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
      void cleanupOwnedBrowser(run);
    });
    return { ok: true, reused: false, run: publicRun(run) };
  }

  function get(id) {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    return { ok: true, run: publicRun(run) };
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

  async function stop(id, reason = "user_stop") {
    const run = runs.get(String(id || ""));
    if (!run) throw new Error("ไม่พบ Ticket Run");
    if (!run.child || !ACTIVE.has(run.status)) {
      await cleanupOwnedBrowser(run);
      return { ok: true, run: publicRun(run) };
    }
    run.stop_requested = true;
    run.stage = "stopping";
    run.detail = reason === "alpha_shutdown" ? "กำลังหยุดก่อนปิด Alpha" : "กำลังหยุด Ticket Bot";
    run.updated_at = now();
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

  return { start, get, input, stop, stopAll, publicRun, validateProject, cleanupOwnedBrowser };
}
