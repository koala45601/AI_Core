import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const patcher = await readFile(new URL("../scripts/apply-beta11-full-host-permission.mjs", import.meta.url), "utf8");

test("beta11 treats full_user_files as persistent Full host permission", () => {
  assert.match(patcher, /fullHostPermission/);
  assert.match(patcher, /file_access_mode/);
  assert.match(patcher, /full_user_files/);
  assert.match(patcher, /persistent Full local permission/);
});

test("beta11 skips repeated run_host_artifact approval only in Full mode", () => {
  assert.match(patcher, /async function runHostArtifact\(args, approved = false, settings = \{\}\)/);
  assert.match(patcher, /if \(!approved && !fullHostPermission\(settings\)\)/);
  assert.match(patcher, /runHostArtifact\(body\.arguments \|\| \{\}, false, body\.settings \|\| \{\}\)/);
  assert.match(patcher, /permission_mode: fullHostPermission\(settings\) \? \\"persistent_full\\"/);
  assert.match(patcher, /approval_skipped: fullHostPermission\(settings\)/);
});

test("beta11 applies Full permission to package setup as well", () => {
  assert.match(patcher, /installPackages\(body\.arguments \|\| \{\}, fullHostPermission\(body\.settings \|\| \{\}\)\)/);
  assert.match(patcher, /installPackage\(body\.arguments \|\| \{\}, fullHostPermission\(body\.settings \|\| \{\}\)\)/);
  assert.match(patcher, /result\.permission_mode = \\"persistent_full\\"/);
  assert.match(patcher, /result\.approval_skipped = true/);
});

test("beta11 explicitly preserves protected-host boundaries", () => {
  assert.match(patcher, /Full permission ไม่ยกเลิกขอบเขตความปลอดภัย/);
  assert.match(patcher, /\.git/);
  assert.match(patcher, /\.env\*/);
  assert.match(patcher, /\.dev\.vars/);
  assert.match(patcher, /symlink escape/);
  assert.match(patcher, /security target ที่อยู่นอก scope/);
});

test("beta11 makes the Settings label match the behavior", () => {
  assert.match(patcher, /Full — ไฟล์ผู้ใช้ทั้งหมด \+ Host actions อัตโนมัติ/);
});
