import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const patcher = await readFile(new URL("../scripts/apply-beta7-file-workflow-recovery.mjs", import.meta.url), "utf8");

test("beta7 returns structured host-native destination errors", () => {
  assert.match(patcher, /FILE_DESTINATION_OUT_OF_SCOPE/);
  assert.match(patcher, /safe_fallback_destination/);
  assert.match(patcher, /host_scope: \\"macos\\"/);
  assert.match(patcher, /docker_used: false/);
});

test("beta7 retries create_files without the rejected destination", () => {
  assert.match(patcher, /delete fallbackArgs\.destination/);
  assert.match(patcher, /executeTool\(\\"create_files\\", fallbackArgs, settings\)/);
  assert.match(patcher, /used_safe_fallback: true/);
  assert.match(patcher, /workflowRequiresArtifact/);
});

test("beta7 forbids model claims that normal file creation is in Docker", () => {
  assert.match(patcher, /ห้ามอ้าง Docker\/container\/sandbox/);
  assert.match(patcher, /ห้ามอ้างว่าไฟล์อยู่ใน Container/);
});

test("beta7 preserves exact-destination intent instead of silently lying", () => {
  assert.match(patcher, /exactDestinationRequired/);
  assert.match(patcher, /exact_destination_required: true/);
});
