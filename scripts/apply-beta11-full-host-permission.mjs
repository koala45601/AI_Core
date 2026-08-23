import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta11-full-host-permission-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function patchAgentTools() {
  const path = resolve(appDir, "lib", "agent-tools.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  source = replaceOnce(
    source,
    "This is not Docker and always requires explicit user approval. Do not use it for ordinary unit/syntax tests that belong in run_artifact.",
    "This is not Docker. When Settings uses Full user-file access (`full_user_files`), persistent local authority is already granted and repeated host-action approval is skipped; otherwise this tool requests approval. Do not use it for ordinary unit/syntax tests that belong in run_artifact.",
    "run_host_artifact approval wording",
  );

  const instructionNeedle = "- run_host_artifact และ run_artifact เป็นคนละ execution domain: งานทดสอบโค้ดทั่วไป -> Docker; งานที่ต้อง interact กับ Mac จริง -> macOS host หลัง approval\n";
  source = replaceOnce(
    source,
    instructionNeedle,
    instructionNeedle
      + `- ${marker}: ถ้า file_access_mode=full_user_files ให้ถือว่าเป็น persistent Full local permission สำหรับ host actions ที่ผ่าน validation แล้ว: run_host_artifact และ install_package/install_packages ทำต่อได้ทันทีโดยไม่สร้าง approval ซ้ำ\n`
      + "- Full permission ไม่ยกเลิกขอบเขตความปลอดภัยของระบบ: ยังต้องบล็อก .git, .env*, .dev.vars, macOS system roots, symlink escape, invalid artifact, invalid package/formula และ security target ที่อยู่นอก scope\n"
      + "- ถ้าไม่ใช่ full_user_files ให้ใช้ approval flow เดิม และแสดง WAITING_APPROVAL ให้ชัดเจน\n",
    "host execution instruction",
  );

  const temp = `${path}.beta11.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchWrapper() {
  const path = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const functionNeedle = "async function runHostArtifact(args, approved = false) {";
  const functionReplacement = `// ${marker}\nfunction fullHostPermission(settings = {}) {\n  return String(settings?.file_access_mode || \"\") === \"full_user_files\";\n}\n\nasync function runHostArtifact(args, approved = false, settings = {}) {`;
  source = replaceOnce(source, functionNeedle, functionReplacement, "runHostArtifact signature");

  source = replaceOnce(
    source,
    "  if (!approved) {\n    const id = await queueHostArtifactConfirmation(args, artifact);",
    "  if (!approved && !fullHostPermission(settings)) {\n    const id = await queueHostArtifactConfirmation(args, artifact);",
    "runHostArtifact approval gate",
  );

  source = replaceOnce(
    source,
    "    docker_used: false,\n    resume: result.code === 0,",
    "    docker_used: false,\n    permission_mode: fullHostPermission(settings) ? \"persistent_full\" : (approved ? \"approved_once\" : \"default\"),\n    approval_skipped: fullHostPermission(settings),\n    resume: result.code === 0,",
    "host execution permission result metadata",
  );

  source = replaceOnce(
    source,
    "        const result = await runHostArtifact(body.arguments || {}, false);",
    "        const result = await runHostArtifact(body.arguments || {}, false, body.settings || {});",
    "run_host_artifact execute settings",
  );

  source = replaceOnce(
    source,
    "        const result = await installPackages(body.arguments || {}, false);",
    "        const result = await installPackages(body.arguments || {}, fullHostPermission(body.settings || {}));\n        if (fullHostPermission(body.settings || {}) && result && typeof result === \"object\") {\n          result.permission_mode = \"persistent_full\";\n          result.approval_skipped = true;\n        }",
    "install_packages Full permission",
  );

  source = replaceOnce(
    source,
    "        const result = await installPackage(body.arguments || {}, false);",
    "        const result = await installPackage(body.arguments || {}, fullHostPermission(body.settings || {}));\n        if (fullHostPermission(body.settings || {}) && result && typeof result === \"object\") {\n          result.permission_mode = \"persistent_full\";\n          result.approval_skipped = true;\n        }",
    "install_package Full permission",
  );

  const temp = `${path}.beta11.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchSettingsUi() {
  const path = resolve(appDir, "app", "page.tsx");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  source = replaceOnce(
    source,
    '<option value="full_user_files">ไฟล์ผู้ใช้ทั้งหมด</option>',
    `<option value="full_user_files">Full — ไฟล์ผู้ใช้ทั้งหมด + Host actions อัตโนมัติ</option>{/* ${marker} */}`,
    "Full file access option label",
  );

  const temp = `${path}.beta11.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchAgentTools();
await patchWrapper();
await patchSettingsUi();
console.log("Applied Alpha beta11 Full permission: persistent Full access suppresses repeated host-action approvals");
