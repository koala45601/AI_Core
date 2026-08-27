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

test("beta26 source has a complete-set recovery loop and evidence-gated Full Loop", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  const manager = await readFile(new URL("../tool-service/ticket-run-manager.mjs", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.version, "1.1.0-beta.27");
  assert.match(template, /"mode": "until_terminal"/);
  assert.match(template, /"maxAttempts": 0/);
  assert.match(template, /len\(indices\) != wanted/);
  assert.match(template, /record\("seat_conflict"/);
  assert.match(template, /release_partial_selection/);
  assert.match(template, /wait_for_inventory_change/);
  assert.match(template, /record\("reservation_verified"/);
  assert.match(template, /request_ai_recovery_action/);
  assert.match(template, /page_refresh": False/);
  assert.doesNotMatch(template, /page\.wait_for_timeout\((?:1000|1500)\)/);
  assert.match(manager, /run\.full_loop_verified = run\.payment_handoff_verified && run\.reservation_verified/);
  assert.match(page, /reservation_verified/);
  assert.match(page, /ticket-run-metrics/);
});

test("generated beta26 bot expands zone ranges and requires a complete candidate set", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-beta26-ticket-"));
  const output = join(temp, "output");
  const programs = join(temp, "Program_Create");
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
    project_name: "beta26-fixture",
  };
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(payload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const config = JSON.parse(await readFile(join(result.created_project_path, "config.json"), "utf8"));
    assert.equal(config.generatorVersion, "1.1.0-beta.27");
    assert.equal(config.seatRecovery.mode, "until_terminal");
    assert.equal(config.seatRecovery.maxAttempts, 0);
    const compiled = await run("python3", ["-m", "py_compile", join(result.created_project_path, "bot.py"), join(result.created_project_path, "state_machine.py")], { cwd: result.created_project_path });
    assert.equal(compiled.code, 0, compiled.stderr || compiled.stdout);
    const verified = await run("python3", [join(result.created_project_path, "tests", "test_state_machine.py")], { cwd: result.created_project_path });
    assert.equal(verified.code, 0, verified.stderr || verified.stdout);
    assert.match(verified.stderr + verified.stdout, /test_complete_set_is_required_before_any_index_is_returned/);
    assert.match(verified.stderr + verified.stdout, /test_zone_range_expands_in_user_order/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
