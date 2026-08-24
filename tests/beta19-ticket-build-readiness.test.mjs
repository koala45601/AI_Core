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

test("selected open or upcoming event can build without mandatory detail inspection or budget", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/ticket-bot/route.ts")]);
  assert.match(page, /ตรวจรายละเอียดเพิ่ม \(ไม่บังคับ\)/);
  assert.match(page, /งบสูงสุดรวม \(ไม่บังคับ\)/);
  assert.match(page, /0 = ไม่จำกัดงบ/);
  assert.match(page, /สร้างบอท — ค้นข้อมูลจริงตอนรัน/);
  assert.match(page, /\["open", "upcoming"\]\.includes/);
  assert.match(route, /runtime_discovery_required: true/);
  assert.match(route, /can_build: true/);
});

test("project folder is named automatically and the optional override explains the destination", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /function automaticTicketProjectName/);
  assert.match(page, /ตำแหน่งไฟล์โปรแกรม/);
  assert.match(page, /Program_Create\/{effectiveTicketProjectName}/);
  assert.match(page, /เปลี่ยนชื่อโฟลเดอร์เอง \(ไม่จำเป็น\)/);
  assert.match(page, /project_name: effectiveTicketProjectName/);
  assert.match(page, /setTicketProjectName\(""\)/);
});

test("status filters stay visible even when a source returns zero sold-out records", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/ticket-bot/route.ts")]);
  for (const label of ["เปิดช่วงขาย — ยังไม่ยืนยันที่นั่ง", "กำลังจะเปิดช่วงขาย", "พบป้าย SOLD OUT", "ปิดขาย", "งานจบแล้ว", "ยกเลิก", "ยังยืนยันไม่ได้"]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /if \(!count\) return null/);
  assert.match(route, /พบป้าย SOLD OUT \$\{counts\.sold_out \|\| 0\}/);
  assert.match(route, /requires_login_for_live_stock: true/);
  assert.doesNotMatch(page, /เปิดขาย — ซื้อได้ตอนนี้/);
  const unavailableDeclaration = route.indexOf("const unavailableCount = events.filter");
  const unavailableResponse = route.indexOf("excluded_count: unavailableCount");
  assert.ok(unavailableDeclaration >= 0, "inspect response must calculate unavailableCount");
  assert.ok(unavailableResponse > unavailableDeclaration, "unavailableCount must be declared before it is returned");
});

test("public inspection uses a headless profile and closes passive API pages", async () => {
  const [route, service] = await Promise.all([source("app/api/ticket-bot/route.ts"), source("tool-service/server.mjs")]);
  assert.match(route, /inspectAction, public_inspection: true/);
  assert.match(route, /observe_seconds: 3, public_inspection: true/);
  assert.match(service, /ensurePublicInspectionBrowser/);
  assert.match(service, /headless: true/);
  assert.match(service, /await page\.close\(\)\.catch/);
});

test("runtime-adaptive project is generated when public detail facts are unavailable", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta19-ticket-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "programs");
  const input = {
    event_url: "https://www.thaiticketmajor.com/concert/runtime-test.html",
    event_candidates: [{ id: "runtime-19", name: "Runtime Fixture", url: "https://www.thaiticketmajor.com/concert/runtime-test.html", sale_status: "open", selectable: true }],
    selected_event_id: "runtime-19",
    selected_event_name: "Runtime Fixture",
    schedule: "",
    sale_open_at: "",
    seat_mode: "reserved",
    seat_grouping: "adjacent",
    preferred_zones: [],
    preferred_rows: [],
    preferred_seat_numbers: [],
    seat_fallback_mode: "nearest",
    quantity: 2,
    budget: 0,
    delivery_method: "pickup",
    payment_method: "qr",
    functional_preflight: { public_page_verified: false, can_build: true, runtime_discovery_required: true },
    event_facts: { sale_status: "open" },
    project_name: "beta19-runtime-fixture",
  };
  try {
    const { stdout } = await execFileAsync("python3", [new URL("templates/concert-ticket-assistant.py", root).pathname, JSON.stringify(input)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.status, "project_verified");
    const config = JSON.parse(await readFile(join(result.created_project_path, "config.json"), "utf8"));
    assert.equal(config.runtimeDiscoveryRequired, true);
    assert.equal(config.schedule, "");
    assert.equal(config.saleOpenAt, "");
    assert.equal(config.budget, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
