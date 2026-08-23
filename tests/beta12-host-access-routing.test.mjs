import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const agentTools = await readFile(new URL("../lib/agent-tools.ts", import.meta.url), "utf8");
const wrapper = await readFile(new URL("../tool-service/server-wrapper-beta3.mjs", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

test("host_fs exposes real host access probing", () => {
  assert.match(agentTools, /enum: \["exists", "stat", "list", "access"\]/);
  assert.match(agentTools, /real read\/write\/create access checks/);
  assert.match(wrapper, /new Set\(\["exists", "stat", "list", "access"\]\)/);
  assert.match(wrapper, /async function hostCanAccess/);
  assert.match(wrapper, /nearestExistingHostParent/);
  assert.match(wrapper, /parent_writable/);
  assert.match(wrapper, /creatable:/);
});

test("host access probing stays on macOS and does not invoke Docker", () => {
  const start = wrapper.indexOf("async function hostCanAccess(");
  const end = wrapper.indexOf("async function systemCapability(", start);
  assert.ok(start >= 0 && end > start, "beta12 host access section must exist");
  const section = wrapper.slice(start, end);
  assert.match(section, /host_scope: "macos"/);
  assert.match(section, /docker_used: false/);
  assert.doesNotMatch(section, /ensureDocker|dockerReady|docker compose|run_artifact|run_learned_skill/);
});

test("Thai access-path prompt is intercepted before the model planner", () => {
  assert.match(route, /function hostPathAccessQuestion/);
  assert.match(route, /เข้าถึง\|access\|อ่าน\|read\|เขียน\|write\|สิทธิ์\|permission/);
  assert.match(route, /hostPathAccessQuestion\(message\) \? "access"/);
  assert.match(route, /executeTool\("host_fs", \{ action: hostFsAction, path: targetPath \}, settings\)/);
  const verifyStart = route.indexOf("if (hostPathVerificationQuestion(message))");
  const plannerStart = route.indexOf("shouldPlanTools", verifyStart);
  assert.ok(verifyStart >= 0, "deterministic host verification block must exist");
  assert.ok(plannerStart === -1 || verifyStart < plannerStart, "host path access check must run before normal planner flow");
});

test("host access response cannot claim Sandbox-only execution", () => {
  const replyStart = route.indexOf("function hostFsVerificationReply");
  const replyEnd = route.indexOf("function artifactLocationQuestion", replyStart);
  assert.ok(replyStart >= 0 && replyEnd > replyStart);
  const section = route.slice(replyStart, replyEnd);
  assert.match(section, /HOST_ACCESS/);
  assert.match(section, /Docker: ไม่ได้ใช้/);
  assert.doesNotMatch(section, /Sandbox|mount volume|Terminal/);
});
