import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const patcher = await readFile(new URL("../scripts/apply-beta10-host-execution.mjs", import.meta.url), "utf8");

test("beta10 exposes an explicit macOS host execution tool", () => {
  assert.match(patcher, /name: "run_host_artifact"/);
  assert.match(patcher, /execution_scope: "macos_host"/);
  assert.match(patcher, /docker_used: false/);
  assert.match(patcher, /always requires explicit user approval/);
});

test("beta10 host execution uses a validated artifact path and argument array, not shell text", () => {
  assert.match(patcher, /run_host_artifact ต้องใช้ absolute path ของ Artifact/);
  assert.match(patcher, /validateHostArgs/);
  assert.match(patcher, /spawn\(command, args/);
  assert.doesNotMatch(patcher, /runHostProcess[\s\S]*spawn\([^\n]*-c/);
});

test("beta10 host execution is workspace scoped and protects secrets", () => {
  assert.match(patcher, /HOST_ARTIFACT_OUT_OF_WORKSPACE/);
  assert.match(patcher, /HOST_ARTIFACT_PROTECTED/);
  assert.match(patcher, /segments\.includes\("\.git"\)/);
  assert.match(patcher, /leaf === "\.dev\.vars"/);
  assert.match(patcher, /leaf === "\.env"/);
});

test("beta10 routes real Mac interaction away from sandbox-only execution", () => {
  assert.match(patcher, /Sandbox ไม่ใช่สภาพแวดล้อมหลักของอัลฟ่า/);
  assert.match(patcher, /hardware, Wi-Fi\/network interface, local service, installed CLI/);
  assert.match(patcher, /งานทดสอบโค้ดทั่วไป -> Docker; งานที่ต้อง interact กับ Mac จริง -> macOS host หลัง approval/);
});

test("beta10 approval explicitly says the artifact runs on the real Mac", () => {
  assert.match(patcher, /บน Mac เครื่องจริง \(ไม่ใช่ Docker\)/);
  assert.match(patcher, /item\.type === "run_host_artifact"/);
  assert.match(patcher, /await runHostArtifact\(item\.args \|\| \{\}, true\)/);
});
