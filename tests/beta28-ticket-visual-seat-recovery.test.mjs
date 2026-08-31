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

const fixturePayload = {
  event_candidates: [{ id: "fixture", name: "Fixture", url: "https://tickets.test/event", sale_status: "open" }],
  selected_event_id: "fixture",
  event_url: "https://tickets.test/event",
  schedule: "2026-08-28T19:00:00+07:00",
  sale_open_at: "2026-08-27T10:00:00+07:00",
  event_facts: { sale_status: "open", sale_open_at: "2026-08-27T10:00:00+07:00", evidence: ["fixture"] },
  functional_preflight: { public_page_verified: true, runtime_discovery_required: false },
  quantity: 2,
  seat_mode: "reserved",
  seat_grouping: "adjacent",
  preferred_zones: [],
  seat_fallback_mode: "nearest",
  delivery_method: "pickup",
  payment_method: "qr",
  project_name: "beta28-visual-recovery-fixture",
};

test("beta28 keeps all discovered zones, escalates unknown seat layouts to vision, and recovers browser loss", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(pkg.version, /^2\.0\.0-alpha\.\d+$/);
  assert.match(template, /"runtimeRevision": "ticket-seat-availability-modal-1"/);
  assert.match(template, /"runtime_revision": "ticket-seat-availability-modal-1"/);
  assert.match(template, /MODAL_ALREADY_VISIBLE_REUSED/);
  assert.match(template, /GENERAL_ADMISSION_TRANSITION_PENDING/);
  assert.match(template, /LIVE_QUANTITY_FLOW_CONFIRMED/);
  assert.match(template, /zones = list\(page_zone_names\)/);
  assert.match(template, /"candidate_order": zones/);
  assert.match(template, /def visible_human_challenge\(page\):/);
  assert.match(template, /directText/);
  assert.match(template, /presentation\.get\("inViewport"\)/);
  assert.match(template, /def capture_ai_visual_snapshot\(page, status="ai-visual-analysis"\):/);
  assert.match(template, /message\["images"\] = \[image_base64\]/);
  assert.match(template, /"screenshot_included": bool\(image_base64\)/);
  assert.match(template, /"browser_closed": True/);
  assert.match(template, /"browser_lost": "relaunch_same_profile_and_resume"/);
  assert.match(template, /"status": "BROWSER_RELAUNCHED"/);
  assert.match(template, /last_safe_state == "queue"/);
  assert.match(template, /def wait_for_page_ready\(page, timeout_ms=(?:12000|None)\):/);
  assert.match(template, /document\.readyState === 'complete'/);
  assert.match(template, /errors = click_candidate_set\(page, locators, metadata, indices\)/);
  assert.match(template, /"status": "BROWSER_LOST_DURING_ACTIVE_QUEUE"/);
  assert.match(template, /"festival\.php" in url[\s\S]{0,180}"quantity_selection"/);
  assert.match(template, /"status": "GENERAL_ADMISSION_HOLD_VERIFIED"/);
  assert.match(template, /Never forge a new zone query/);
  assert.doesNotMatch(template, /query\[zone_key\] = wanted/);
});

test("generated beta28 runtime classifies a closed page without throwing and sends an image only to local AI", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta28-visual-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "Program_Create");
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(fixturePayload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const project = result.created_project_path;
    const probe = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import bot

class ClosedPage:
    def is_closed(self): return True

closed = bot.snapshot(ClosedPage())
assert closed["browser_closed"] is True
assert bot.classify_snapshot(closed)["state"] == "browser_lost"

class OpenPage:
    url = "https://tickets.test/seat-map"
    def is_closed(self): return False

assert bot.safe_page_url(OpenPage()) == "https://tickets.test/seat-map"

# Some booking pages keep zones.php after opening the seat map. The live seat
# controls must win over the stale zone URL, otherwise the runner clicks the
# same zone again and loops between zone and seat pages.
zones_seat_map = {
    "url": "https://tickets.test/booking/3m/zones.php?query=524",
    "body": "ขั้นตอนที่ 1/4 เลือกโซนและรอบการแสดง",
    "seat_control_count": 3,
}
assert bot.classify_snapshot(zones_seat_map)["state"] == "ticket_selection"

# Textual availability is valid evidence for a no-numbered-seat zone, but it
# must never be fabricated into a numeric inventory count.
textual_availability = bot.normalize_zone_availability({"zone":"DEAR.", "available":"Available"})
assert textual_availability == {"DEAR.": None}
assert bot.availability_meets_requirement(textual_availability["DEAR."], 4) is True
assert bot.align_zone_availability({"DEAR.": None, "FROM.": None}, ["DE", "FR"]) == {"DE": None, "FR": None}

class ReadyPage:
    url = "https://tickets.test/seat-map"
    def __init__(self): self.events = []
    def is_closed(self): return False
    def evaluate(self, script): return {"domGeneration": 0, "lastUserInputAt": 0}
    def wait_for_load_state(self, state, timeout=0): self.events.append(("load_state", state))
    def wait_for_function(self, script, timeout=0): self.events.append(("ready_state", script))

ready_page = ReadyPage()
assert bot.wait_for_page_ready(ready_page) is True
assert ready_page.events[0] == ("load_state", "domcontentloaded")
assert "document.readyState === 'complete'" in ready_page.events[1][1]
click_events = []
class FakeLocator:
    def evaluate(self, script): click_events.append("clicked")
assert bot.click_candidate_set(ready_page, [FakeLocator()], [{}], [0]) == []
assert click_events == ["clicked"]

class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self):
        content = {"action":"request_user","diagnosis":"visual fixture","reason":"unknown canvas","confidence":0.8,"next_expected_state":"ticket_selection"}
        return json.dumps({"message":{"content":json.dumps(content)}}).encode()

def fake_urlopen(request, timeout=0):
    body = json.loads(request.data.decode())
    message = body["messages"][0]
    assert message["images"] == ["aW1hZ2U="]
    assert "_image_base64" not in message["content"]
    assert body["keep_alive"] == -1
    return Response()

bot.urllib.request.urlopen = fake_urlopen
bot.os.environ["ALPHA_OLLAMA_BASE_URL"] = "http://127.0.0.1:11999"
decision = bot.query_local_ai({"state":"ticket_selection","url":"https://tickets.test/seat","controls":[],"_image_base64":"aW1hZ2U=","_image_evidence_path":"/tmp/evidence.jpg"}, ["request_user"], {"visual_required":True}, 1)
assert decision["action"] == "request_user"
assert decision["screenshot_included"] is True
assert decision["image_evidence_path"] == "/tmp/evidence.jpg"
bot.AI_EXECUTOR.shutdown(wait=False, cancel_futures=True)
`;
    const checked = await run("python3", ["-c", probe, project], { cwd: project });
    assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
