import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const beta7 = await readFile(new URL("../scripts/apply-beta7-file-workflow-recovery.mjs", import.meta.url), "utf8");
const beta8 = await readFile(new URL("../scripts/apply-beta8-permission-domains.mjs", import.meta.url), "utf8");

test("beta7 returns structured host-native destination errors", () => {
  assert.match(beta7, /FILE_DESTINATION_OUT_OF_SCOPE/);
  assert.match(beta7, /safe_fallback_destination/);
  assert.match(beta7, /host_scope: \\"macos\\"/);
  assert.match(beta7, /docker_used: false/);
});

test("beta7 retries create_files without the rejected destination", () => {
  assert.match(beta7, /delete fallbackArgs\.destination/);
  assert.match(beta7, /executeTool\(\\"create_files\\", fallbackArgs, settings\)/);
  assert.match(beta7, /used_safe_fallback: true/);
  assert.match(beta7, /workflowRequiresArtifact/);
});

test("beta7 forbids model claims that normal file creation is in Docker", () => {
  assert.match(beta7, /ห้ามอ้าง Docker\/container\/sandbox/);
  assert.match(beta7, /ห้ามอ้างว่าไฟล์อยู่ใน Container/);
});

test("beta7 preserves exact-destination intent instead of silently lying", () => {
  assert.match(beta7, /exactDestinationRequired/);
  assert.match(beta7, /exact_destination_required: true/);
});

test("beta8 separates execution isolation from host file authority", () => {
  assert.match(beta8, /code_execution_mode=\\"docker\\"/);
  assert.match(beta8, /create_files, manage_file และ host_fs เป็นเครื่องมือ macOS host/);
  assert.match(beta8, /sandbox เป็นข้อกำหนดเฉพาะตอน “รันโค้ด”/);
});

test("beta8 makes the active app directory a protected host workspace", () => {
  assert.match(beta8, /pathInside\(target, appDir\)/);
  assert.match(beta8, /workspacePathSensitive/);
  assert.match(beta8, /workspace_root: appDir/);
  assert.match(beta8, /file_scope: \\"macos_host\\"/);
  assert.match(beta8, /execution_scope: \\"none\\"/);
  assert.match(beta8, /docker_used: false/);
});