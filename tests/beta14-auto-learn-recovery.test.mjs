import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd());
const text = (path) => fs.readFile(resolve(root, path), "utf8");

async function copyFixture(target, relativePath) {
  const destination = resolve(target, relativePath);
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.copyFile(resolve(root, relativePath), destination);
}

test("worker initializers stay numeric and non-self-referential after patching", async () => {
  const temporary = await fs.mkdtemp(resolve(tmpdir(), "alpha-beta14-beta5-"));
  try {
    await copyFixture(temporary, "lib/ollama.ts");
    await execFileAsync(process.execPath, [resolve(root, "scripts/apply-beta5-adaptive-reasoning.mjs"), temporary]);
    const patched = await fs.readFile(resolve(temporary, "lib/ollama.ts"), "utf8");
    assert.doesNotMatch(patched, /deepWorkerOptions\(settings, deepWorker\.numPredict\)/);
    const initializers = [...patched.matchAll(/const deepWorker = ([^\n]+);/g)].map((match) => match[1]);
    assert.equal(initializers.length, 4);
    assert.match(initializers[0], /2600|numPredict: Math\.min\(1200/);
    assert.match(initializers[1], /3000|numPredict: Math\.min\(1000/);
    assert.match(initializers[2], /4200|numPredict: Math\.min\(3200/);
    assert.match(initializers[3], /settings\.max_output_tokens, 1200/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("beta14 repairs an already-patched legacy runtime", async () => {
  const temporary = await fs.mkdtemp(resolve(tmpdir(), "alpha-beta14-repair-"));
  const fixtureFiles = [
    "lib/ollama.ts",
    "app/api/train/route.ts",
    "tool-service/server.mjs",
    "app/page.tsx",
    "app/api/chat/route.ts",
    "lib/agent-tools.ts",
    "lib/types.ts",
    "package.json",
  ];
  try {
    await Promise.all(fixtureFiles.map((path) => copyFixture(temporary, path)));
    await execFileAsync(process.execPath, [resolve(root, "scripts/apply-beta5-adaptive-reasoning.mjs"), temporary]);
    const ollamaPath = resolve(temporary, "lib/ollama.ts");
    const broken = (await fs.readFile(ollamaPath, "utf8")).replace(
      /const deepWorker = [^\n]+;/g,
      "const deepWorker = deepWorkerOptions(settings, deepWorker.numPredict);",
    );
    assert.equal((broken.match(/deepWorkerOptions\(settings, deepWorker\.numPredict\)/g) || []).length, 4);
    await fs.writeFile(ollamaPath, broken, "utf8");
    await execFileAsync(process.execPath, [resolve(root, "scripts/apply-beta14-auto-learn-recovery.mjs"), temporary]);
    const repaired = await fs.readFile(ollamaPath, "utf8");
    assert.doesNotMatch(repaired, /deepWorkerOptions\(settings, deepWorker\.numPredict\)/);
    assert.match(repaired, /const deepWorker = \{ think: false, numCtx: Math\.min\(settings\.max_context_tokens, 4096\), numPredict: Math\.min\(1200/);
    assert.match(repaired, /num_predict: deepWorker\.numPredict/);
    assert.equal(JSON.parse(await fs.readFile(resolve(temporary, "package.json"), "utf8")).version, "1.1.0-beta.14");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Auto Learn repairs inside one pipeline and never restarts it automatically", async () => {
  const [server, train, page, ollama] = await Promise.all([
    text("tool-service/server.mjs"),
    text("app/api/train/route.ts"),
    text("app/page.tsx"),
    text("lib/ollama.ts"),
  ]);
  assert.match(server, /const retryFailures = new Map\(\)/);
  assert.match(server, /if \(job\.retry_requested\)/);
  assert.doesNotMatch(server, /retry <= retryLimit/);
  assert.match(server, /Only an explicit user Retry/);
  assert.match(server, /skill_pipeline_deferred/);
  assert.match(server, /const effectiveSkillFrequency = installedInThisRun \? job\.skill_frequency : 1/);
  assert.match(server, /Auto Learn จะยังไม่ถือว่าสำเร็จจนกว่าจะมีสกิลที่ผ่าน test และติดตั้งจริง/);
  assert.match(server, /outcome: installedSkillFindings\.length > 0 \? "success" : "no_skill_installed"/);
  assert.match(server, /failure_count: failureCount/);
  assert.match(server, /deferred_until: Date\.now\(\) \+ deferMinutes \* 60_000/);
  assert.match(server, /const readyBacklog = skillBacklog/);
  assert.match(server, /relevance >= 0\.08/);
  assert.match(server, /const shouldBuildSkill = skillFrequency > 0/);
  assert.match(server, /fallbackAutoLearnTopic\(job\.focus_context, \[\.\.\.history, \.\.\.job\.findings\], cycle, effectiveSkillFrequency\)/);
  assert.match(train, /sameInfrastructureFailures < 3/);
  assert.match(train, /const needsExternalEvidence =/);
  assert.match(train, /ข้าม web research และเริ่มสร้างสกิลทันที/);
  assert.match(train, /stdout: String\(record\.stdout \|\| ""\)\.slice\(0, 2000\)/);
  assert.match(train, /checks: item\.checks, stdout: item\.stdout/);
  assert.match(train, /function repairEntrypointContract/);
  assert.match(train, /ซ่อม entrypoint contract ที่พิสูจน์ได้ก่อนทดสอบ/);
  assert.match(train, /skill: plan\.skill, files: previousFiles, hidden_test_cases: hiddenTests/);
  assert.match(ollama, /format: skillPlanSchema/);
  assert.match(ollama, /format: hiddenTestsSchema/);
  assert.match(ollama, /format: skillBuildSchema/);
  assert.match(ollama, /argv\[1\] คือ JSON serialization ของ test\.input ทั้ง object/);
  assert.match(ollama, /Python entrypoint ต้องเรียก main ด้วย if __name__ == "__main__":/);
  assert.match(ollama, /const sourceBudget = 16_000/);
  assert.match(ollama, /source middle omitted from repair prompt/);
  assert.match(ollama, /function balancedJsonCandidates/);
  assert.match(ollama, /num_predict: Math\.min\(1200, settings\.max_output_tokens\)/);
  assert.match(page, /latestInstalledSkillEvent/);
  assert.match(page, /void loadSkills\(true\)/);
});

test("requested security skills are verified dual-runtime installers", async () => {
  const [installer, chat, tools] = await Promise.all([
    text("scripts/install-security-skills.mjs"),
    text("app/api/chat/route.ts"),
    text("lib/agent-tools.ts"),
  ]);
  for (const id of [
    "authorized-api-traffic-analyzer",
    "system-access-capability-mapper",
    "cybersecurity-audit-prioritizer",
    "web-api-contract-discovery",
    "concert-ticket-purchase-assistant",
  ]) assert.match(installer, new RegExp(id));
  assert.match(installer, /name: "skill_lab_test"/);
  assert.match(installer, /hidden_test_cases/);
  assert.match(installer, /verification_status !== "verified"/);
  assert.match(installer, /execution_targets: \["sandbox", "macos_host"\]/);
  assert.match(installer, /id: "concert-ticket-purchase-assistant"[\s\S]+?execution_targets: \["macos_host"\]/);
  assert.match(installer, /needs_event_selection/);
  assert.match(installer, /available_event_choices/);
  assert.match(installer, /selected_event_id/);
  assert.match(installer, /def choose_ticket\(page\):/);
  assert.match(installer, /availableSeat/);
  assert.match(installer, /mode == "reserved"/);
  assert.match(installer, /project\.joinpath\("bot\.py"\)/);
  assert.match(installer, /project\.joinpath\("requirements\.txt"\)/);
  assert.match(installer, /project\.joinpath\("start\.command"\)/);
  assert.match(installer, /for \(const executionTarget of item\.skill\.execution_targets\)/);
  assert.match(chat, /return parseEmbeddedJson\(message\)/);
  assert.match(tools, /ผู้ใช้ระบุเป้าหมายปลายทางได้โดยไม่ต้องเลือกวิธี/);
  assert.match(tools, /inspect_events/);
  assert.match(tools, /inspect_form/);
  assert.match(chat, /const ticketBuilderIntent =/);
  assert.match(chat, /ticketBotAction\(\{ action: "inspect", url \}\)/);
  assert.match(chat, /pending_ticket_events/);
  assert.match(tools, /ไม่จำกัดภาษา เฟรมเวิร์ก library runtime/);
});

test("learned skill runner selects macOS host only for dual-runtime skills in Full mode", async () => {
  const [server, types] = await Promise.all([text("tool-service/server.mjs"), text("lib/types.ts")]);
  assert.match(server, /async function runSkillHost\(/);
  assert.match(server, /settings\.file_access_mode === "full_user_files"/);
  assert.match(server, /requestedTarget !== "auto" && !targets\.includes\(requestedTarget\)/);
  assert.match(server, /สกิลนี้รันบน macOS host เท่านั้น/);
  assert.match(server, /executionTarget === "macos_host"/);
  assert.match(server, /last_execution_target: executionTarget/);
  assert.match(server, /ALPHA_PROGRAM_CREATE_DIR: programCreateDir/);
  assert.match(server, /async function inspectBrowserForm\(page\)/);
  assert.match(server, /needs_user_clarification: ambiguous_roles\.length > 0/);
  assert.match(server, /const programCreateDir = resolve\(appDir, "Program_Create"\)/);
  assert.match(server, /async function inspectBrowserEvents\(page\)/);
  assert.match(server, /skipTestOutput && relativePath === "\.test-output"/);
  assert.match(server, /entry\.name\.startsWith\("\._"\)/);
  assert.match(server, /entry\.name === "\.DS_Store"/);
  assert.match(server, /listFilesRecursive\(candidateDirectory, "", true\)/);
  assert.match(server, /fs\.access\(join\(destination, skill\.entrypoint\)\)/);
  assert.match(server, /while \(await fs\.access\(requestedDestination\)/);
  assert.match(types, /execution_targets\?: Array<"sandbox" \| "macos_host">/);
});

test("Beta14 launcher applies every runtime patch and installs missing core skills", async () => {
  const [pkg, launcher, changelog] = await Promise.all([
    text("package.json"),
    text("start-alpha-v11.command"),
    text("CHANGELOG.md"),
  ]);
  assert.equal(JSON.parse(pkg).version, "1.1.0-beta.25");
  const beta13 = launcher.indexOf("apply-beta13-nonblocking-post-response.mjs");
  const beta14 = launcher.indexOf("apply-beta14-auto-learn-recovery.mjs");
  const ticket = launcher.indexOf('"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta14-ticket-workflow.mjs" "$ALPHA_DIR"');
  assert.ok(beta13 >= 0 && beta14 > beta13 && ticket > beta14);
  assert.match(launcher, /ALPHA_REQUIRED_SKILLS=/);
  assert.match(launcher, /if \[\[ ! -f "\$ALPHA_SKILL_ROOT\/\$ALPHA_SKILL_ID\/alpha-skill\.json" \]\]/);
  assert.match(launcher, /scripts\/install-security-skills\.mjs/);
  assert.match(changelog, /1\.1\.0-beta\.14/);
});
