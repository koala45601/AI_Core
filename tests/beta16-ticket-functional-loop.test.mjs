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

test("direct HTML reader text keeps KITA dates and status even when block tags were flattened", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/concert-miss-kita-by-phusit-laithong.html",
    title: "Official Ticket | คอนเสิร์ต คิดถึง KITA โดย ภูษิต ไล้ทอง",
    body_text: "เมนู คอนเสิร์ต วันที่แสดง วันเสาร์ที่ 31 ตุลาคม 2569 สถานที่แสดง SiamPic Hall ชั้น 7, สยามสแควร์วัน ประตูเปิด ก่อนการแสดง วันเปิดจำหน่าย วันเสาร์ที่ 29 สิงหาคม 2569, 10:00 น. ราคาบัตร 4,500 / 3,900 / 3,200 / 2,500 / 1,800 / 1,200 บาท Ticket Status COMING SOON แชร์",
    controls: [],
  });
  assert.equal(facts.show_dates[0].iso, "2026-10-31T00:00:00+07:00");
  assert.equal(facts.sale_open_at, "2026-08-29T10:00:00+07:00");
  assert.equal(facts.sale_status, "upcoming");
  assert.equal(facts.venue, "SiamPic Hall ชั้น 7, สยามสแควร์วัน");
  assert.deepEqual(facts.prices, [4500, 3900, 3200, 2500, 1800, 1200]);
  assert.equal(evaluateTicketPreflight(facts).workflow_state, "pre_sale");
});

test("explicit Ticket Status SOLD OUT is not collapsed into generic closed", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/gotcha-pop-3-concert.html",
    title: "Official Ticket | GOTCHA POP 3 Concert",
    body_text: "วันที่แสดง วันเสาร์ที่ 24 พฤษภาคม 2568 สถานที่แสดง Exhibition Hall 3-4 วันเปิดจำหน่าย วันเสาร์ที่ 1 มีนาคม 2568, 10:00 น. ราคาบัตร 4,000 / 3,500 / 3,000 บาท Ticket Status SOLD OUT โปรโมชั่น & ส่วนลด",
    controls: [],
  });
  assert.equal(facts.sale_status, "sold_out");
  assert.equal(facts.ticket_status, "sold_out");
  assert.equal(evaluateTicketPreflight(facts).workflow_state, "sold_out");
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
    controls: [{ label: "19:00 ซื้อบัตร", semantic_role: "schedule", selector: "[data-button='round-1']", context_text: "24 ตุลาคม 2569 19:00 ซื้อบัตร" }],
  });
  assert.equal(facts.performance_options[0].label, "19:00 ซื้อบัตร");
  assert.equal(facts.sale_status, "open");
  assert.equal(evaluateTicketPreflight(facts).workflow_state, "sale_entry");
});

test("announced multi-day performances and queue time are retained before queue entry", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/multi-day.html",
    title: "Multi-day concert",
    body_text: `วันที่แสดง
วันเสาร์ที่ 7 พฤศจิกายน 2569 - วันอาทิตย์ที่ 8 พฤศจิกายน 2569
สถานที่แสดง
Arena
วันเปิดจำหน่าย
วันเสาร์ที่ 30 พฤษภาคม 2569, 10:00 น.
Ticket Status
COMING SOON
จำหน่ายบัตรรอบทั่วไป
วันที่ 30 พฤษภาคม 2569 กดคิว 9:00 น. เปิดจำหน่าย 10:00 น. เป็นต้นไป`,
    announced_performances: [
      { label: "18:00", context_text: "วันเสาร์ที่ 7 พฤศจิกายน 2569 18:00", data_button: "9097", target_url: "https://tickets.test/day-1", disabled: true },
      { label: "18:00", context_text: "วันอาทิตย์ที่ 8 พฤศจิกายน 2569 18:00", data_button: "9098", target_url: "https://tickets.test/day-2", disabled: true },
    ],
    controls: [
      { label: "เลือกรอบ/ประเภทบัตร", semantic_role: "schedule", selector: "" },
      { label: "18:00", context_text: "18:00", semantic_role: "schedule", data_button: "9097", target_url: "https://tickets.test/day-1", selector: "[data-button='9097']" },
    ],
  });
  assert.deepEqual(facts.show_dates.map((item) => item.iso), ["2026-11-07T00:00:00+07:00", "2026-11-08T00:00:00+07:00"]);
  assert.deepEqual(facts.performance_options.map((item) => item.schedule), ["2026-11-07T18:00:00+07:00", "2026-11-08T18:00:00+07:00"]);
  assert.equal(facts.queue_open_at, "2026-05-30T09:00:00+07:00");
  assert.equal(facts.sale_entry_controls.length, 0);
  assert.equal(evaluateTicketPreflight(facts).workflow_state, "pre_sale");
});

