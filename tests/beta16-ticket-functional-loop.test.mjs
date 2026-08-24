import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateTicketPreflight, extractTicketPageFacts, parseThaiDateTime } from "../lib/ticket-workflow.js";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Thai Buddhist event dates are normalized without substituting build time", () => {
  assert.equal(parseThaiDateTime("วันเสาร์ที่ 29 สิงหาคม 2569, 10:00 น.").iso, "2026-08-29T10:00:00+07:00");
  assert.equal(parseThaiDateTime("วันเสาร์ที่ 31 ตุลาคม 2569").iso, "2026-10-31T00:00:00+07:00");
});

test("public KITA-style page yields an evidence-backed pre-sale state", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/example.html",
    title: "Official Ticket | Concert",
    body_text: `
      วันที่แสดง
      วันเสาร์ที่ 31 ตุลาคม 2569
      สถานที่แสดง
      SiamPic Hall ชั้น 7
      วันเปิดจำหน่าย
      วันเสาร์ที่ 29 สิงหาคม 2569, 10:00 น.
      ราคาบัตร
      4,500 / 3,900 / 3,200 / 2,500 / 1,800 / 1,200 บาท
      เงื่อนไขงานอื่น: ปิดขายแล้ว
      Ticket Status
      COMING SOON
    `,
    controls: [{ id: "search_box", label: "ค้นหา", semantic_role: "event", selector: "#search_box" }],
  });
  assert.equal(facts.sale_open_at, "2026-08-29T10:00:00+07:00");
  assert.equal(facts.show_dates[0].iso, "2026-10-31T00:00:00+07:00");
  assert.equal(facts.sale_status, "upcoming");
  assert.deepEqual(facts.prices, [4500, 3900, 3200, 2500, 1800, 1200]);
  assert.equal(facts.purchase_controls.length, 0);
  const preflight = evaluateTicketPreflight(facts);
  assert.equal(preflight.public_page_verified, true);
  assert.equal(preflight.workflow_state, "pre_sale");
  assert.equal(preflight.purchase_controls_ready, false);
  assert.equal(preflight.can_build, true);
});

test("sale opening within 30 minutes is armed but a later sale stays pre-sale", () => {
  const common = {
    event_url: "https://tickets.test/event",
    show_dates: [{ raw: "วันพรุ่งนี้", iso: "2026-08-25T19:00:00+07:00" }],
    sale_status: "upcoming",
    evidence: [{ field: "show_date" }, { field: "sale_status" }],
    purchase_controls: [],
    sale_entry_controls: [],
  };
  const imminent = evaluateTicketPreflight({ ...common, sale_open_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  const later = evaluateTicketPreflight({ ...common, sale_open_at: new Date(Date.now() + 45 * 60 * 1000).toISOString() });
  assert.equal(imminent.workflow_state, "armed_pre_sale");
  assert.equal(imminent.sale_opens_within_30_minutes, true);
  assert.equal(later.workflow_state, "pre_sale");
});

test("an on-sale performance-time link is a verified sale entry", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/on-sale.html",
    title: "On-sale concert",
    body_text: `วันที่แสดง\n24 ตุลาคม 2569\nวันเปิดจำหน่าย\n25 สิงหาคม 2569, 12:00 น.\nTicket Status\nON SALE NOW`,
    controls: [{ label: "19:00", semantic_role: "schedule", selector: "", context_text: "เมืองไทยรัชดาลัย เธียเตอร์ 19:00" }],
  });
  assert.equal(facts.performance_options[0].label, "19:00");
  assert.equal(facts.sale_status, "open");
  assert.equal(evaluateTicketPreflight(facts).workflow_state, "sale_entry");
});

test("purchase history is never treated as an event purchase control", () => {
  const facts = extractTicketPageFacts({
    url: "https://tickets.test/event",
    title: "Event",
    body_text: `วันที่แสดง\n24 ตุลาคม 2569\nวันเปิดจำหน่าย\n24 สิงหาคม 2569\nTicket Status\nON SALE NOW`,
    controls: [{ label: "ประวัติการสั่งซื้อ", semantic_role: "purchase_action", selector: "a[href='/history']" }],
  });
  assert.equal(facts.sale_entry_controls.length, 0);
});

