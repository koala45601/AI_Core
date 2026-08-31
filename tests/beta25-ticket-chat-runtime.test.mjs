import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ownedBrowserPidsFromPs } from "../tool-service/ticket-run-manager.mjs";

test("Ticket Browser cleanup only targets Chrome processes that own the isolated profile", () => {
  const profile = "/Volumes/petong/Disk/AI/work/ticket-browser-profile";
  const pids = ownedBrowserPidsFromPs(`
  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default
  202 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile} --remote-debugging-port=4318
  303 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/unrelated
`, profile);
  assert.deepEqual(pids, [202]);
});

test("generated Ticket Bot auto-selects an available zone and always closes its owned browser", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  assert.match(template, /"strategy": "auto_page_order_with_fallbacks"/);
  assert.match(template, /"reason": "NO_ZONE_HAS_COMPLETE_SET"/);
  assert.match(template, /finally:\n\s+stop_owned_browser\(\)/);
});

test("chat owns the ticket workflow and streams a live Ticket Run card", async () => {
  const chat = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/chat-store.ts", import.meta.url), "utf8");
  assert.match(chat, /ticketIntent\(message\)/);
  assert.match(chat, /ticketBotAction\(\{ action: "build"/);
  assert.match(chat, /ticketBotAction\(\{ action: "run"/);
  assert.match(chat, /type: "ticket_run"/);
  assert.match(chat, /numberedPerformance > 0 \? performances\[numberedPerformance - 1\]/);
  assert.match(chat, /Boolean\(latestAssistant\.metadata\.ticket_run\)/);
  assert.match(page, /event\.type === "ticket_run"/);
  assert.match(page, /Ticket Full Loop/);
  assert.match(store, /ticket_run\?: Record<string, unknown>/);
});
