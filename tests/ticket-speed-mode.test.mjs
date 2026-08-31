import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const templatePath = new URL("../templates/concert-ticket-assistant.py", import.meta.url);
const pagePath = new URL("../app/page.tsx", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("ticket speed mode is opt-in and keeps the existing generator version", async () => {
  const [template, page, packageJson] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);
  const pkg = JSON.parse(packageJson);

  assert.equal(pkg.version, "2.0.0-alpha.1");
  assert.match(template, /"runtimeRevision": "ticket-speed-mode-2-price-preferences"/);
  assert.match(template, /"ticketSpeed": \{/);
  assert.match(template, /"apiFirst": True/);
  assert.match(template, /"cacheVerifiedContractsPerRun": True/);
  assert.match(template, /"maxConcurrentStateChanges": 1/);
  assert.match(template, /"inputDelayMs": 0/);

  // Only exact, observed read-only frontend contracts may be replayed.
  assert.match(template, /def register_frontend_api_request\(request\):/);
  assert.match(template, /method not in \{"GET", "HEAD"\}/);
  assert.match(template, /def replay_verified_frontend_api\(page, purpose="availability"\):/);
  assert.match(template, /credentials: 'include'/);
  assert.match(template, /state_changing": False/);
  assert.match(template, /if status == 429:/);
  assert.match(template, /API_RETRY_AFTER_UNTIL/);
  assert.match(template, /RETRY_AFTER_HONORED/);

  // A legacy generated bot is rebuilt so the user actually gets this runtime.
  assert.match(page, /ticketBuildReport\.runtime_revision === "ticket-speed-mode-2-price-preferences"/);
  assert.doesNotMatch(page, /\["page-ready-gate-1", "ticket-speed-mode-1"\]/);
});

test("ticket speed mode removes blind waits from the fast paths", async () => {
  const template = await readFile(templatePath, "utf8");

  assert.doesNotMatch(template, /time\.sleep\(0\.05\)/);
  assert.doesNotMatch(template, /page\.wait_for_timeout\(400\)/);
  assert.match(template, /def wait_for_page_change\(page, previous_url, timeout_ms=5000\):/);
  assert.match(template, /window\.__alphaDomGeneration/);
  assert.match(template, /wait_for_load_state\("domcontentloaded"/);
});
