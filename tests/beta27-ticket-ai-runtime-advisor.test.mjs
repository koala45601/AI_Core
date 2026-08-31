import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const CURRENT_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

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

test("beta27 analyzes every ticket state and learns verified recovery strategies", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  const manager = await readFile(new URL("../tool-service/ticket-run-manager.mjs", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(pkg.version, /^2\.0\.0-alpha\.\d+$/);
  assert.match(template, /"analyzeEveryState": True/);
  assert.match(template, /"backgroundAdvisor": True/);
  assert.match(template, /"actionMode": "validated_autonomous"/);
  assert.match(template, /def schedule_ai_runtime_analysis\(page, checkpoint, context=None\):/);
  assert.match(template, /AI_FUTURES = \{\}/);
  assert.match(template, /max_workers=1/);
  assert.match(template, /future\.add_done_callback/);
  assert.match(template, /def console_input\(prompt=""\):/);
  assert.doesNotMatch(template, /\binput\("/);
  assert.match(template, /schedule_ai_runtime_analysis\(page, checkpoint/);
  assert.match(template, /def execute_validated_ai_action\(page, checkpoint, decision, confirm_order=False\):/);
  assert.match(template, /if action not in ai_actions_for_state\(state\):/);
  assert.match(template, /def remember_ai_strategy\(decision, from_state, to_state\):/);
  assert.match(template, /ticket-ai-recovery-strategies\.json/);
  assert.match(template, /credentials_included": False/);
  assert.match(template, /"payment_submitted": False/);
  assert.match(template, /ALPHA_OLLAMA_BASE_URL/);
  assert.doesNotMatch(template, /127\.0\.0\.1:11434/);
  assert.match(template, /state not in \{"queue", "captcha_handoff", "otp_handoff", "payment_handoff"\}/);
  assert.match(manager, /kind === "ai_analysis"/);
  assert.match(manager, /kind === "ai_action"/);
  assert.match(manager, /kind === "ai_strategy_learned"/);
  assert.match(manager, /function thaiRuntimeMessage\(kind, event = \{\}\)/);
  assert.match(manager, /event\.message_th \|\|= thaiRuntimeMessage/);
  assert.match(manager, /ALPHA_OLLAMA_BASE_URL:/);
  assert.match(template, /def thai_runtime_message\(kind, payload\):/);
  assert.match(template, /item\.setdefault\("message_th"/);
  assert.match(page, /AI Learned/);
  assert.match(page, /AI วิเคราะห์/);
});

test("generated beta27 advisor accepts local JSON decisions, learns, and rejects an unsafe state action", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta27-advisor-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "Program_Create");
  const payload = {
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
    preferred_zones: ["A-K"],
    seat_fallback_mode: "nearest",
    delivery_method: "pickup",
    payment_method: "qr",
    project_name: "beta27-advisor-fixture",
  };
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(payload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const project = result.created_project_path;
    const probe = String.raw`
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import bot
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self):
        content = {"action":"rescan","diagnosis":"DOM changed","reason":"control moved","confidence":0.9,"next_expected_state":"sale_entry"}
        return json.dumps({"message":{"content":json.dumps(content)}}).encode()
def fake_urlopen(request, timeout=0):
    assert request.full_url == "http://127.0.0.1:11999/api/chat"
    body = json.loads(request.data.decode())
    assert body["think"] is False
    assert body["keep_alive"] == -1
    return Response()
bot.urllib.request.urlopen = fake_urlopen
bot.os.environ["ALPHA_OLLAMA_BASE_URL"] = "http://127.0.0.1:11999/"
snapshot = {"state":"unknown","url":"https://tickets.test/event","body":"changed", "controls":[], "allowed_zones":["A"], "current_zone":"A"}
decision = bot.query_local_ai(snapshot, ["rescan", "request_user"], {"phase":"fixture"}, 1)
assert decision["action"] == "rescan"
assert decision["confidence"] == 0.9
bot.AI_STRATEGY_PATH = pathlib.Path(sys.argv[1]) / "strategy-fixture.json"
decision.update({"action":"reload_same_url", "strategy_key":"fixture-key"})
bot.remember_ai_strategy(decision, "access_denied", "sale_entry")
saved = json.loads(bot.AI_STRATEGY_PATH.read_text())
assert saved[0]["success_count"] == 1
assert bot.execute_validated_ai_action(object(), {"state":"queue"}, {"action":"reload_same_url"}) is False
bot.AI_EXECUTOR.shutdown(wait=False, cancel_futures=True)
`;
    const checked = await run("python3", ["-c", probe, project], { cwd: project });
    assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("launcher rejects a stale Tool Service and synchronizes the installed ticket generator", async () => {
  const launcher = await readFile(new URL("../start-alpha.command", import.meta.url), "utf8");
  assert.match(launcher, /scripts\/sync-bundled-skills\.mjs/);
  assert.match(launcher, /"app_version":"'"\$ALPHA_APP_VERSION"'"/);
  assert.match(launcher, /warm_primary_model/);
  assert.match(launcher, /OLLAMA_MAX_LOADED_MODELS=1/);
  assert.match(launcher, /OLLAMA_KEEP_ALIVE=-1/);

  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta27-sync-"));
  const skillDir = join(temporary, "outputs", "Alpha Outputs", "Learned Skills", "concert-ticket-purchase-assistant");
  const workDir = join(temporary, "work");
  const templateDir = join(temporary, "templates");
  try {
    await mkdir(skillDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(temporary, "package.json"), JSON.stringify({ version: CURRENT_VERSION }), "utf8");
    await writeFile(join(templateDir, "concert-ticket-assistant.py"), "# beta27 runtime\n", "utf8");
    await writeFile(join(skillDir, "main.py"), "# stale beta24 runtime\n", "utf8");
    await writeFile(join(skillDir, "alpha-skill.json"), JSON.stringify({ id: "concert-ticket-purchase-assistant", version: 24, generator_version: "1.1.0-beta.24" }), "utf8");
    await writeFile(join(workDir, "skills-index.json"), JSON.stringify([{ id: "concert-ticket-purchase-assistant", version: 24 }]), "utf8");

    const synced = await run(process.execPath, [new URL("../scripts/sync-bundled-skills.mjs", import.meta.url).pathname, temporary]);
    assert.equal(synced.code, 0, synced.stderr || synced.stdout);
    assert.equal(await readFile(join(skillDir, "main.py"), "utf8"), "# beta27 runtime\n");
    const manifest = JSON.parse(await readFile(join(skillDir, "alpha-skill.json"), "utf8"));
    assert.equal(manifest.generator_version, CURRENT_VERSION);
    assert.equal(manifest.version, 20_000 + Number(CURRENT_VERSION.match(/alpha\.(\d+)$/)?.[1] || 0));
    const index = JSON.parse(await readFile(join(workDir, "skills-index.json"), "utf8"));
    assert.equal(index.at(-1).generator_version, CURRENT_VERSION);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Tool Service passes its configured Ollama endpoint to generated ticket runtimes", async () => {
  const server = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  const manager = await readFile(new URL("../tool-service/ticket-run-manager.mjs", import.meta.url), "utf8");
  assert.match(server, /OLLAMA_BASE_URL/);
  assert.match(server, /ollamaBaseUrl,/);
  assert.match(manager, /ollamaBaseUrl = "http:\/\/127\.0\.0\.1:11435"/);
  assert.match(manager, /ALPHA_OLLAMA_BASE_URL: String\(ollamaBaseUrl/);
});

test("Ticket Studio never leaves Create and Run as a silent no-op after an interrupted request", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const service = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  assert.match(page, /ticketRunPendingSinceRef/);
  assert.match(page, /stalePendingLock = ticketStage !== "building" \|\| pendingAge > 120_000/);
  assert.match(page, /A hot reload, interrupted fetch, or crashed runtime must never leave/);
  assert.match(page, /กรุณาเลือกคอนเสิร์ตก่อนสร้างบอท/);
  assert.match(page, /กำลังสร้างหรือเริ่ม Ticket Bot อยู่ กรุณารอผลลัพธ์จากคำสั่งเดิม/);
  assert.match(service, /async function ensureBundledSkillCurrent\(id, directory\)/);
  assert.match(service, /installed !== source/);
  assert.match(service, /await ensureBundledSkillCurrent\(id, directory\)/);
});
