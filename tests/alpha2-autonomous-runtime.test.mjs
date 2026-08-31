import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createTicketRunManager } from "../tool-service/ticket-run-manager.mjs";

const CURRENT_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error("timeout waiting for Alpha 2.0 runtime state");
}

async function project(root, script) {
  const path = join(root, "alpha2-fixture");
  await mkdir(path, { recursive: true });
  await Promise.all([
    writeFile(join(path, "start.command"), script, "utf8"),
    writeFile(join(path, "run-full-loop.command"), "#!/bin/bash\nexit 0\n", "utf8"),
    writeFile(join(path, "bot.py"), "print('fixture')\n", "utf8"),
    writeFile(join(path, "config.json"), JSON.stringify({ generatorVersion: CURRENT_VERSION }), "utf8"),
  ]);
  return path;
}

async function command(commandName, args, cwd) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectCommand);
    child.once("close", (code) => code === 0 ? resolveCommand(output) : rejectCommand(new Error(output || `${commandName} exited ${code}`)));
  });
}

test("Alpha 2.0 generator contains official availability, navigation interruption and conflict TTL recovery", async () => {
  const [template, server, supervisor, launcher, manager, client, page, pkg, alphaModel] = await Promise.all([
    readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8"),
    readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tool-service/supervisor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../start-alpha.command", import.meta.url), "utf8"),
    readFile(new URL("../tool-service/ticket-run-manager.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/tool-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../models/Alpha-9B.Modelfile", import.meta.url), "utf8"),
  ]);
  assert.match(pkg.version, /^2\.0\.0-alpha\.\d+$/);
  assert.match(template, /collect_zone_availability/);
  assert.match(template, /ที่นั่งว่าง\|จำนวนที่นั่งว่าง/);
  assert.match(template, /LATEST_ZONE_AVAILABILITY_RESPONSE/);
  assert.match(template, /wait_for_manual_idle/);
  assert.match(template, /quiet_deadline = time\.monotonic\(\) \+ idle_ms \/ 1000/);
  assert.match(template, /page = context\.pages\[-1\][\s\S]{0,220}bind_navigation_observer\(page\)[\s\S]{0,160}start_runtime_heartbeat\(page\)/);
  assert.match(template, /RUNTIME_HEARTBEAT_CACHE/);
  assert.match(template, /update_runtime_heartbeat_cache\(page\)/);
  assert.doesNotMatch(template, /def heartbeat_loop\(\):[\s\S]{0,700}navigation_marker\(current_page\)/);
  assert.match(template, /def ensure_locked_performance_on_booking_page\(page\):/);
  assert.match(template, /LOCKED_PERFORMANCE_RESELECTED/);
  assert.match(template, /ALPHA_TICKET_RUNTIME_VENV/);
  assert.match(template, /"terminal": "state_changed"/);
  assert.match(template, /blacklist_conflicted_seats/);
  assert.match(template, /SEAT_CONFLICT_GENERATION/);
  assert.match(template, /SEAT_CONFLICT_GENERATION\.get\(conflict_key\) == current_generation/);
  assert.match(template, /deadline = time\.monotonic\(\) \+ max\(100, int\(timeout_ms\)\) \/ 1000/);
  assert.match(template, /def wait_for_stable_seat_inventory\(page, fallback_zone="", timeout_ms=12000\):/);
  assert.match(template, /def wait_for_seat_dom_quiet\(page, quiet_ms=250, timeout_ms=2500\):/);
  assert.match(template, /STABLE_INVENTORY_READY/);
  assert.match(template, /WAITING_FOR_STABLE_INVENTORY/);
  assert.match(template, /STABLE_INVENTORY_TIMEOUT/);
  assert.match(template, /seatMapReadyTimeoutMs/);
  assert.match(template, /evaluate_all\("""elements => elements\.slice\(0, 1000\)\.filter/);
  assert.match(template, /metadata, locators, scopes = collect_seat_inventory\(page, fallback_zone\)/);
  assert.match(template, /ready_marker_key != marker_key/);
  assert.match(template, /SEAT_MAP_NOT_READY_RESCAN/);
  assert.match(template, /def accepted_reservation_responses_since\(started_at\):/);
  assert.match(template, /payload\.get\("result"\) is True and status_ok/);
  assert.match(template, /SERVER_ACCEPTED_EXACT_SET/);
  assert.match(template, /duplicate_click_prevented/);
  assert.match(template, /AWAITING_CHECKOUT_TRANSITION/);
  assert.match(template, /server accepted the exact seat set and advanced to a private checkout state/);
  assert.match(template, /RESERVATION_RESPONSE_HISTORY\.append/);
  assert.match(template, /wait_for_function\([\s\S]{0,180}arg=state_field/);
  assert.match(template, /arg=previous_url/);
  assert.match(template, /arg=\{"selector": SELECTED_SEAT_SELECTOR, "wanted": wanted\}/);
  assert.doesNotMatch(template, /phase": "seat_conflict"[\s\S]{0,260}schedule_ai_runtime_analysis/);
  assert.match(template, /def visible_runtime_dialogs\(page\):/);
  assert.match(template, /def dismiss_runtime_dialog\(page\):/);
  assert.match(template, /LIVE_SEAT_FAILURE_ESCALATION/);
  assert.match(template, /official_availability_descending/);
  assert.match(template, /AI_ANALYSIS_QUEUED_NON_BLOCKING/);
  assert.match(template, /"seat_incident": True/);
  assert.match(template, /checkpoint\.get\("state"\) == "ticket_selection" and not bool\(\(context or \{\}\)\.get\("seat_incident"\)\)/);
  assert.doesNotMatch(template, /LIVE_SEAT_FAILURE_ESCALATION[\s\S]{0,1800}decision = request_ai_recovery_action/);
  assert.match(template, /"visual_required": True/);
  assert.match(template, /"visible_dialogs": page_snapshot\.get\("visible_dialogs", \[\]\)/);
  assert.match(template, /"last_reservation_response"/);
  assert.match(template, /response_text = response\.text\(\)/);
  assert.match(template, /"dismiss_runtime_dialog"/);
  assert.match(template, /def visible_checkout_validation\(page\):/);
  assert.match(template, /def select_verified_checkout_option\(page, selector, state_field/);
  assert.match(template, /def visible_attendee_validation\(page\):/);
  assert.match(template, /def fill_event_sensitive_input\(locator, value\):/);
  assert.match(template, /locator\.press_sequentially\(expected, delay=(?:18|max\(0, speed_setting\("inputDelayMs", 0\)\))\)/);
  assert.match(template, /SUBMIT_REJECTED/);
  assert.match(template, /#btn_regnow/);
  assert.match(template, /area\[href\*='#'\], \[data-zone\], \[data-section\][\s\S]{0,180}wait_for\(state="attached", timeout=5000\)/);
  assert.match(template, /input\[name='username'\]:visible/);
  assert.match(template, /form_deadline = time\.monotonic\(\) \+ 30/);
  assert.match(template, /LOGIN_FORM_RESCAN/);
  assert.match(template, /user_input_required": False/);
  assert.match(template, /LOGIN_SECURITY_CHALLENGE_RETRY/);
  assert.match(template, /credentials_retained": True/);
  assert.match(template, /ticket_runtime_supervisor/);
  assert.match(template, /"model": "alpha:9b"/);
  assert.match(template, /page_snapshot\.get\("body", ""\)\)\[:1600\]/);
  assert.match(template, /result\["stale"\] = stale/);
  assert.match(template, /pending\["future"\]\.cancel\(\)/);
  assert.match(template, /"format": response_schema/);
  assert.match(template, /action_match = re\.search/);
  assert.match(template, /progressive_actions = \[action for action in allowed_actions/);
  assert.match(template, /def execute_ready_ai_supervisor_action/);
  assert.match(template, /AI_ACTION_EXECUTED/);
  assert.match(template, /model_controlled": True/);
  assert.match(template, /DELIVERY_STATE_EMPTY_BEFORE_CONFIRM/);
  assert.match(template, /CONFIRM_REJECTED/);
  assert.match(template, /#btn_pickup/);
  assert.match(template, /#btn_kbankqr/);
  assert.match(template, /"sourcePatchPromotion": "confirm"/);
  assert.match(server, /\/v2\/ticket-runs/);
  assert.match(server, /ticketRunEventStream/);
  assert.match(server, /repairV2Match/);
  assert.match(server, /tool_supervisor/);
  assert.match(supervisor, /ALPHA_TOOL_SUPERVISED: "1"/);
  assert.match(supervisor, /Tool Service heartbeat/);
  assert.match(launcher, /tool-service\/supervisor\.mjs/);
  assert.match(launcher, /"tool_supervisor":\{"supervised":true/);
  assert.match(manager, /automaticSupervisorRecovery/);
  assert.match(manager, /verifySourceRepair/);
  assert.match(manager, /promoteVerifiedSourceRepair/);
  assert.match(manager, /restoreSourceBackup/);
  assert.match(manager, /installRepairSkill/);
  assert.match(manager, /repair_skill_installed/);
  assert.doesNotMatch(manager, /run\.detail = safeText\(event\.detail, 500\)[^\n]*\n\s*run\.heartbeat\.browser_connected_at/);
  assert.match(manager, /if \(event\.browser_connected === true\) \{[\s\S]{0,180}browser_connected_at \|\|= now\(\);/);
  assert.match(manager, /keep_alive:\s*-1/);
  assert.match(manager, /readMacKeychainPassword/);
  assert.match(manager, /credential_source/);
  assert.match(manager, /PYTHONUNBUFFERED: "1"/);
  assert.match(manager, /spawnWait > 45_000/);
  assert.match(manager, /run\.heartbeat\.browser_connected_at && run\.status !== "waiting_handoff"/);
  assert.doesNotMatch(manager, /keep_alive:\s*["']5m["']/);
  assert.match(manager, /think:\s*false/);
  assert.match(manager, /setTimeout\(\(\) => controller\.abort\(\), 45_000\)/);
  assert.match(manager, /num_predict:\s*384/);
  assert.match(client, /ticketRunEventsResponse/);
  assert.match(page, /AI Supervisor/);
  assert.match(page, /Repair Proposal/);
  assert.match(page, /เริ่ม Run ใหม่/);
  assert.match(page, /retainTicketPerformanceSelection/);
  assert.match(page, /options\.find\(\(option\) => ticketPerformanceValue\(option\) === current\)/);
  assert.match(page, /setTicketSchedule\(\(current\) => retainTicketPerformanceSelection/);
  assert.match(page, /macOS Keychain/);
  assert.match(alphaModel, /FROM qwen3\.5:9b/);
  assert.match(alphaModel, /You are Alpha, a local autonomous AI agent/);
  assert.match(alphaModel, /active supervisor rather than an advisor/);
  assert.match(alphaModel, /verify the observed state transition/);
  assert.match(alphaModel, /newest live DOM, visible dialogs, network result, browser frame/);
  assert.match(alphaModel, /never ask the user to attach an image/);
});

test("Alpha 2.0 uses the configured default account and Keychain resolver without exposing the secret", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha2-keychain-login-"));
  const root = join(temporary, "Program_Create");
  await mkdir(root);
  const path = await project(root, `#!/bin/bash
if [[ "$TICKET_USERNAME" != "default@example.test" || "$TICKET_PASSWORD" != "fixture-secret" ]]; then exit 42; fi
echo '{"kind":"input_required","field":"fixture","stage":"waiting_fixture","prompt":"fixture"}'
IFS= read -r done
exit 0
`);
  const manager = createTicketRunManager({
    programCreateDir: root,
    shellPath: "/bin/bash",
    requiredGeneratorVersion: CURRENT_VERSION,
    defaultTicketUsername: "default@example.test",
    credentialResolver: async ({ account }) => account === "default@example.test" ? "fixture-secret" : "",
  });
  try {
    const started = await manager.start({ project_path: path });
    assert.equal(started.run.credential_source, "keychain");
    const waiting = await waitFor(() => manager.get(started.run.id).run.status === "waiting_handoff" ? manager.get(started.run.id).run : null);
    assert.equal(waiting.credential_source, "keychain");
    assert.ok(waiting.logs.every((entry) => !entry.text.includes("fixture-secret")));
    await manager.input(started.run.id, "");
  } finally {
    await manager.stopAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Alpha 2.0 Tool Service supervisor restarts a crashed core and shuts it down cleanly", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha2-tool-supervisor-"));
  const toolServiceDir = join(temporary, "tool-service");
  const countFile = join(temporary, "launch-count.txt");
  const supervisorPath = new URL("../tool-service/supervisor.mjs", import.meta.url);
  await mkdir(toolServiceDir, { recursive: true });
  await writeFile(join(toolServiceDir, "server.mjs"), `import { promises as fs } from "node:fs";
const countPath = ${JSON.stringify(countFile)};
const count = Number(await fs.readFile(countPath, "utf8").catch(() => "0")) + 1;
await fs.writeFile(countPath, String(count), "utf8");
if (process.env.ALPHA_TOOL_SUPERVISED !== "1") process.exit(91);
if (count === 1) process.exit(0);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`, "utf8");
  const child = spawn(process.execPath, [supervisorPath.pathname, temporary], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const recovered = await waitFor(async () => {
      const count = Number(await readFile(countFile, "utf8").catch(() => "0"));
      const state = await readFile(join(temporary, "work", "tool-service-supervisor.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      return count >= 2 && state?.status === "running" && state?.restart_count >= 1 ? state : null;
    }, 8_000);
    assert.ok(recovered.child_pid);
    child.kill("SIGTERM");
    const exit = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    const stopped = JSON.parse(await readFile(join(temporary, "work", "tool-service-supervisor.json"), "utf8"));
    assert.equal(stopped.status, "stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Alpha 2.0 returns run id before project preparation and turns a terminal launch failure into restart-required recovery", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha2-immediate-run-"));
  const programs = join(temporary, "Program_Create");
  await mkdir(programs, { recursive: true });
  const manager = createTicketRunManager({
    appDir: temporary,
    programCreateDir: programs,
    requiredGeneratorVersion: CURRENT_VERSION,
    diagnoseRuntime: async () => ({
      root_cause: "generated project directory is missing",
      strategy: "restart the generated project after restoring the project path",
      action: "rerun_project",
      patch_diff: "",
      test_plan: ["project validation", "runtime heartbeat"],
    }),
  });
  try {
    const startedAt = Date.now();
    const started = await manager.start({ project_path: join(programs, "missing-project"), idempotency_key: "missing-project" });
    assert.ok(started.run.id);
    assert.equal(started.run.status, "starting_runtime");
    assert.ok(Date.now() - startedAt < 2_000, "run id must be returned before project validation/spawn finishes");
    const analyzed = await waitFor(() => {
      const run = manager.get(started.run.id).run;
      return run.repair?.status === "restart_required" ? run : null;
    });
    assert.equal(analyzed.status, "failed");
    assert.equal(analyzed.heartbeat.process_alive, false);
    assert.equal(analyzed.repair.action, "rerun_project");
    assert.match(analyzed.repair.diff_summary, /เริ่ม Run ใหม่/);
    await assert.rejects(() => manager.promoteRepair(analyzed.repair.id), /credential/);
  } finally {
    await manager.stopAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Alpha 2.0 manager exposes immediate run id, inventory/manual state, journal events and idempotency", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha2-runtime-"));
  const root = join(temporary, "Program_Create");
  const journalDir = join(temporary, "journal");
  await mkdir(root);
  const path = await project(root, `#!/bin/bash
echo '{"kind":"runtime","stage":"browser_ready"}'
echo '{"kind":"seat_availability","zones":{"B":183,"C":38,"A1":0},"inventory_generation":1,"checked_at":"2026-08-28T00:00:00+07:00"}'
echo '{"kind":"navigation_interrupt","from_state":"ticket_selection","to_state":"zone_selection","old_task_cancelled":true}'
echo '{"kind":"manual_control","active":true,"policy":"observe_then_resume"}'
echo '{"kind":"manual_control","active":false,"policy":"observe_then_resume"}'
echo '{"kind":"state_resumed","state":"zone_selection","preserved_preferences":true}'
echo '{"kind":"input_required","field":"payment","stage":"payment_handoff","prompt":"fixture hold"}'
IFS= read -r done
exit 0
`);
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash", requiredGeneratorVersion: CURRENT_VERSION, journalDir });
  try {
    const first = await manager.start({ project_path: path, idempotency_key: "alpha2-one" });
    const second = await manager.start({ project_path: path, idempotency_key: "alpha2-one" });
    assert.equal(second.run.id, first.run.id);
    const waiting = await waitFor(() => {
      const run = manager.get(first.run.id).run;
      return run.status === "waiting_handoff" ? run : null;
    });
    assert.deepEqual(waiting.seat.availability, { B: 183, C: 38, A1: 0 });
    assert.equal(waiting.seat.inventory_generation, 1);
    assert.equal(waiting.manual_control.active, false);
    assert.equal(waiting.stage, "payment_handoff");
    assert.ok(waiting.heartbeat.command_received_at);
    const history = manager.events(first.run.id, 0);
    assert.ok(history.events.some((event) => event.kind === "navigation_interrupt"));
    assert.ok(history.events.some((event) => event.kind === "state_resumed"));
    await manager.input(first.run.id, "");
    await waitFor(() => !["starting_runtime", "runtime_running", "waiting_handoff"].includes(manager.get(first.run.id).run.status));
  } finally {
    await manager.stopAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Alpha 2.0 verifies a source repair in a temporary sandbox, promotes only after verification and restores backup", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha2-source-repair-"));
  const programs = join(temporary, "Program_Create");
  const repairDir = join(temporary, "work", "repairs");
  const repairSkillsDir = join(temporary, "outputs", "Learned Skills");
  const skillsIndexFile = join(temporary, "work", "skills-index.json");
  await mkdir(join(temporary, "app"), { recursive: true });
  await mkdir(programs, { recursive: true });
  await writeFile(join(temporary, "app", "page.ts"), "export const state = 'broken';\n", "utf8");
  await command("/usr/bin/git", ["init", "-q"], temporary);
  const path = await project(programs, `#!/bin/bash
echo '{"kind":"input_required","field":"repair_fixture","stage":"waiting_repair","prompt":"fixture"}'
IFS= read -r done
exit 0
`);
  const patch = `--- a/app/page.ts
+++ b/app/page.ts
@@ -1 +1 @@
-export const state = 'broken';
+export const state = 'repaired';
`;
  const manager = createTicketRunManager({
    appDir: temporary,
    programCreateDir: programs,
    requiredGeneratorVersion: CURRENT_VERSION,
    repairDir,
    repairSkillsDir,
    skillsIndexFile,
    diagnoseRuntime: async () => ({ root_cause: "fixture bug", strategy: "patch exact source", action: "source_patch_required", patch_diff: patch, test_plan: ["fixture"] }),
    validateRepair: async () => ({ tests: { name: "fixture regression", status: "passed", output: "ok" }, build: { name: "fixture build", status: "passed", output: "ok" } }),
  });
  try {
    const started = await manager.start({ project_path: path });
    await waitFor(() => manager.get(started.run.id).run.status === "waiting_handoff");
    const proposal = await manager.repair(started.run.id);
    assert.equal(proposal.repair.status, "verified", JSON.stringify(proposal.repair.tests));
    await assert.rejects(() => readFile(join(repairDir, proposal.repair.id, "sandbox", "app", "page.ts"), "utf8"));
    const promoted = await manager.promoteRepair(proposal.repair.id);
    assert.equal(await readFile(join(temporary, "app", "page.ts"), "utf8"), "export const state = 'repaired';\n");
    assert.ok(promoted.repair.skill_id);
    const skillDirectory = join(repairSkillsDir, promoted.repair.skill_id);
    const skill = JSON.parse(await readFile(join(skillDirectory, "alpha-skill.json"), "utf8"));
    assert.equal(skill.verification_status, "verified");
    assert.equal(skill.origin, "runtime_repair");
    assert.equal(skill.repair_trigger.failure_fingerprint, proposal.repair.fingerprint);
    assert.ok(skill.generalization_confidence > 0 && skill.generalization_confidence < 100);
    assert.equal(skill.confidence_sample_size, 1);
    assert.equal(skill.hidden_test_result.total, 0);
    assert.match(await command(process.execPath, [join(skillDirectory, "main.mjs"), JSON.stringify({ failure_fingerprint: proposal.repair.fingerprint })], temporary), /"repair_action":"source_patch_required"/);
    assert.ok(JSON.parse(await readFile(skillsIndexFile, "utf8")).some((item) => item.id === skill.id));
    await manager.rollbackRepair(proposal.repair.id);
    assert.equal(await readFile(join(temporary, "app", "page.ts"), "utf8"), "export const state = 'broken';\n");
    const staleSkill = JSON.parse(await readFile(join(skillDirectory, "alpha-skill.json"), "utf8"));
    assert.equal(staleSkill.verification_status, "stale");
    assert.equal(staleSkill.enabled, false);
    await manager.input(started.run.id, "");
  } finally {
    await manager.stopAll();
    await rm(temporary, { recursive: true, force: true });
  }
});