test("generated project verifies queue, outage, multiple tickets, and never fakes checkout", async () => {
  const template = await source("templates/concert-ticket-assistant.py");
  assert.match(template, /queueOpenAt/);
  assert.match(template, /queue_fixture_verified/);
  assert.match(template, /waiting_room_entry/);
  assert.match(template, /Join waiting room/);
  assert.match(template, /"page_refresh": False/);
  assert.match(template, /queue_position_verified/);
  assert.match(template, /server_unavailable/);
  assert.match(template, /TICKET_QUANTITY_NOT_COMPLETE/);
  assert.match(template, /choose_seat_indices/);
  assert.match(template, /seatGrouping/);
  assert.match(template, /test_adjacent_seats_require_consecutive_numbers/);
  assert.match(template, /test_same_zone_can_be_non_adjacent/);
  assert.match(template, /verified_payment_handoff/);
  assert.match(template, /armed_pre_sale/);
  assert.match(template, /server_date/);
  assert.match(template, /mouse_control.*False/);
  assert.match(template, /resume_supported.*True/);
  assert.match(template, /mkdtemp\(prefix="alpha-ticket-verification-"\)/);
  assert.match(template, /shutil\.copytree\(project, destination_project\)/);
  assert.match(template, /live_queue_observed["']:\s*False/);
  assert.doesNotMatch(template, /print\(["']CHECKOUT_READY/);
  assert.doesNotMatch(template, /button\[type=submit\]/);
});

test("Ticket Studio exposes explicit multi-seat grouping preferences", async () => {
  const page = await source("app/page.tsx");
  const route = await source("app/api/ticket-bot/route.ts");
  assert.match(page, /การจัดที่นั่งหลายใบ/);
  assert.match(page, /ต้องติดกันในโซนเดียว/);
  assert.match(page, /ใบไหนก็ได้ในโซนเดียวกัน/);
  assert.match(page, /seat_grouping: ticketSeatGrouping/);
  assert.match(page, /event\.target\.value\.toUpperCase\(\)/);
  assert.match(page, /ไม่ยึดเมาส์/);
  assert.match(route, /seatGrouping/);
  assert.match(route, /"adjacent", "same_zone", "any"/);
});

test("Ticket Bot API re-inspects live facts and requires fixture verification", async () => {
  const route = await source("app/api/ticket-bot/route.ts");
  assert.match(route, /const liveInspection = await inspectPage\(selected\.url, settings, "form"\)/);
  assert.match(route, /functionalPreflight\.public_page_verified !== true/);
  assert.match(route, /fixture_tests_passed/);
  assert.match(route, /queue_fixture_verified/);
  assert.match(route, /live_queue_observed: false/);
  assert.match(route, /"state_machine\.py"/);
  assert.match(route, /"tests\/test_state_machine\.py"/);
  assert.doesNotMatch(route, /selected\.sale_open_at \|\| new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(route, /ตามรอบที่เลือกในเว็บไซต์/);
});

test("tool service returns page facts and functional preflight with form inspection", async () => {
  const service = await source("tool-service/server.mjs");
  assert.match(service, /extractTicketPageFacts/);
  assert.match(service, /evaluateTicketPreflight/);
  assert.match(service, /facts,/);
  assert.match(service, /functional_preflight/);
  assert.match(service, /a\[href\]/);
  assert.match(service, /context_text/);
});

test("launcher waits for the real web health endpoint before reporting ready", async () => {
  const launcher = await source("start-alpha-v11.command");
  assert.match(launcher, /WEB_READY=false/);
  assert.match(launcher, /http:\/\/localhost:3000\/api\/health/);
  assert.match(launcher, /"app_version":"1\.1\.0-beta\.17"/);
  assert.match(launcher, /หน้าเว็บ Alpha เปิดไม่สำเร็จ/);
});
