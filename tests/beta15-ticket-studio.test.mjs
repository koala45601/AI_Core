import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Ticket Bot Studio is a fixed workspace with all user preference fields", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /type View = "chat" \| "video" \| "memory" \| "skills" \| "tickets" \| "settings"/);
  assert.match(page, /TICKET BOT STUDIO/);
  assert.match(page, /ตรวจคอนเสิร์ต/);
  assert.match(page, /ประเภทบัตร/);
  assert.match(page, /QR Payment/);
  assert.match(page, /PromptPay/);
  assert.match(page, /Login อัตโนมัติจาก session\/secure prompt/);
  assert.match(page, /type="password"/);
  assert.match(page, /password ใช้เฉพาะตอน run และไม่บันทึก/);
  assert.match(page, /setTicketPassword\(""\)/);
  assert.match(css, /\.ticket-workspace \{[^}]*overflow: hidden/);
  assert.match(css, /\.ticket-event-list \{[^}]*overflow-y: auto/);
  assert.match(css, /\.ticket-config-scroll \{[^}]*overflow-y: auto/);
});

test("Ticket Bot API uses deterministic tools and never attempts a live purchase", async () => {
  const route = await source("app/api/ticket-bot/route.ts");
  assert.match(route, /action === "inspect"/);
  assert.match(route, /action === "inspect_form"/);
  assert.match(route, /action === "build"/);
  assert.match(route, /executeTool\("browser_action"/);
  assert.match(route, /executeTool\("api_discovery"/);
  assert.match(route, /skill_id: "concert-ticket-purchase-assistant"/);
  assert.match(route, /execution_target: "macos_host"/);
  assert.match(route, /live_purchase_attempted: false/);
  assert.match(route, /handoff_points: \["captcha", "otp", "payment"\]/);
  assert.match(route, /domainAllowed\(url, settings\)/);
  assert.match(route, /settings\.web_search_enabled/);
  assert.match(route, /selected\.url !== eventUrl/);
  assert.match(route, /assertInternetAndDomain\(selected\.url, settings\)/);
});

test("Ticket Bot build validates a complete five-file project", async () => {
  const route = await source("app/api/ticket-bot/route.ts");
  for (const file of ["bot.py", "config.json", "requirements.txt", "start.command", "README.md"]) {
    assert.match(route, new RegExp(`"${file.replace(".", "\\.")}"`));
  }
  assert.match(route, /expectedFiles\.every\(\(file\) => createdFiles\.includes\(file\)\)/);
});

test("Event discovery merges duplicate URLs and filters generic buttons", async () => {
  const service = await source("tool-service/server.mjs");
  assert.match(service, /const genericNamePattern =/);
  assert.match(service, /const mergedByUrl = new Map\(\)/);
  assert.match(service, /genericNamePattern\.test\(String\(candidate\.name/);
  assert.match(service, /candidate\.normalized_url \|\| candidate\.id/);
});
