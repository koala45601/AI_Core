import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("beta23 classifier requires visible controls and keeps pre-sale runtime alive", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  assert.match(template, /def _actionable_text\(snapshot\):/);
  assert.match(template, /def visible_actionable_controls\(page\):/);
  assert.match(template, /def visible_seat_control_count\(page\):/);
  assert.match(template, /SEAT_SELECTOR = "\.seatuncheck,/);
  assert.match(template, /seat\.get_attribute\("data-seat-number"\)/);
  assert.match(template, /parsed = re\.search/);
  assert.match(template, /frame for frame in page\.frames if frame != page\.main_frame/);
  assert.match(template, /def fast_reserved_seat_recovery\(page\):/);
  assert.match(template, /def click_candidate_set\(locators, metadata, indices\):/);
  assert.match(template, /def authenticated_booking_session\(page, state\):/);
  assert.match(template, /account_marker_or_private_booking_step/);
  assert.match(template, /if frame != page\.main_frame:[\s\S]*?if not owner\.is_visible\(timeout=200\):[\s\S]*?continue/);
  assert.match(template, /def ticket_browser_pid\(browser_profile\):/);
  assert.match(template, /def surface_browser_window\(page, browser_profile, stage\):/);
  assert.match(template, /NSRunningApplication\(processIdentifier: pid\)/);
  assert.match(template, /AXUIElementCreateApplication\(pid\)/);
  assert.match(template, /AXUIElementPerformAction\(window, kAXRaiseAction/);
  assert.match(template, /"window_raised": window_raised/);
  assert.doesNotMatch(template, /launch_persistent_context\([\s\S]{0,300}channel="chrome"/);
  assert.match(template, /\.app\/Contents\/MacOS\/Google Chrome/);
  assert.match(template, /PLAYWRIGHT_BROWSERS_PATH=.*\/Volumes\/petong\/Disk\/AI\/models\/playwright-browsers/);
  assert.match(template, /def launch_ticket_browser\(runtime, browser_profile\):/);
  assert.match(template, /runtime\.chromium\.connect_over_cdp\(endpoint\)/);
  assert.match(template, /"transport": "cdp_attached_normal_chrome"/);
  assert.doesNotMatch(template, /runtime\.chromium\.launch_persistent_context\(/);
  assert.match(template, /def wait_for_post_login_transition\(page, previous_url, timeout_ms=12000\):/);
  assert.match(template, /"status": "POST_LOGIN_SETTLED" if transitioned else "POST_LOGIN_TIMEOUT"/);
  assert.match(template, /"status": "POST_LOGIN_REDIRECT_COMPLETED"/);
  assert.match(template, /terms_accepted_under_run_authorization/);
  assert.match(template, /surface_browser_window\(page, browser_profile, handoff_stage\)/);
  assert.match(template, /def page_after_ticket_navigation\(current_page, pages_before\):/);
  assert.match(template, /FOLLOWED_NEW_BOOKING_PAGE/);
  assert.match(template, /page = activated_page/);
  assert.match(template, /surface_browser_window\(page, browser_profile, "waiting_access_denied"\)/);
  assert.match(template, /"field": "access_denied"/);
  assert.match(template, /test_captcha_before_waiting_room_wins_over_queue_control/);
  assert.match(template, /test_captcha_inside_active_queue_wins_over_queue_marker/);
  assert.match(template, /test_captcha_after_queue_transition_wins_over_challenge_http_status/);
  assert.match(template, /visible and enabled waiting-room control/);
  assert.match(template, /visible sale entry on an on-sale page/);
  assert.match(template, /waiting_for_visible_queue_or_sale_control/);
  assert.match(template, /PRE_SALE_SCHEDULED/);
  assert.match(template, /target_remaining > 30 \* 60/);
  assert.match(template, /SOLD_OUT_BY_SERVER/);
  assert.match(template, /capture_status_evidence/);
  assert.match(template, /WAITING_ROOM_CONTROL_CHANGED/);
  assert.doesNotMatch(template, /status last updated\|waiting room\|อยู่ในคิว/);
  assert.doesNotMatch(template, /elif re\.search\(r"select seat\|seat map\|available seat\|เลือกที่นั่ง\|จำนวนบัตร", text\)/);
});

test("generated Ticket Bot rejects instructional queue text but accepts a visible Join control", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-beta22-ticket-"));
  const output = join(temp, "output");
  const programs = join(temp, "Program_Create");
  const payload = {
    event_candidates: [{ id: "fixture-event", name: "Fixture Concert", url: "https://tickets.test/event", sale_status: "upcoming" }],
    selected_event_id: "fixture-event",
    event_url: "https://tickets.test/event",
    schedule: "2026-08-26T19:00:00+07:00",
    sale_open_at: "2026-08-25T10:00:00+07:00",
    queue_open_at: "2026-08-25T09:00:00+07:00",
    event_facts: { sale_status: "upcoming", sale_open_at: "2026-08-25T10:00:00+07:00", evidence: ["fixture"] },
    functional_preflight: { public_page_verified: true, runtime_discovery_required: false },
    quantity: 2,
    seat_mode: "general_admission",
    seat_grouping: "same_zone",
    seat_fallback_mode: "zone_any",
    delivery_method: "pickup",
    payment_method: "qr",
    project_name: "beta22-fixture",
  };
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(payload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    assert.equal(result.status, "project_verified");
    assert.ok(result.fixture_verification.fixture_test_count >= 32);

    const project = result.created_project_path;
    const generatedBot = await readFile(join(project, "bot.py"), "utf8");
    const stateMachine = await readFile(join(project, "state_machine.py"), "utf8");
    const generatedTests = await readFile(join(project, "tests", "test_state_machine.py"), "utf8");
    assert.match(generatedBot, /^import pathlib$/m);
    assert.match(stateMachine, /actionable_text/);
    assert.match(generatedTests, /test_waiting_room_instructions_without_visible_control_are_not_entry/);
    assert.match(generatedTests, /test_generic_waiting_room_copy_is_not_an_active_queue/);

    const verified = await run("python3", [join(project, "tests", "test_state_machine.py")], { cwd: project });
    assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("beta23 patcher stamps version and is idempotent", async () => {
  const patcher = await readFile(new URL("../scripts/apply-beta22-ticket-visible-evidence.mjs", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../start-alpha-v11.command", import.meta.url), "utf8");
  assert.match(patcher, /1\.1\.0-beta\.23/);
  assert.match(patcher, /skills-index\.json/);
  assert.match(patcher, /updateInstalledTicketSkill/);
  assert.match(patcher, /concert-ticket-purchase-assistant/);
  assert.match(launcher, /apply-beta22-ticket-visible-evidence\.mjs/);
  assert.match(launcher, /app_version\":\"1\.1\.0-beta\.24/);
});

test("beta24 coalesces repeated UI actions, inspects detail on demand and rejects stale projects", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/ticket-bot/route.ts", import.meta.url), "utf8");
  const manager = await readFile(new URL("../tool-service/ticket-run-manager.mjs", import.meta.url), "utf8");
  const server = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");

  assert.match(page, /ticketInspectPendingRef\.current/);
  assert.match(page, /ticketRunPendingRef\.current/);
  assert.match(page, /generator_version === "1\.1\.0-beta\.26"/);
  assert.match(page, /กรุณาเลือกวันและเวลาก่อนเข้าคิว/);
  assert.match(page, /ระบบแยกวันเดียวหลายเวลาเป็นคนละรอบ/);
  assert.match(page, /normalizedTicketPerformanceOptions/);
  assert.match(page, /product_name/);
  assert.match(page, /disabled=\{\["sold_out", "closed"\]/);
  assert.match(page, /ใช้วันแสดงที่ตรวจไว้ในรอบล่าสุดทันที/);
  assert.match(route, /inspectionFlights/);
  assert.match(route, /saveTicketScheduleCache/);
  assert.match(route, /canonicalTicketEventUrl/);
  assert.doesNotMatch(route, /action: "reset_public_inspection"/);
  assert.match(route, /safePerformanceOptions/);
  assert.match(route, /selected_performance/);
  assert.match(route, /alpha-beta24-access-denied-v1/);
  assert.match(route, /inspectionBlocked\(opened\)/);
  assert.match(route, /let inspectionUrl = publicInspectionFallback\(url, mode\) \|\| url/);
  assert.match(route, /ใช้หน้ารวม official สำรองเพื่อหลีกเลี่ยง Access Denied/);
  assert.match(route, /inspectPublicDetailText/);
  assert.match(route, /inspection_transport: "direct_web_read"/);
  assert.match(route, /actually needs interactive controls/);
  assert.match(route, /inspected\.inspection_transport === "browser"/);
  assert.match(route, /Detail pages are loaded only after the user selects one/);
  assert.match(route, /fresh_page: false, public_inspection: true/);
  assert.doesNotMatch(route, /fresh_page: true, public_inspection: true/);
  assert.doesNotMatch(route, /setTimeout\(resolve, 900\)/);
  assert.match(route, /stage: "runtime_discovery_required"/);
  assert.match(manager, /requiredGeneratorVersion/);
  assert.match(server, /requiredGeneratorVersion: "1\.1\.0-beta\.26"/);
  assert.match(server, /ensurePublicInspectionBrowser[\s\S]*?headless: false/);
  assert.match(server, /public-inspection-profile/);
  assert.match(server, /action === "observe_existing"/);
  assert.match(server, /ignoreDefaultArgs: \["--no-sandbox", "--enable-automation"\]/);
  assert.match(server, /await page\.close\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(server, /access_blocked: true/);
  assert.match(manager, /ALPHA_TICKET_BROWSER_PROFILE/);
  assert.match(manager, /evidence_paths/);
  assert.match(template, /"generatorVersion": "1\.1\.0-beta\.26"/);
  assert.match(template, /"generator_version": "1\.1\.0-beta\.26"/);
  assert.match(template, /activate_selected_performance/);
  assert.match(template, /same_queue_session/);
  assert.match(template, /ALPHA_TICKET_BROWSER_PROFILE/);
  assert.match(template, /bot_source = r'''[\s\S]*?import pathlib[\s\S]*?ALPHA_TICKET_BROWSER_PROFILE/);
  assert.match(template, /connect_over_cdp\(endpoint\)/);
  assert.match(template, /--remote-debugging-address=127\.0\.0\.1/);
});

test("schedule cache is versioned so beta22 rows cannot override beta23 product status", async () => {
  const source = await readFile(new URL("../lib/ticket-event-cache.ts", import.meta.url), "utf8");
  assert.match(source, /CACHE_SCHEMA_VERSION = 2/);
  assert.match(source, /schema_version = \?/);
});

test("selecting an event performs one detail inspection in the persistent session and persists its schedule", async () => {
  const api = await readFile(new URL("../app/api/ticket-bot/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(api, /inspected = await inspectPage\(url, settings, "form"\)/);
  assert.doesNotMatch(api, /inspectPage\(url, settings, "form", true\)/);
  assert.match(api, /source_url: sourceUrl/);
  assert.match(ui, /void inspectSelectedTicketEvent\(event\)/);
  assert.match(ui, /source_url: ticketSourceUrl/);
});

test("Ticket Studio never labels fixture-only evidence as a passed Full Loop", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /สถานะการตรวจและรันจริง/);
  assert.match(page, /Fixture เท่านั้น/);
  assert.match(page, /ผ่านเฉพาะโครงสร้างและ fixture — ยังไม่ใช่ผลซื้อบัตรจริง/);
  assert.match(page, /ticketRun\?\.full_loop_verified \? "Full Loop ผ่าน"/);
  assert.doesNotMatch(page, /<strong>สถานะ Full Loop<\/strong>/);
});
