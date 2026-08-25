import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta21-ticket-runtime-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function writeAtomic(path, content) {
  const temp = `${path}.beta21.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, path);
}

async function patchServer() {
  const path = resolve(appDir, "tool-service", "server.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source = replaceOnce(
    source,
    'import { evaluateTicketPreflight, extractTicketPageFacts } from "../lib/ticket-workflow.js";',
    'import { evaluateTicketPreflight, extractTicketPageFacts } from "../lib/ticket-workflow.js";\nimport { createTicketRunManager } from "./ticket-run-manager.mjs"; // ' + marker,
    "ticket workflow import",
  );
  source = replaceOnce(
    source,
    "let autoLearnLoopPromise = null;",
    "let autoLearnLoopPromise = null;\nconst ticketRunManager = createTicketRunManager({ programCreateDir });",
    "runtime manager initialization",
  );
  source = replaceOnce(
    source,
    '    if (!await refreshStorageState() && url.pathname !== "/v1/shutdown") return json(response, 503, { error: storageError, storage_connected: false });\n',
    '    if (!await refreshStorageState() && url.pathname !== "/v1/shutdown") return json(response, 503, { error: storageError, storage_connected: false });\n'
      + '    if (url.pathname === "/v1/ticket-runs" && request.method === "POST") return json(response, 200, await ticketRunManager.start(await readJson(request, 64 * 1024)));\n'
      + '    const ticketRunMatch = url.pathname.match(/^\\/v1\\/ticket-runs\\/([^/]+)(?:\\/(input|stop))?$/);\n'
      + '    if (ticketRunMatch && request.method === "GET" && !ticketRunMatch[2]) return json(response, 200, ticketRunManager.get(decodeURIComponent(ticketRunMatch[1])));\n'
      + '    if (ticketRunMatch && request.method === "POST" && ticketRunMatch[2] === "input") { const body = await readJson(request, 16 * 1024); return json(response, 200, await ticketRunManager.input(decodeURIComponent(ticketRunMatch[1]), String(body.value ?? ""))); }\n'
      + '    if (ticketRunMatch && request.method === "POST" && ticketRunMatch[2] === "stop") return json(response, 200, await ticketRunManager.stop(decodeURIComponent(ticketRunMatch[1])));\n',
    "ticket run endpoints insertion",
  );
  source = replaceOnce(
    source,
    '    if (url.pathname === "/v1/shutdown" && request.method === "POST") {\n      if (autoLearnJob?.status === "running") {',
    '    if (url.pathname === "/v1/shutdown" && request.method === "POST") {\n      await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n      if (autoLearnJob?.status === "running") {',
    "shutdown ticket cleanup",
  );
  source = replaceOnce(
    source,
    '  process.on(signal, async () => {\n    if (autoLearnJob?.status === "running") await stopAutoLearn().catch(() => {});',
    '  process.on(signal, async () => {\n    await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n    if (autoLearnJob?.status === "running") await stopAutoLearn().catch(() => {});',
    "signal ticket cleanup",
  );
  await writeAtomic(path, source);
}

async function patchToolClient() {
  const path = resolve(appDir, "lib", "tool-client.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source += `\n// ${marker}\nexport interface TicketRunView extends Record<string, unknown> {\n  id: string;\n  project_path: string;\n  pid?: number | null;\n  status: string;\n  stage: string;\n  detail?: string;\n  logs?: Array<{ at: number; stream: string; text: string }>;\n  handoff?: { field?: string; prompt?: string; options?: string[]; secret?: boolean } | null;\n}\n\nexport async function startTicketRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {\n  const response = await toolFetch("/v1/ticket-runs", { method: "POST", body: JSON.stringify(input) }, 15_000);\n  return payload(response);\n}\n\nexport async function getTicketRun(id: string): Promise<Record<string, unknown>> {\n  const response = await toolFetch(\`/v1/ticket-runs/\${encodeURIComponent(id)}\`, { method: "GET", headers: headers(false) }, 5_000);\n  return payload(response);\n}\n\nexport async function sendTicketRunInput(id: string, value = ""): Promise<Record<string, unknown>> {\n  const response = await toolFetch(\`/v1/ticket-runs/\${encodeURIComponent(id)}/input\`, { method: "POST", body: JSON.stringify({ value }) }, 5_000);\n  return payload(response);\n}\n\nexport async function stopTicketRun(id: string): Promise<Record<string, unknown>> {\n  const response = await toolFetch(\`/v1/ticket-runs/\${encodeURIComponent(id)}/stop\`, { method: "POST", body: "{}" }, 10_000);\n  return payload(response);\n}\n`;
  await writeAtomic(path, source);
}

