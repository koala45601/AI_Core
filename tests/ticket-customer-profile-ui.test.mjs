import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Ticket Studio persists only the non-secret customer profile", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /TICKET_CUSTOMER_PROFILE_STORAGE_KEY\s*=\s*["']alpha\.ticket-studio\.customer-profile\.v1["']/);
  assert.match(page, /window\.localStorage\.getItem\(TICKET_CUSTOMER_PROFILE_STORAGE_KEY\)/);
  assert.match(page, /window\.localStorage\.setItem\(TICKET_CUSTOMER_PROFILE_STORAGE_KEY, JSON\.stringify\(profile\)\)/);
  assert.match(page, /window\.localStorage\.removeItem\(TICKET_CUSTOMER_PROFILE_STORAGE_KEY\)/);
  for (const field of ["customerName", "attendeeNames", "phone", "address", "city", "province", "postalCode", "delivery", "ticketProtect", "payment"]) {
    assert.match(page, new RegExp(`\\b${field}:`), `profile should persist ${field}`);
  }

  const saveStart = page.indexOf("const profile: TicketCustomerProfile");
  const saveEnd = page.indexOf("window.localStorage.setItem", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, "profile allowlist must be explicit before storage");
  const profileAllowlist = page.slice(saveStart, saveEnd);
  assert.doesNotMatch(profileAllowlist, /username|password/i, "username/password must not be part of the stored profile");
  assert.match(page, /setTicketPassword\(""\)/, "password remains transient after a run");
});

test("Ticket Studio restores profile fields, exposes phone, and sends buyer_phone", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /ticketCustomerProfileRestoredRef/);
  assert.match(page, /if \(view !== "tickets"\)/);
  assert.match(page, /setTicketCustomerPhone\(typeof saved\.phone === "string" \? saved\.phone : ""\)/);
  assert.match(page, /autoComplete="tel"/);
  assert.match(page, /เบอร์โทรศัพท์ผู้ซื้อ/);
  assert.match(page, /buyer_phone:\s*ticketCustomerPhone/);
  assert.match(page, /บันทึกข้อมูลผู้ซื้อ/);
  assert.match(page, /ล้างข้อมูลที่บันทึก/);
  assert.match(page, /ไม่รวม username\/password/);
});

test("Ticket Run View and cards expose locked selection and available alternatives", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /interface TicketAvailableOption/);
  assert.match(page, /available_options\?: TicketAvailableOption\[\]/);
  assert.match(page, /interface TicketLockedSelectionView/);
  assert.match(page, /locked_selection\?: TicketLockedSelectionView/);
  for (const field of ["locked_prices", "locked_rows", "locked_seat_numbers"]) {
    assert.match(page, new RegExp(`${field}\\?:`), `run view should support ${field}`);
  }
  assert.match(page, /ticketRunAvailableOptions/);
  assert.match(page, /ticket-locked-panel/);
  assert.match(page, /เงื่อนไขที่ runtime ล็อกไว้/);
  assert.match(page, /ticket-availability-panel/);
  assert.match(page, /ทางเลือกที่ยังว่างตามหลักฐาน/);
  assert.match(page, /สาเหตุ \/ จุดติดขัด/);
  assert.match(page, /กำลังทำอะไร/);
  assert.match(page, /ขั้นถัดไป/);
  assert.match(css, /\.ticket-studio-status/);
  assert.match(css, /\.ticket-run-overview/);
  assert.match(css, /\.ticket-locked-grid/);
  assert.match(css, /\.ticket-availability-grid/);
});

test("Ticket Studio keeps the selected summary in a fixed row outside the config scroller", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  const headerStart = page.indexOf('<header className="ticket-config-header">');
  const headerEnd = page.indexOf("</header>", headerStart);
  const summaryStart = page.indexOf('<section className={`ticket-selected-summary');
  const scrollStart = page.indexOf('<div className="ticket-config-scroll">');
  const formStart = page.indexOf('<form className="ticket-build-form"');

  assert.ok(headerStart >= 0 && headerEnd > headerStart, "config header should exist");
  assert.ok(summaryStart > headerEnd && summaryStart < scrollStart, "summary must be the direct row between header and scroller");
  assert.ok(formStart > scrollStart, "form must remain inside the scroll area");
  assert.match(page, /ticket-config-empty/);
  assert.match(page, /ยังไม่ได้เลือกคอนเสิร์ต/);
  assert.doesNotMatch(page.slice(formStart, page.indexOf("</form>", formStart)), /ticket-selected-summary/, "summary must not be nested inside the scrolling form");

  const paneRule = css.match(/(?:^|})\s*\.ticket-config-pane\s*\{([^}]*)\}/s)?.[1] ?? "";
  const scrollRule = css.match(/\.ticket-config-scroll\s*\{([^}]*)\}/s)?.[1] ?? "";
  const summaryRule = css.match(/\.ticket-selected-summary\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(paneRule, /grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)/);
  assert.match(scrollRule, /overflow-y:\s*auto/);
  assert.doesNotMatch(summaryRule, /position:\s*sticky/);
  assert.doesNotMatch(summaryRule, /position:\s*fixed/);
  assert.match(summaryRule, /margin:\s*12px\s+20px\s+0/);
  assert.match(summaryRule, /background:\s*#f7faf8/);
  assert.match(summaryRule, /box-shadow:/);
});

test("Ticket Studio auto-applies the live quantity limit without asking the user", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /requested_quantity\?: number \| null/);
  assert.match(page, /adjusted_quantity\?: number \| null/);
  assert.match(page, /quantity_auto_adjusted\?: boolean/);
  assert.match(page, /if \(liveTicketQuantityLimit != null && ticketQuantity > liveTicketQuantityLimit\)/);
  assert.match(page, /setTicketQuantity\(liveTicketQuantityLimit\)/);
  assert.match(page, /ระบบปรับจาก \$\{requestedTicketQuantity\} เป็น \$\{adjustedTicketQuantity\} ใบและทำงานต่ออัตโนมัติ/);
  assert.match(page, /ticket-quantity-limit-warning/);
  assert.match(css, /\.ticket-locked-summary \.ticket-quantity-limit-warning/);
});
