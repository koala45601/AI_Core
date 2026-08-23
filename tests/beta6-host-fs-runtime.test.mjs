import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const agentTools = await readFile(new URL("../lib/agent-tools.ts", import.meta.url), "utf8");
const wrapper = await readFile(new URL("../tool-service/server-wrapper-beta3.mjs", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

test("host_fs tool exists and is explicitly host-only", () => {
  assert.match(agentTools, /name: "host_fs"/);
  assert.match(agentTools, /This tool never launches Docker or Skill Lab/);
  assert.match(agentTools, /ต้องใช้ host_fs บน macOS host โดยตรง/);
});

test("host_fs implementation is read-only and never calls Docker", () => {
  const start = wrapper.indexOf("async function hostFs(");
  const end = wrapper.indexOf("async function systemCapability(", start);
  assert.ok(start >= 0 && end > start, "hostFs implementation must exist before systemCapability");
  const section = wrapper.slice(start, end);
  assert.match(section, /docker_used: false/);
  assert.match(section, /fs\.lstat/);
  assert.match(section, /fs\.readdir/);
  assert.doesNotMatch(section, /ensureDocker|dockerReady|spawn\([^)]*docker|run_learned_skill|run_artifact/);
});

test("path verification bypasses the model planner and calls host_fs directly", () => {
  assert.match(route, /function hostPathVerificationQuestion/);
  assert.match(route, /executeTool\("host_fs", \{ action: "stat", path: targetPath \}, settings\)/);
  const verifyStart = route.indexOf("if (hostPathVerificationQuestion(message))");
  const artifactStart = route.indexOf("if (artifactLocationQuestion(message))", verifyStart);
  assert.ok(verifyStart >= 0 && artifactStart > verifyStart, "host verification must run before artifact-location shortcut");
});

test("host wrapper exposes filesystem readiness and intercepts host_fs", () => {
  assert.match(wrapper, /host_filesystem_ready: true/);
  assert.match(wrapper, /if \(name === "host_fs"\) return json\(response, 200, await hostFs/);
});