async function patchTicketRoute() {
  const path = resolve(appDir, "app", "api", "ticket-bot", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source = replaceOnce(
    source,
    'import { executeTool, ToolExecutionResult } from "@/lib/tool-client";',
    'import { executeTool, getTicketRun, sendTicketRunInput, startTicketRun, stopTicketRun, ToolExecutionResult } from "@/lib/tool-client"; // ' + marker,
    "ticket tool imports",
  );
  source = replaceOnce(
    source,
    'type TicketAction = "inspect" | "inspect_form" | "build";',
    'type TicketAction = "inspect" | "inspect_form" | "build" | "run" | "run_status" | "run_input" | "run_stop";',
    "ticket action union",
  );
  source = replaceOnce(
    source,
    '    const body = await request.json() as { action?: unknown; url?: unknown; input?: TicketBuildInput; discover_api?: unknown };',
    '    const body = await request.json() as { action?: unknown; url?: unknown; input?: TicketBuildInput; discover_api?: unknown; run_id?: unknown; project_path?: unknown; username?: unknown; password?: unknown; value?: unknown; inspect_only?: unknown };',
    "ticket request body",
  );
  source = replaceOnce(
    source,
    '    const settings = await getSettings();\n\n    if (action === "inspect") {',
    `    const settings = await getSettings();\n\n    // ${marker}\n    if (action === "run") {\n      const projectPath = asText(body.project_path, 2_000);\n      if (!projectPath) throw new Error("ไม่พบ project_path สำหรับเริ่ม Ticket Bot");\n      const result = await startTicketRun({\n        project_path: projectPath,\n        username: asText(body.username, 500),\n        password: typeof body.password === "string" ? body.password : "",\n        inspect_only: body.inspect_only === true,\n      });\n      return Response.json(result);\n    }\n    if (action === "run_status") {\n      const runId = asText(body.run_id, 200);\n      if (!runId) throw new Error("ไม่พบ run_id");\n      return Response.json(await getTicketRun(runId));\n    }\n    if (action === "run_input") {\n      const runId = asText(body.run_id, 200);\n      if (!runId) throw new Error("ไม่พบ run_id");\n      return Response.json(await sendTicketRunInput(runId, typeof body.value === "string" ? body.value : ""));\n    }\n    if (action === "run_stop") {\n      const runId = asText(body.run_id, 200);\n      if (!runId) throw new Error("ไม่พบ run_id");\n      return Response.json(await stopTicketRun(runId));\n    }\n\n    if (action === "inspect") {`,
    "runtime API actions",
  );
  await writeAtomic(path, source);
}

async function patchTemplate() {
  const path = resolve(appDir, "templates", "concert-ticket-assistant.py");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source = source.replace(
    '    if not username:\n        username = input("อีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตรนี้: ").strip()\n    if not password:\n        password = getpass.getpass("รหัสผ่าน (ไม่แสดงและไม่บันทึก): ")',
    '    if not username:\n        record("input_required", {"field": "username", "stage": "waiting_username", "prompt": "กรอกอีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตร", "secret": False})\n        username = input("อีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตรนี้: ").strip()\n    if not password:\n        record("input_required", {"field": "password", "stage": "waiting_password", "prompt": "กรอกรหัสผ่านสำหรับเว็บขายบัตร", "secret": True})\n        password = getpass.getpass("รหัสผ่าน (ไม่แสดงและไม่บันทึก): ")',
  );
  source = source.replace(
    '        answer = input("เลือกโซนก่อนให้บอททำต่อ (เช่น A หรือ A1; หลายโซนคั่นด้วย comma): ").strip().upper()',
    '        record("input_required", {"field": "zone", "stage": "waiting_zone", "options": discovered_names, "prompt": "เลือกโซนก่อนให้บอททำต่อ", "secret": False})\n        answer = input("เลือกโซนก่อนให้บอททำต่อ (เช่น A หรือ A1; หลายโซนคั่นด้วย comma): ").strip().upper()',
  );
  source = source.replace(
    '            value = input(f"หน้าเว็บคอนนี้ต้องการข้อมูล \'{prompt_label}\': ").strip()',
    '            record("input_required", {"field": "event_specific", "stage": "waiting_event_field", "prompt": f"หน้าเว็บคอนนี้ต้องการข้อมูล {prompt_label}", "secret": False})\n            value = input(f"หน้าเว็บคอนนี้ต้องการข้อมูล \'{prompt_label}\': ").strip()',
  );
  source = source.replace(
    '                record("handoff", {"status": state.upper(), "resume_supported": True, "same_session": True})\n                input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")',
    '                record("handoff", {"status": state.upper(), "resume_supported": True, "same_session": True})\n                record("input_required", {"field": "captcha" if state == "captcha_handoff" else "otp", "stage": "waiting_captcha" if state == "captcha_handoff" else "waiting_otp", "prompt": "รับช่วงใน Chrome แล้วกดทำต่อ", "secret": False})\n                input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")',
  );
  source = source.replace(
    '                    input("เลือกบัตรให้ครบใน Chrome แล้วกลับมากด Enter เพื่อให้บอททำต่อ: ")',
    '                    record("input_required", {"field": "ticket_selection", "stage": "waiting_ticket_selection", "prompt": "เลือกบัตรให้ครบใน Chrome แล้วกดทำต่อ", "secret": False})\n                    input("เลือกบัตรให้ครบใน Chrome แล้วกลับมากด Enter เพื่อให้บอททำต่อ: ")',
  );
  source = source.replace(
    '                    input("ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกลับมากด Enter: ")',
    '                    record("input_required", {"field": "continue", "stage": "waiting_manual_continue", "prompt": "ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกดทำต่อ", "secret": False})\n                    input("ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกลับมากด Enter: ")',
  );
  source = source.replace(
    '                    input("เลือกวิธีรับบัตร/QR แล้ว ระบบหยุดก่อนสร้างคำสั่งซื้อ กด Enter เพื่อปิด หรือรันใหม่ด้วย --confirm-order: ")',
    '                    record("input_required", {"field": "checkout_options", "stage": "waiting_checkout_options", "prompt": "เลือกวิธีรับบัตร/QR ใน Chrome แล้วกดทำต่อ", "secret": False})\n                    input("เลือกวิธีรับบัตร/QR แล้ว ระบบหยุดก่อนสร้างคำสั่งซื้อ กด Enter เพื่อปิด หรือรันใหม่ด้วย --confirm-order: ")',
  );
  source = source.replace(
    '                record("result", {"status": "PAYMENT_HANDOFF", "login_verified": True, "live_checkout_verified": verified_payment_handoff(checkpoint), "payment_not_submitted": True, "payment_evidence_count": checkpoint.get("payment_evidence_count")})\n                input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")',
    '                record("result", {"status": "PAYMENT_HANDOFF", "login_verified": True, "live_checkout_verified": verified_payment_handoff(checkpoint), "payment_not_submitted": True, "payment_evidence_count": checkpoint.get("payment_evidence_count")})\n                record("input_required", {"field": "payment", "stage": "payment_handoff", "prompt": "ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย", "secret": False})\n                input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")',
  );
  source = source.replace(
    '        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})\n        input("หลักฐานยังไม่พอ ระบบหยุดไว้ให้ตรวจใน Chrome กด Enter เพื่อปิด: ")',
    '        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})\n        record("input_required", {"field": "review", "stage": "waiting_review", "prompt": "หลักฐานยังไม่พอ ตรวจใน Chrome แล้วกดทำต่อเพื่อปิด", "secret": False})\n        input("หลักฐานยังไม่พอ ระบบหยุดไว้ให้ตรวจใน Chrome กด Enter เพื่อปิด: ")',
  );
  source += `\n# ${marker}\n`;
  await writeAtomic(path, source);
}

async function patchPage() {
  const path = resolve(appDir, "app", "page.tsx");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source = replaceOnce(
    source,
    "const TOPICS = [",
    `interface TicketRunView {\n  id: string;\n  project_path: string;\n  pid?: number | null;\n  status: "starting_runtime" | "runtime_running" | "waiting_handoff" | "completed" | "failed" | "stopped";\n  stage: string;\n  detail?: string;\n  started_at?: number;\n  updated_at?: number;\n  ended_at?: number | null;\n  exit_code?: number | null;\n  latest_url?: string;\n  full_loop_verified?: boolean;\n  payment_handoff_verified?: boolean;\n  handoff?: { field?: string; prompt?: string; options?: string[]; secret?: boolean } | null;\n  logs?: Array<{ at: number; stream: string; text: string }>;\n}\n\nconst TOPICS = [`,
    "TicketRunView interface",
  );
  source = replaceOnce(
    source,
    '  const [ticketBuildReport, setTicketBuildReport] = useState<TicketBuildReport | null>(null);',
    `  const [ticketBuildReport, setTicketBuildReport] = useState<TicketBuildReport | null>(null);\n  const [ticketRun, setTicketRun] = useState<TicketRunView | null>(null); // ${marker}\n  const [ticketUsername, setTicketUsername] = useState("");\n  const [ticketPassword, setTicketPassword] = useState("");\n  const [ticketRunInput, setTicketRunInput] = useState("");`,
    "ticket runtime state",
  );
  source = replaceOnce(
    source,
    "  const loadChat = useCallback(async (id: string) => {",
    `  useEffect(() => {\n    if (!ticketRun?.id || !["starting_runtime", "runtime_running", "waiting_handoff"].includes(ticketRun.status)) return;\n    let stopped = false;\n    const poll = async () => {\n      try {\n        const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_status", run_id: ticketRun.id }), cache: "no-store" });\n        const data = await response.json() as { run?: TicketRunView; error?: string };\n        if (response.ok && data.run && !stopped) {\n          setTicketRun(data.run);\n          setTicketStatus(data.run.detail || \`Ticket Bot: \${data.run.stage}\`);\n        }\n      } catch { /* next poll retries */ }\n    };\n    void poll();\n    const timer = window.setInterval(() => void poll(), 1_000);\n    return () => { stopped = true; window.clearInterval(timer); };\n  }, [ticketRun?.id, ticketRun?.status]);\n\n  const loadChat = useCallback(async (id: string) => {`,
    "ticket runtime polling",
  );
  source = replaceOnce(
    source,
    "  async function buildTicketBot(event: FormEvent) {",
    `  async function startTicketRuntime(projectPath: string) {\n    if (!projectPath) throw new Error("ไม่พบ project path สำหรับเริ่มบอท");\n    setTicketStatus("กำลังเริ่ม process ของ Ticket Bot จริง…");\n    const response = await fetch("/api/ticket-bot", {\n      method: "POST", headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ action: "run", project_path: projectPath, username: ticketUsername, password: ticketPassword }),\n    });\n    const data = await response.json() as { run?: TicketRunView; error?: string };\n    setTicketPassword("");\n    if (!response.ok || !data.run) throw new Error(data.error || "เริ่ม Ticket Bot process ไม่สำเร็จ");\n    setTicketRun(data.run);\n    setTicketRunInput("");\n    setTicketStatus(data.run.detail || "Ticket Bot process เริ่มทำงานแล้ว");\n    return data.run;\n  }\n\n  async function sendTicketRuntimeInput() {\n    if (!ticketRun?.id) return;\n    const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_input", run_id: ticketRun.id, value: ticketRunInput }) });\n    const data = await response.json() as { run?: TicketRunView; error?: string };\n    setTicketRunInput("");\n    if (!response.ok || !data.run) { setTicketStatus(data.error || "ส่งข้อมูลให้ Ticket Bot ไม่สำเร็จ"); return; }\n    setTicketRun(data.run);\n    setTicketStatus(data.run.detail || "ส่งข้อมูลแล้ว กำลังทำต่อ");\n  }\n\n  async function stopTicketRuntime() {\n    if (!ticketRun?.id) return;\n    const response = await fetch("/api/ticket-bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_stop", run_id: ticketRun.id }) });\n    const data = await response.json() as { run?: TicketRunView; error?: string };\n    if (!response.ok || !data.run) { setTicketStatus(data.error || "หยุด Ticket Bot ไม่สำเร็จ"); return; }\n    setTicketRun(data.run);\n    setTicketStatus("ส่งคำสั่งหยุด Ticket Bot แล้ว");\n  }\n\n  async function buildTicketBot(event: FormEvent) {`,
    "ticket runtime UI functions",
  );
  source = replaceOnce(
    source,
    '    if (!selected || ticketStage === "building") return;\n',
    '    if (!selected || ticketStage === "building") return;\n    if (ticketBuildReport?.project_path && !ticketRunActive) {\n      setTicketStage("building");\n      try { await startTicketRuntime(ticketBuildReport.project_path); setTicketStage("ready"); }\n      catch (error) { setTicketStage("error"); setTicketStatus(error instanceof Error ? error.message : "เริ่มบอทจริงไม่สำเร็จ"); }\n      return;\n    }\n',
    "reuse existing ticket project",
  );
  source = replaceOnce(
    source,
    '      setTicketBuildReport(data);\n      setTicketStage("ready");\n      setTicketStatus(`สร้างโปรเจกต์ ${data.created_files?.length ?? 0} ไฟล์ · fixture ${data.verification?.fixture_tests_passed ? "ผ่าน" : "ไม่ผ่าน"} · คิวจริง ${data.verification?.live_queue_observed ? "พบและตรวจแล้ว" : "ยังไม่ได้พบ"}`);',
    '      setTicketBuildReport(data);\n      setTicketStage("ready");\n      setTicketStatus(`สร้างโปรเจกต์ ${data.created_files?.length ?? 0} ไฟล์และ fixture ผ่านแล้ว · กำลังเริ่ม runtime จริง`);\n      await startTicketRuntime(data.project_path);',
    "auto start after build",
  );
  source = replaceOnce(
    source,
    '  const effectiveTicketProjectName = ticketProjectName.trim() || generatedTicketProjectName;',
    '  const effectiveTicketProjectName = ticketProjectName.trim() || generatedTicketProjectName;\n  const ticketRunActive = Boolean(ticketRun && ["starting_runtime", "runtime_running", "waiting_handoff"].includes(ticketRun.status));',
    "ticket run active computed state",
  );
  source = source.replace(
    '<div className="ticket-loop-steps"><span className={ticketEvents.length ? "done" : ""}>1 ตรวจงาน</span><span className={ticketInspection ? "done" : ""}>2 อ่านฟอร์ม</span><span className={ticketBuildReport?.ok ? "done" : ""}>3 สร้างโปรเจกต์</span></div>',
    '<div className="ticket-loop-steps"><span className={ticketEvents.length ? "done" : ""}>1 ตรวจงาน</span><span className={ticketInspection ? "done" : ""}>2 อ่านฟอร์ม</span><span className={ticketBuildReport?.ok ? "done" : ""}>3 สร้างโปรเจกต์</span><span className={ticketRunActive ? "done" : ""}>4 รันจริง</span></div>',
  );
  source = source.replace(
    '<div className="ticket-form-heading"><span>02</span><div><strong>ข้อมูลสำหรับกรอกฟอร์ม</strong><small>ถามเฉพาะฟิลด์ที่งานนั้นบังคับ; password รับจาก secure prompt และไม่บันทึก</small></div></div>',
    '<div className="ticket-form-heading"><span>02</span><div><strong>ข้อมูลสำหรับกรอกฟอร์ม</strong><small>ชื่อคนไม่ใช่โซน/เลขที่นั่ง; password ใช้เฉพาะตอน run และไม่บันทึก</small></div></div>',
  );
  source = source.replace(
    '<label className="field"><span>ชื่อผู้ซื้อ (ถ้าหน้าจริงถาม)</span><input value={ticketCustomerName} onChange={(event) => setTicketCustomerName(event.target.value)} placeholder="เว้นว่างให้บอทถามตอนพบฟิลด์" /></label>',
    '<label className="field"><span>ชื่อผู้ซื้อ (ชื่อ-นามสกุลบุคคล)</span><input value={ticketCustomerName} onChange={(event) => setTicketCustomerName(event.target.value)} placeholder="ไม่ใช่โซนหรือเลขที่นั่ง; เว้นว่างได้" /><small>กรอกชื่อบุคคลจริงเฉพาะเมื่อหน้าเว็บถาม</small></label>',
  );
  source = source.replace(
    '<label className="field ticket-field-wide"><span>ชื่อผู้เข้าชมแต่ละใบ (หนึ่งบรรทัดต่อคน)</span><textarea value={ticketAttendeeNames} onChange={(event) => setTicketAttendeeNames(event.target.value)} placeholder="กรอกเมื่อคอนนั้นพิมพ์ชื่อบนบัตร; เว้นว่างให้ถามเฉพาะตอนพบฟิลด์" /></label>',
    '<label className="field ticket-field-wide"><span>ชื่อผู้เข้าชมแต่ละใบ (หนึ่งคนต่อบรรทัด)</span><textarea value={ticketAttendeeNames} onChange={(event) => setTicketAttendeeNames(event.target.value)} placeholder="ชื่อบุคคลเท่านั้น — ใช้เมื่อคอนบังคับพิมพ์ชื่อบนบัตร" /><small>โซน/แถว/เลขที่นั่งให้กรอกในส่วนเลือกบัตรด้านบน</small></label>',
  );
  source = replaceOnce(
    source,
    '                    <section className="ticket-handoff-note"><strong>ทำงานเบื้องหลังโดยไม่ยึดเมาส์</strong>',
    `                    <section className="ticket-form-section">\n                      <div className="ticket-form-heading"><span>04</span><div><strong>Login สำหรับ run จริง</strong><small>ส่งเข้า process แบบ ephemeral เท่านั้น ไม่เขียน config/localStorage/database</small></div></div>\n                      <div className="ticket-form-grid">\n                        <label className="field"><span>Email / username</span><input autoComplete="username" value={ticketUsername} onChange={(event) => setTicketUsername(event.target.value)} placeholder="เว้นว่างได้ถ้ามี session อยู่แล้ว" /></label>\n                        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={ticketPassword} onChange={(event) => setTicketPassword(event.target.value)} placeholder="ใช้เฉพาะตอนเริ่ม run" /></label>\n                      </div>\n                    </section>\n\n                    <section className="ticket-handoff-note"><strong>ทำงานเบื้องหลังโดยไม่ยึดเมาส์</strong>`,
    "ticket login fields",
  );
  source = source.replace(
    '<div><span>✓</span><div><strong>สร้าง state machine และผ่านชุดทดสอบภายใน</strong><p>{ticketBuildReport.project_path}</p></div></div>',
    '<div><span>✓</span><div><strong>สร้างโปรเจกต์และ fixture ผ่าน — ยังไม่ถือว่า Full Loop ผ่านจนมี runtime evidence</strong><p>{ticketBuildReport.project_path}</p></div></div>',
  );
  source = source.replace(
    '<small>โครงสร้าง: {ticketBuildReport.verification?.structure_passed ? "ผ่าน" : "ไม่ผ่าน"} · State fixtures: {ticketBuildReport.verification?.fixture_tests_passed ? "ผ่าน" : "ไม่ผ่าน"} · คิวจริง: {ticketBuildReport.verification?.live_queue_observed ? "พบแล้ว" : "ยังไม่พบ"} · Checkout จริง: {ticketBuildReport.verification?.live_checkout_verified ? "ยืนยันแล้ว" : "รอรันโปรเจกต์"} · รันด้วย run-full-loop.command</small>',
    '<small>โครงสร้าง: {ticketBuildReport.verification?.structure_passed ? "ผ่าน" : "ไม่ผ่าน"} · Fixture: {ticketBuildReport.verification?.fixture_tests_passed ? "ผ่าน" : "ไม่ผ่าน"} · Runtime: {ticketRun ? ticketRun.stage : "ยังไม่เริ่ม"} · PAYMENT_HANDOFF: {ticketRun?.payment_handoff_verified ? "ยืนยันแล้ว" : "ยังไม่ยืนยัน"}</small>',
  );
  source = replaceOnce(
    source,
    '                    <div className="ticket-build-actions"><span className="ticket-build-hint">จำเป็น: เลือกคอนเสิร์ต + จำนวนบัตร · งบและการตรวจรายละเอียดไม่บังคับ</span><button type="button" className="secondary-action" onClick={() => void inspectSelectedTicketEvent()} disabled={ticketStage === "form_inspecting"}>ตรวจเพิ่ม</button><button className="save-button" type="submit" disabled={!["open", "upcoming"].includes(ticketEvents.find((event) => event.id === ticketSelectedId)?.sale_status || "unknown") || ticketStage === "building"}>{ticketStage === "building" ? "กำลังสร้างและทดสอบ…" : ticketInspection?.functional_preflight?.runtime_discovery_required || !ticketInspection ? "สร้างบอท — ค้นข้อมูลจริงตอนรัน" : "สร้างและทดสอบบอท"}</button></div>',
    `                    {ticketRun && <section className="ticket-result-card">\n                      <div><span>{ticketRun.status === "failed" ? "!" : ticketRun.status === "stopped" ? "■" : "▶"}</span><div><strong>Live Ticket Run · {ticketRun.status}</strong><p>Run {ticketRun.id} · PID {ticketRun.pid || "—"} · Stage {ticketRun.stage}</p></div></div>\n                      <small>{ticketRun.detail || "กำลังรอ event จาก process"}{ticketRun.latest_url ? \` · \${ticketRun.latest_url}\` : ""}</small>\n                      {ticketRun.logs?.length ? <pre>{ticketRun.logs.slice(-8).map((item) => item.text).join("\\n")}</pre> : null}\n                      {ticketRun.status === "waiting_handoff" && <div className="confirm-row">\n                        <span>{ticketRun.handoff?.prompt || "ต้องให้ผู้ใช้รับช่วง"}</span>\n                        {!["captcha", "otp", "payment", "continue", "ticket_selection", "checkout_options", "review"].includes(ticketRun.handoff?.field || "") && <input type={ticketRun.handoff?.secret ? "password" : "text"} value={ticketRunInput} onChange={(event) => setTicketRunInput(event.target.value)} placeholder={ticketRun.handoff?.options?.join(", ") || "กรอกข้อมูลที่บอทรอ"} />}\n                        <button type="button" onClick={() => void sendTicketRuntimeInput()}>ทำต่อ</button>\n                      </div>}\n                      {ticketRunActive && <button type="button" className="secondary-action" onClick={() => void stopTicketRuntime()}>หยุดบอท</button>}\n                    </section>}\n\n                    <div className="ticket-build-actions"><span className="ticket-build-hint">Fixture ผ่านไม่เท่ากับ runtime ผ่าน · ระบบจะเริ่ม process จริงและแสดง run id</span><button type="button" className="secondary-action" onClick={() => void inspectSelectedTicketEvent()} disabled={ticketStage === "form_inspecting" || ticketRunActive}>ตรวจเพิ่ม</button><button className="save-button" type="submit" disabled={!["open", "upcoming"].includes(ticketEvents.find((event) => event.id === ticketSelectedId)?.sale_status || "unknown") || ticketStage === "building" || ticketRunActive}>{ticketRunActive ? "บอทกำลังทำงาน" : ticketStage === "building" ? "กำลังเริ่ม…" : ticketBuildReport?.project_path ? "เริ่มบอทจริง" : "สร้างและเริ่มบอท"}</button></div>`,
    "ticket live run card and action",
  );
  await writeAtomic(path, source);
}

async function patchPackageAndChangelog() {
  const packagePath = resolve(appDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  pkg.version = "1.1.0-beta.21";
  await writeAtomic(packagePath, JSON.stringify(pkg, null, 2) + "\n");

  const changelogPath = resolve(appDir, "CHANGELOG.md");
  let changelog = await fs.readFile(changelogPath, "utf8");
  if (!changelog.includes("## 1.1.0-beta.21")) {
    const entry = `# Alpha changelog\n\n## 1.1.0-beta.21 — 2026-08-25\n\n- Added a real Ticket Run Manager: build success can start the generated Ticket Bot process instead of stopping at fixture verification.\n- Added local-only start/status/input/stop runtime endpoints with Program_Create realpath validation, symlink protection, single-active-run reuse, bounded redacted logs, and owned process-group cleanup.\n- Ticket Bot Studio now accepts ephemeral login credentials, starts the real runtime after build, polls live run status every second, surfaces CAPTCHA/OTP/manual input handoffs, and can stop the owned run.\n- Generated bots emit structured input_required JSONL before blocking on stdin so the UI can explain exactly what the process is waiting for.\n- Fixture success is no longer presented as Full Loop success; PAYMENT_HANDOFF requires runtime evidence.\n\n`;
    changelog = changelog.replace(/^# Alpha changelog\n\n/, entry);
    await writeAtomic(changelogPath, changelog);
  }
}

await patchServer();
await patchToolClient();
await patchTicketRoute();
await patchTemplate();
await patchPage();
await patchPackageAndChangelog();
console.log("Applied Alpha beta21 Ticket Bot runtime: real process start/status/input/stop + live UI");
