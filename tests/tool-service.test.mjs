import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import WebSocket from "ws";

const token = "a".repeat(64);
const port = 14_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const projectRoot = resolve(new URL("..", import.meta.url).pathname);

async function request(path, body, authorization = true) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(authorization ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("tool service creates real files and enforces local file safety", async (context) => {
  await fs.mkdir(join(projectRoot, "work"), { recursive: true });
  const appDir = await fs.mkdtemp(join(projectRoot, "work", "alpha-tools-test-"));
  const child = spawn(process.execPath, [join(projectRoot, "tool-service", "server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, ALPHA_APP_DIR: appDir, ALPHA_LAB_ROOT: join(appDir, "AI_LAB"), ALPHA_TOOL_TOKEN: token, ALPHA_TOOL_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    await request("/v1/shutdown", {}).catch(() => {});
    child.kill("SIGKILL");
    await fs.rm(appDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request("/v1/health");
      if (response.ok) break;
    } catch { /* wait for startup */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  assert.equal((await request("/v1/health", undefined, false)).status, 401);

  const settings = { file_access_mode: "alpha_outputs", tool_idle_timeout_seconds: 300 };
  const createdResponse = await request("/v1/tool/execute", {
    name: "create_files",
    arguments: { project_name: "calculator", files: [{ path: "calculator.py", content: "print(2 + 3)\n" }] },
    settings,
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.artifacts[0].name, "calculator.py");
  assert.equal(await fs.readFile(created.artifacts[0].path, "utf8"), "print(2 + 3)\n");

  const invalidResponse = await request("/v1/tool/execute", {
    name: "create_files",
    arguments: { project_name: "broken", files: [{ path: "broken.py", content: "def broken(:\n" }] },
    settings,
  });
  const invalid = await invalidResponse.json();
  assert.equal(invalid.ok, false);
  assert.ok(invalid.validation_errors[0].includes("broken.py"));

  const traversal = await request("/v1/tool/execute", {
    name: "create_files",
    arguments: { project_name: "escape", files: [{ path: "../escape.py", content: "print('no')" }] },
    settings,
  });
  assert.equal(traversal.status, 500);
  assert.match((await traversal.json()).error, /พาธไฟล์ไม่ปลอดภัย/);

  const outputs = join(appDir, "outputs", "Alpha Outputs");
  await fs.symlink("/tmp", join(outputs, "link-out"));
  const symlink = await request("/v1/tool/execute", {
    name: "create_files",
    arguments: { project_name: "ignored", destination: join(outputs, "link-out"), files: [{ path: "escape.py", content: "print('no')" }] },
    settings,
  });
  assert.equal(symlink.status, 500);
  assert.match((await symlink.json()).error, /symbolic link/);

  const ssrf = await request("/v1/tool/execute", {
    name: "web_read",
    arguments: { url: "http://127.0.0.1/private" },
    settings,
  });
  assert.equal(ssrf.status, 500);
  assert.match((await ssrf.json()).error, /เครือข่ายภายใน|URL ภายในเครื่อง/);

  const askResponse = await request("/v1/tool/execute", {
    name: "create_files",
    arguments: { project_name: "ask-first", files: [{ path: "answer.txt", content: "approved" }] },
    settings: { ...settings, file_access_mode: "ask" },
  });
  assert.equal(askResponse.status, 409);
  const ask = await askResponse.json();
  assert.equal(ask.confirmation_required, true);
  const confirmationResponse = await request("/v1/tools/confirm", { confirmation_id: ask.confirmation_id, approved: true });
  assert.equal(confirmationResponse.status, 200);
  assert.equal((await confirmationResponse.json()).artifacts[0].name, "answer.txt");

  const pairingCodeResponse = await request("/v1/extension/pairing");
  const pairingCode = (await pairingCodeResponse.json()).code;
  const pairResponse = await request("/v1/extension/pair", { code: pairingCode }, false);
  assert.equal(pairResponse.status, 200);
  assert.equal((await pairResponse.json()).token, token);

  const extension = new WebSocket(`${base.replace("http", "ws")}/v1/extension?token=${token}`);
  await once(extension, "open");
  context.after(() => extension.close());
  extension.on("message", (raw) => {
    const command = JSON.parse(raw.toString());
    if (!command.id) return;
    extension.send(JSON.stringify({ id: command.id, result: { ok: true, url: "https://example.com/", title: "Mock Chrome" } }));
  });
  const extensionHealth = await (await request("/v1/health")).json();
  assert.equal(extensionHealth.chrome_extension_connected, true);
  assert.equal(extensionHealth.web_read_ready, true);
  assert.equal(extensionHealth.search_ready, true);
  assert.equal(extensionHealth.search_backend, "duckduckgo");
  assert.equal(extensionHealth.docker_connected, false);
  assert.equal(extensionHealth.searxng_connected, false);
  assert.equal(extensionHealth.lab_root, join(appDir, "AI_LAB"));
  assert.equal(extensionHealth.browser_ready, true);
  assert.equal(typeof extensionHealth.skill_lab_ready, "boolean");
  assert.ok(extensionHealth.trusted_dependencies.includes("python-stdlib"));
  assert.equal(extensionHealth.auto_learn.status, "idle");
  const autoLearnStatus = await request("/v1/auto-learn/status");
  assert.equal(autoLearnStatus.status, 200);
  assert.equal((await autoLearnStatus.json()).job.status, "idle");

  const unlimitedStart = await request("/v1/auto-learn/start", {
    duration_minutes: 0,
    model: "test-model-not-installed",
    focus_context: "ทดสอบโหมดไม่จำกัด",
    max_rounds: 0,
    retry_limit: 1,
    rest_seconds: 0,
  });
  assert.equal(unlimitedStart.status, 200);
  const unlimitedJob = (await unlimitedStart.json()).job;
  assert.equal(unlimitedJob.duration_minutes, 0);
  assert.equal(unlimitedJob.deadline, 0);
  assert.equal(unlimitedJob.status, "running");
  const unlimitedStop = await request("/v1/auto-learn/stop", {});
  assert.equal(unlimitedStop.status, 200);
  assert.equal((await unlimitedStop.json()).job.status, "stopped");

  {
    const skillResponse = await request("/v1/tool/execute", {
      name: "skill_lab_test",
      arguments: {
        goal_id: "echo-validator",
        objective: "validate JSON inputs deterministically",
        success_criteria: "print VALID for values including hidden fixtures",
        attempt: 1,
        origin: "skill_lab",
        skill: {
          id: "echo-validator",
          name: "Echo Validator",
          description: "Validates JSON values",
          runtime: "python",
          entrypoint: "main.py",
          dependencies: ["python-stdlib"],
          trigger_examples: ["validate this JSON"],
          test_cases: [
            { name: "number", input: { value: 1 }, stdout_contains: "VALID", expected_files: [] },
            { name: "thai", input: { value: "ไทย" }, stdout_contains: "VALID", expected_files: ["proof.png"] },
          ],
        },
        hidden_test_cases: [
          { name: "empty", input: { value: "" }, stdout_contains: "VALID", expected_files: [] },
          { name: "unicode", input: { value: "α" }, stdout_contains: "VALID", expected_files: [] },
        ],
        files: [{ path: "main.py", content: "import json, os, pathlib, sys\njson.loads(sys.argv[1])\npathlib.Path(os.environ['ALPHA_OUTPUT_DIR'], 'proof.png').write_bytes(b'PNG fixture')\nprint('VALID')\n" }],
      },
      settings,
    });
    assert.equal(skillResponse.status, 200);
    const trained = await skillResponse.json();
    assert.equal(trained.passed, true);
    assert.equal(trained.skill.verified_pass_rate, 100);
    assert.equal(trained.skill.hidden_test_result.total, 2);
    assert.ok(trained.skill.generalization_confidence > 0 && trained.skill.generalization_confidence < 100);
    assert.equal(trained.report.tests[1].checks.files, true);
    assert.equal(await fs.stat(join(appDir, "work", "skill-lab", "manual-echo-validator")).then(() => true).catch(() => false), false);

    const learnedRunResponse = await request("/v1/tool/execute", {
      name: "run_learned_skill",
      arguments: { skill_id: "echo-validator", input: { value: "เรียกใช้จากแชต" } },
      settings,
    });
    assert.equal(learnedRunResponse.status, 200);
    const learnedRun = await learnedRunResponse.json();
    assert.equal(learnedRun.ok, true);
    assert.match(learnedRun.stdout, /VALID/);
    assert.match(learnedRun.execution_target, /macos_lab/);
    assert.match(learnedRun.lab_directory, new RegExp(`AI_LAB[/\\\\]\\d{4}-\\d{2}-\\d{2}`));
    const learnedDetail = await (await request("/v1/skills/echo-validator")).json();
    assert.equal(learnedDetail.skill.manifest.usage_count, 1);
    assert.equal(learnedDetail.skill.manifest.success_count, 1);
  }

  const skillFixtures = Array.from({ length: 1000 }, (_, index) => ({
    id: `fixture-skill-${String(index).padStart(4, "0")}`,
    name: `Fixture Skill ${index}`,
    description: "virtualized skill registry fixture",
    version: 1,
    enabled: true,
    origin: index % 2 ? "auto_learn" : "skill_lab",
    runtime: "python",
    dependencies: ["python-stdlib"],
    trigger_examples: ["fixture"],
    installed_at: new Date(index).toISOString(),
    updated_at: new Date(index).toISOString(),
    verification_status: "verified",
    verified_pass_rate: 100,
    verified_passed: 48,
    verified_total: 48,
    verification_scope: "finite fixture corpus",
    generalization_confidence: 96.2,
    confidence_sample_size: 120,
    environment_fingerprint: "fixture-env",
    usage_count: index,
    success_count: index,
    last_run_at: "",
    last_error: "",
  }));
  await fs.writeFile(join(appDir, "work", "skills-index.json"), JSON.stringify(skillFixtures), "utf8");
  const skillsPage = await (await request("/v1/skills?limit=50&sort=name")).json();
  assert.equal(skillsPage.total, 1000);
  assert.equal(skillsPage.skills.length, 50);
  assert.equal(skillsPage.next_cursor, "50");

  const mockEvents = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, at: index, type: "status", label: `event-${index + 1}`, detail: "", round: 1, attempt: 1, stage: "testing", current_tool: "Docker" }));
  await fs.mkdir(join(appDir, "work", "auto-learn-runs"), { recursive: true });
  await fs.writeFile(join(appDir, "work", "auto-learn-runs", "fixture-run.json"), JSON.stringify({ id: "fixture-run", status: "completed", events: mockEvents }), "utf8");
  const eventsPage = await (await request("/v1/auto-learn/events?run_id=fixture-run&cursor=0&limit=50")).json();
  assert.equal(eventsPage.events.length, 50);
  assert.equal(eventsPage.next_cursor, 50);
  assert.equal(eventsPage.has_more, true);

  const browserResponse = await request("/v1/tool/execute", {
    name: "browser_action",
    arguments: { action: "snapshot" },
    settings: { browser_mode: "chrome", tool_idle_timeout_seconds: 300 },
  });
  assert.equal(browserResponse.status, 200);
  assert.equal((await browserResponse.json()).title, "Mock Chrome");

  const disconnectedDir = `${appDir}-disconnected`;
  await fs.rename(appDir, disconnectedDir);
  try {
    const disconnectedHealth = await (await request("/v1/health")).json();
    assert.equal(disconnectedHealth.storage_connected, false);
    assert.match(disconnectedHealth.storage_error, /External HDD ไม่พร้อม/);
    const disconnectedTool = await request("/v1/tool/execute", {
      name: "create_files",
      arguments: { project_name: "offline", files: [{ path: "offline.txt", content: "no write" }] },
      settings,
    });
    assert.equal(disconnectedTool.status, 503);
  } finally {
    await fs.rename(disconnectedDir, appDir);
  }
  const reconnectedHealth = await (await request("/v1/health")).json();
  assert.equal(reconnectedHealth.storage_connected, true);
});
