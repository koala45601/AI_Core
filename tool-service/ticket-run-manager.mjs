import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve, sep } from "node:path";

const ACTIVE = new Set(["starting_runtime", "runtime_running", "waiting_handoff"]);
const REQUIRED_FILES = ["run-full-loop.command", "start.command", "bot.py", "config.json"];
const MAX_LOG_LINES = 350;

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
    payment_handoff_verified: run.payment_handoff_verified === true,
    result_status: run.result_status,
    result_reason: run.result_reason,
  };
}

function mapEvent(run, event) {
  const kind = safeText(event.kind, 80);
  const state = safeText(event.state, 100);
  const status = safeText(event.status, 120);
  const url = safeText(event.url, 2_000);
  if (url) run.latest_url = url;

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
      run.full_loop_verified = run.payment_handoff_verified;
      run.handoff = { field: "payment", prompt: "ถึงหน้าชำระเงินแล้ว ระบบจะไม่ชำระเงินจริง ให้ผู้ใช้ตรวจและรับช่วง", options: [], secret: false };
      run.detail = run.payment_handoff_verified ? "ยืนยันหลักฐาน PAYMENT_HANDOFF แล้ว" : "ถึง payment handoff แต่หลักฐาน checkout ยังไม่ครบ";
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
      payment_handoff_verified: false,
      result_status: "",
      result_reason: "",
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
      } else if (run.payment_handoff_verified) {
        run.status = "completed";
        run.stage = "completed_payment_handoff";
        run.detail = "process จบหลังยืนยัน PAYMENT_HANDOFF";
      } else {
        run.status = "not_verified";
        run.stage = run.result_status ? run.result_status.toLowerCase() : "ended_without_payment_handoff";
        run.detail = run.result_status
          ? `${run.result_status}${run.result_reason ? ` · ${run.result_reason}` : ""} · ยังไม่ผ่าน Full Loop`
          : "process จบโดยยังไม่มีหลักฐาน PAYMENT_HANDOFF — ไม่ถือว่าผ่าน";
      }
      run.child = null;
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
    if (!run.child || !ACTIVE.has(run.status)) return { ok: true, run: publicRun(run) };
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
    return { ok: true, run: publicRun(run) };
  }

  async function stopAll(reason = "alpha_shutdown") {
    const active = [...runs.values()].filter((run) => run.child && ACTIVE.has(run.status));
    await Promise.allSettled(active.map((run) => stop(run.id, reason)));
    return { ok: true, stopped: active.length };
  }

  return { start, get, input, stop, stopAll, publicRun, validateProject };
}
