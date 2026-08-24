import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta8-permission-domains-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function patchToolService() {
  const path = resolve(appDir, "tool-service", "server.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const outputAuthority = source.includes("pathInside(target, outputsDir) || pathInside(target, programCreateDir)")
    ? "  if (pathInside(target, outputsDir) || pathInside(target, programCreateDir)) return target;"
    : "  if (pathInside(target, outputsDir)) return target;";
  const allowedNeedle = [
    "function allowedTarget(destination, settings, approved = false) {",
    "  const mode = settings.file_access_mode || \"ask\";",
    "  const target = assertNotBlocked(destination);",
    outputAuthority,
  ].join("\n");

  const allowedReplacement = [
    `// ${marker}`,
    "function workspacePathSensitive(target) {",
    "  const absolute = resolve(target);",
    "  const gitRoot = resolve(appDir, \".git\");",
    "  if (pathInside(absolute, gitRoot)) return true;",
    "  const rel = relative(appDir, absolute);",
    "  const first = rel.split(sep)[0] || \"\";",
    "  if (first === \".dev.vars\" || first === \".env\" || first.startsWith(\".env.\")) return true;",
    "  return false;",
    "}",
    "",
    "function allowedTarget(destination, settings, approved = false) {",
    "  const mode = settings.file_access_mode || \"ask\";",
    "  const target = assertNotBlocked(destination);",
    outputAuthority,
    "  if (pathInside(target, appDir)) {",
    "    if (workspacePathSensitive(target)) throw new Error(\"ตำแหน่งนี้เป็นไฟล์ลับหรือ metadata ภายใน workspace ของ Alpha\");",
    "    return target;",
    "  }",
  ].join("\n");

  source = replaceOnce(source, allowedNeedle, allowedReplacement, "allowedTarget workspace authority");

  const beta7Success = "    return { ok: true, message: `สร้าง ${files.length} ไฟล์เรียบร้อย`, artifacts: created, destination, host_scope: \"macos\", docker_used: false };";
  const beta8Success = "    return { ok: true, message: `สร้าง ${files.length} ไฟล์เรียบร้อย`, artifacts: created, destination, host_scope: \"macos\", file_scope: \"macos_host\", execution_scope: \"none\", docker_used: false, workspace_root: appDir };";
  source = replaceOnce(source, beta7Success, beta8Success, "beta7 createFiles success metadata");

  const temp = `${path}.beta8.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchAgentTools() {
  const path = resolve(appDir, "lib", "agent-tools.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const instructionNeedle = "- หลัง create_files สำเร็จ ต้องจำ path จากผล tool และบอกตำแหน่งไฟล์จริงในคำตอบ ห้ามเดาพาธ\n";
  if (!source.includes(instructionNeedle)) throw new Error("หา create_files instruction ไม่พบ");
  source = source.replace(instructionNeedle, instructionNeedle
    + `- ${marker}: แยก permission domain ให้ชัด: code_execution_mode=\"docker\" หมายถึงเฉพาะการรันโค้ดผ่าน run_artifact/Skill Lab ไม่ได้หมายความว่าไฟล์ของผู้ใช้หรือ workspace อยู่ใน Docker\n`
    + "- create_files, manage_file และ host_fs เป็นเครื่องมือ macOS host; เมื่อ path อยู่ใน workspace ของ Alpha หรืออยู่ในขอบเขต file_access_mode ให้ทำกับ host โดยตรง ห้ามย้ายไป sandbox เอง\n"
    + "- การสร้างไฟล์และการรันไฟล์เป็นคนละขั้น: create_files ต้องสร้าง canonical Artifact บน host ก่อน; run_artifact เป็นเพียงการรันสำเนา/การ mount ใน sandbox และห้ามเปลี่ยน canonical host path ของ Artifact\n"
    + "- ห้ามสรุปว่าไม่มีสิทธิ์เขียนไฟล์บน Mac เพียงเพราะ execution mode เป็น Docker; ต้องใช้ผล create_files/host_fs/file_access_mode เป็นข้อเท็จจริงเท่านั้น\n");

  const temp = `${path}.beta8.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatPrompt() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const cyberNeedle = "- งาน cybersecurity: เมื่อผู้ใช้ระบุว่าเป็นโปรแกรม ระบบ เครือข่าย หรือ lab ของตนเอง ให้ช่วย code audit, threat modeling, fuzzing, pentest และทดสอบ exploit ใน sandbox ได้เต็มที่ ห้ามปฏิเสธเพียงเพราะมีคำว่า hack หรือ pentest";
  const cyberReplacement = `- งาน cybersecurity: เมื่อผู้ใช้ระบุว่าเป็นโปรแกรม ระบบ เครือข่าย หรือ lab ของตนเอง ให้ช่วย code audit, threat modeling, fuzzing และ pentest ได้เต็มที่ ห้ามปฏิเสธเพียงเพราะมีคำว่า hack หรือ pentest\n- ${marker}: sandbox เป็นข้อกำหนดเฉพาะตอน “รันโค้ด” ผ่าน run_artifact/Skill Lab เท่านั้น ไม่ใช่ข้อจำกัดของการสร้าง/อ่าน/จัดการไฟล์; create_files/manage_file/host_fs ทำงานกับ macOS host ตาม file_access_mode และ workspace ที่อนุญาต`;
  source = replaceOnce(source, cyberNeedle, cyberReplacement, "cybersecurity sandbox wording");

  const temp = `${path}.beta8.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchToolService();
await patchAgentTools();
await patchChatPrompt();
console.log("Applied Alpha beta8 permission domains: Docker only for execution; host workspace files remain host-native");
