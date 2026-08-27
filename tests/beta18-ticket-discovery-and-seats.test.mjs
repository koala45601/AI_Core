import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { extractTicketPageFacts } from "../lib/ticket-workflow.js";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("public event inspection falls back from the blocked homepage without requiring login", async () => {
  const [route, service, page] = await Promise.all([
    source("app/api/ticket-bot/route.ts"),
    source("tool-service/server.mjs"),
    source("app/page.tsx"),
  ]);
  assert.match(route, /booking\.thaiticketmajor\.com/);
  assert.match(route, /used_public_fallback/);
  assert.match(route, /public_inspection: true/);
  assert.match(service, /access_blocked/);
  assert.match(service, /access\\s\*denied/i);
  assert.match(page, /การตรวจสอบรายการใช้หน้าสาธารณะโดยไม่ล็อกอิน/);
  assert.match(page, /โปรแกรมจริงจะต้องยืนยัน Login ก่อน Checkout/);
});

test("Ticket Studio distinguishes sale states and disables unavailable events", async () => {
  const [page, service] = await Promise.all([source("app/page.tsx"), source("tool-service/server.mjs")]);
  for (const label of ["เปิดช่วงขาย — ยังไม่ยืนยันที่นั่ง", "กำลังจะเปิดช่วงขาย", "พบป้าย SOLD OUT", "ปิดขาย", "งานจบแล้ว", "ยกเลิก", "ยังยืนยันไม่ได้"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /disabled=\{!selectable\}/);
  assert.match(service, /sale_status: closedStatus/);
  assert.match(service, /inventory_status: "not_checked"/);
  assert.match(service, /selectable: false/);
});

test("Ticket Studio requires an exact date and time when a day has multiple rounds", async () => {
  const [page, route, service] = await Promise.all([
    source("app/page.tsx"),
    source("app/api/ticket-bot/route.ts"),
    source("tool-service/server.mjs"),
  ]);
  assert.match(page, /รอบการแสดง \(วันและเวลา\)/);
  assert.match(page, /กรุณาเลือกวันและเวลาก่อนเข้าคิว/);
  assert.match(page, /ระบบแยกวันเดียวหลายเวลาเป็นคนละรอบ/);
  assert.match(route, /กรุณาเลือกวันและเวลาที่แน่นอนก่อนเริ่มบอท/);
  assert.match(service, /announced_performances:[\s\S]*flatMap\(\(row\)/);
  assert.match(service, /querySelectorAll\("a\[data-button\]/);
});

test("seat inspection exposes discovered zone and row names", () => {
  const facts = extractTicketPageFacts({
    url: "https://tickets.test/zone",
    title: "Zone fixture",
    body_text: "วันที่แสดง 30 สิงหาคม 2569 วันเปิดขาย 25 สิงหาคม 2569 Ticket Status ON SALE",
    controls: [{ semantic_role: "seat_or_zone", options: [{ text: "A1" }, { text: "A2" }] }],
    discovered_zones: ["VIP", "A1"],
    discovered_rows: ["K", "L"],
    seat_map_detected: true,
  });
  assert.deepEqual(facts.zones, ["VIP", "A1", "A2"]);
  assert.deepEqual(facts.seat_rows, ["K", "L"]);
  assert.equal(facts.seat_map_detected, true);
});

test("generated reserved-seat bot can defer zone choice and requires verified login", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta18-ticket-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "programs");
  const input = {
    event_url: "https://www.thaiticketmajor.com/concert/test.html",
    event_candidates: [{ id: "show-18", name: "Fixture Concert", url: "https://www.thaiticketmajor.com/concert/test.html", sale_status: "open", selectable: true }],
    selected_event_id: "show-18",
    selected_event_name: "Fixture Concert",
    schedule: "2026-11-12T20:00:00+07:00",
    sale_open_at: "2026-08-25T10:00:00+07:00",
    seat_mode: "reserved",
    seat_grouping: "adjacent",
    preferred_zones: [],
    preferred_rows: ["K"],
    preferred_seat_numbers: ["10"],
    seat_fallback_mode: "exact",
    quantity: 1,
    delivery_method: "pickup",
    payment_method: "qr",
    functional_preflight: { public_page_verified: true },
    event_facts: { sale_status: "open", show_dates: [{ iso: "2026-11-12T20:00:00+07:00" }] },
    project_name: "beta18-ticket-fixture",
  };
  try {
    const { stdout } = await execFileAsync("python3", [new URL("templates/concert-ticket-assistant.py", root).pathname, JSON.stringify(input)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.status, "project_verified");
    const config = JSON.parse(await readFile(join(result.created_project_path, "config.json"), "utf8"));
    const bot = await readFile(join(result.created_project_path, "bot.py"), "utf8");
    assert.deepEqual(config.preferredZones, []);
    assert.deepEqual(config.preferredRows, ["K"]);
    assert.deepEqual(config.preferredSeatNumbers, ["10"]);
    assert.equal(config.seatFallbackMode, "exact");
    assert.match(bot, /"strategy": "auto_first_available"/);
    assert.match(bot, /"reason": "NO_ZONE_PREFERENCE_USE_PAGE_ORDER"/);
    assert.match(bot, /LOGIN_REQUIRED_BEFORE_CHECKOUT/);
    assert.match(bot, /successful_form_transition/);
    assert.match(bot, /credentials_persisted.*False/);
    assert.match(bot, /def wait_for_seat_controls/);
    assert.match(bot, /frame for frame in page\.frames if frame != page\.main_frame/);
    assert.match(bot, /def fast_reserved_seat_recovery\(page\):/);
    assert.match(bot, /def click_candidate_set\(locators, metadata, indices\):/);
    assert.match(bot, /candidate_count/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