test("same-day performances are split and locked by exact time instead of choosing the first control", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/same-day-two-rounds.html",
    title: "Same-day two-round fixture",
    body_text: `วันที่แสดง\n19 ธันวาคม 2569\nวันเปิดจำหน่าย\n1 กันยายน 2569\nTicket Status\nON SALE NOW`,
    announced_performances: [
      { label: "14:00 ซื้อบัตร", context_text: "วันเสาร์ที่ 19 ธันวาคม 2569 14:00 / 19:00", data_button: "round-1400", status: "open", selectable: true },
      { label: "19:00 ซื้อบัตร", context_text: "วันเสาร์ที่ 19 ธันวาคม 2569 14:00 / 19:00", data_button: "round-1900", status: "open", selectable: true },
    ],
    controls: [],
  });
  assert.deepEqual(facts.performance_options.map((item) => item.schedule), [
    "2026-12-19T14:00:00+07:00",
    "2026-12-19T19:00:00+07:00",
  ]);
  assert.deepEqual(facts.performance_options.map((item) => item.data_button), ["round-1400", "round-1900"]);
});

test("combined same-day schedule text expands into separate exact choices as a fallback", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/combined-round-label.html",
    title: "Combined round label fixture",
    body_text: `วันที่แสดง\n19 ธันวาคม 2569\nวันเปิดจำหน่าย\n1 กันยายน 2569\nTicket Status\nCOMING SOON`,
    announced_performances: [
      { label: "14:00 / 19:00", context_text: "วันเสาร์ที่ 19 ธันวาคม 2569 14:00 / 19:00", status: "upcoming", selectable: false },
    ],
    controls: [],
  });
  assert.deepEqual(facts.performance_options.map((item) => item.schedule), [
    "2026-12-19T14:00:00+07:00",
    "2026-12-19T19:00:00+07:00",
  ]);
});

test("public detail text extracts exact same-day rounds before entering the buying flow", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/dreaming-fixture.html",
    title: "DREAMING fixture",
    body_text: `DREAMING TOMOHISA วันที่แสดง วันเสาร์ที่ 19 ธันวาคม 2569 วันเปิดจำหน่าย วันเสาร์ที่ 18 กรกฎาคม 2569, 10:00 น. Ticket Status ON SALE NOW ผังการแสดง & รอบการแสดง ราคาบัตร 6,500 / 5,000 วันที่แสดง เวลา วันเสาร์ที่ 19 ธันวาคม 2569 14:00 19:00 รายละเอียด การเปิดจำหน่ายบัตร`,
    controls: [],
  });
  assert.deepEqual(facts.performance_options.map((item) => item.schedule), [
    "2026-12-19T14:00:00+07:00",
    "2026-12-19T19:00:00+07:00",
  ]);
  assert.ok(facts.performance_options.every((item) => item.status === "open"));
});

