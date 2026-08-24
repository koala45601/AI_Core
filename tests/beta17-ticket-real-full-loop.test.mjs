import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Ticket state machine distinguishes every observed ThaiTicketMajor stage", async () => {
  const template = await source("templates/concert-ticket-assistant.py");
  const orderedMarkers = [
    "close-sale",
    "payment_kbankqr.php",
    "paymentall.php",
    "enroll.php",
    "verify_condition.php",
    "signin.php",
    "festival.php",
    "zones.php",
  ];
  for (const marker of orderedMarkers) assert.match(template, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(template, /payment_evidence_count/);
  assert.match(template, /verified QR payment page/);
  assert.match(template, /select_image_map_zone/);
  assert.match(template, /confirm_unpaid_order/);
  assert.match(template, /semantic_select_if_present/);
  assert.match(template, /event_specific_option_absent/);
  assert.match(template, /หน้าเว็บคอนนี้ต้องการข้อมูล/);
  assert.match(template, /--confirm-order/);
  assert.match(template, /TICKET_USERNAME/);
  assert.match(template, /TICKET_PASSWORD/);
  assert.doesNotMatch(template, /"password"\s*:\s*password/);
});

test("Generated project passes real-flow regression fixtures and contains a Full Loop launcher", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta17-ticket-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "programs");
  const input = {
    event_url: "https://www.thaiticketmajor.com/concert/test.html",
    event_candidates: [{ id: "show-927", name: "Fixture Concert", url: "https://www.thaiticketmajor.com/concert/test.html", sale_status: "open" }],
    selected_event_id: "show-927",
    selected_event_name: "Fixture Concert",
    schedule: "2026-11-12T20:00:00+07:00",
    sale_open_at: "2026-08-25T10:00:00+07:00",
    seat_mode: "standing",
    seat_grouping: "same_zone",
    preferred_zones: ["B"],
    quantity: 1,
    attendee_names: ["TEST USER"],
    delivery_method: "pickup",
    ticket_protect: false,
    payment_method: "qr",
    functional_preflight: { public_page_verified: true },
    event_facts: { sale_status: "open", show_dates: [{ iso: "2026-11-12T20:00:00+07:00" }] },
    project_name: "beta17-full-loop-fixture",
  };
  try {
    const { stdout } = await execFileAsync("python3", [new URL("templates/concert-ticket-assistant.py", root).pathname, JSON.stringify(input)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.status, "project_verified");
    assert.equal(result.fixture_verification.fixture_tests_passed, true);
    assert.ok(result.fixture_verification.fixture_test_count >= 25);
    assert.ok(result.created_files.includes("run-full-loop.command"));
    const stateMachine = await readFile(join(result.created_project_path, "state_machine.py"), "utf8");
    assert.match(stateMachine, /terms_conditions/);
    assert.match(stateMachine, /checkout_options/);
    assert.match(stateMachine, /payment_evidence_count/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Ticket Studio passes event-specific fields and exposes the executable Full Loop result", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/ticket-bot/route.ts")]);
  assert.match(page, /ชื่อผู้เข้าชมแต่ละใบ/);
  assert.match(page, /delivery_method: ticketDelivery/);
  assert.match(page, /ticket_protect: ticketProtect/);
  assert.match(page, /run-full-loop\.command/);
  assert.match(page, /Login อัตโนมัติจาก session\/secure prompt/);
  assert.match(route, /attendee_names/);
  assert.match(route, /delivery_method/);
  assert.match(route, /run-full-loop\.command/);
});