test("mixed physical, streaming and sold-out rounds keep product and per-round status", () => {
  const facts = extractTicketPageFacts({
    url: "https://www.thaiticketmajor.com/concert/mixed.html",
    title: "Mixed availability concert",
    body_text: `วันที่แสดง\n4 กันยายน 2569\nวันเปิดจำหน่าย\n1 กรกฎาคม 2569\nTicket Status\nON SALE NOW`,
    announced_performances: [
      { label: "18:00 ซื้อบัตร", context_text: "วันศุกร์ที่ 4 กันยายน 2569 18:00 ซื้อบัตร", product_name: "ARENA LIVE", product_type: "in_person", status: "open", selectable: true, data_button: "physical-open" },
      { label: "18:00", context_text: "วันเสาร์ที่ 5 กันยายน 2569 18:00 Sold out", product_name: "ARENA LIVE", product_type: "in_person", status: "sold_out", selectable: false, data_button: "physical-sold" },
      { label: "18:00 ซื้อบัตร", context_text: "วันเสาร์ที่ 5 กันยายน 2569 18:00 ซื้อบัตร", product_name: "Live Streaming", product_type: "live_stream", status: "open", selectable: true, data_button: "stream-open" },
    ],
    controls: [],
  });
  assert.deepEqual(facts.performance_options.map((item) => [item.product_type, item.status, item.selectable]), [
    ["in_person", "open", true],
    ["in_person", "sold_out", false],
    ["live_stream", "open", true],
  ]);
  assert.equal(facts.sale_status, "open");
  assert.equal(facts.ticket_status, "mixed_availability");
});

test("four acceptance fixtures classify open, upcoming, closed and sold-out without guessing inventory", () => {
  const common = {
    url: "https://tickets.test/concert/status-case.html",
    title: "Status Fixture Concert",
  };
  const cases = [
    {
      expected: ["open", "available", "sale_entry"],
      snapshot: {
        ...common,
        body_text: "วันที่แสดง\n24 ตุลาคม 2569\nวันเปิดจำหน่าย\n25 สิงหาคม 2569, 12:00 น.\nTicket Status\nON SALE NOW",
        controls: [{ label: "19:00 ซื้อบัตร", semantic_role: "schedule", selector: "[data-button='open']", context_text: "24 ตุลาคม 2569 19:00 ซื้อบัตร" }],
      },
    },
    {
      expected: ["upcoming", "coming_soon", "pre_sale"],
      snapshot: {
        ...common,
        body_text: "วันที่แสดง\n31 ตุลาคม 2569\nวันเปิดจำหน่าย\n29 สิงหาคม 2569, 10:00 น.\nTicket Status\nCOMING SOON",
        controls: [],
      },
    },
    {
      expected: ["closed", "closed", "closed"],
      snapshot: {
        ...common,
        body_text: "วันที่แสดง\n1 มกราคม 2569\nวันเปิดจำหน่าย\n1 ธันวาคม 2568, 10:00 น.\nTicket Status\nCLOSED",
        controls: [],
      },
    },
    {
      expected: ["sold_out", "sold_out", "sold_out"],
      snapshot: {
        ...common,
        body_text: "วันที่แสดง\n5 กันยายน 2569\nวันเปิดจำหน่าย\n1 กรกฎาคม 2569, 10:00 น.\nTicket Status\nON SALE NOW",
        announced_performances: [
          { label: "18:00 Sold out", context_text: "วันเสาร์ที่ 5 กันยายน 2569 18:00 Sold out", product_name: "ARENA", product_type: "in_person", status: "sold_out", selectable: false },
          { label: "20:00 Sold out", context_text: "วันอาทิตย์ที่ 6 กันยายน 2569 20:00 Sold out", product_name: "ARENA", product_type: "in_person", status: "sold_out", selectable: false },
        ],
        controls: [],
      },
    },
  ];

  for (const item of cases) {
    const facts = extractTicketPageFacts(item.snapshot);
    const preflight = evaluateTicketPreflight(facts);
    assert.deepEqual([facts.sale_status, facts.ticket_status, preflight.workflow_state], item.expected);
  }
});

test("an enabled buy control does not require the legacy row-enable class", async () => {
  const source = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /!row\.classList\.contains\("row-enable"\)/);
  assert.match(source, /actually absent\/disabled control/);
});

test("event inspection distinguishes preferred-sale rows and ignores recommendation links", async () => {
  const source = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  assert.match(source, /Mastercard Preferred/);
  assert.match(source, /utm_source=ttm-index/);
  assert.match(source, /facebook\\\.com/);
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
  assert.match(route, /const liveInspection = await inspectPublicDetailText\(selected\.url, settings\)/);
  assert.match(route, /executeTool\("web_read", \{ url \}, settings\)/);
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
  assert.match(launcher, /"app_version":"1\.1\.0-beta\.24"/);
  assert.match(launcher, /หน้าเว็บ Alpha เปิดไม่สำเร็จ/);
});
