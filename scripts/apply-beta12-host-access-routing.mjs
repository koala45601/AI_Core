import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta12-host-access-routing-v1";

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
    'action: { type: "string", enum: ["exists", "stat", "list"] },',
    `action: { type: "string", enum: ["exists", "stat", "list", "access"] }, // ${marker}`,
    "host_fs action enum",
  );

  source = replaceOnce(
    source,
    "Read-only inspection of files and directories on the macOS host. Use this for file existence, path verification, stat/metadata, and directory listing. This tool never launches Docker or Skill Lab.",
    "Read-only inspection of files and directories on the macOS host. Use this for file existence, path verification, stat/metadata, directory listing, and real read/write/create access checks. This tool never launches Docker or Skill Lab.",
    "host_fs description",
  );

  const instructionNeedle = "- ถ้า host_fs คืน exists=false ให้รายงาน NOT_FOUND ตามจริง ห้ามเดาว่า External Drive หลุด; ถ้า path อยู่ใต้ appDir ที่ Alpha กำลังรันอยู่ ให้ถือว่า storage state ต้องยืนยันจาก host tool เท่านั้น\n";
  source = replaceOnce(
    source,
    instructionNeedle,
    instructionNeedle
      + `- ${marker}: คำถามเรื่องการเข้าถึง/read/write/permission/create capability ของ /Volumes/... หรือ /Users/... ต้องเชื่อผล host_fs action=access เท่านั้น; ห้ามอ้างว่า Sandbox/Docker ทำให้แตะ Host ไม่ได้ถ้า host_fs ยังไม่ได้คืน error จริง\n`
      + "- เมื่อ host_filesystem_ready=true ห้ามบอกให้ผู้ใช้ไปเปิด Terminal เพียงเพื่อเช็ค path/access ที่ host_fs ตรวจได้เอง\n",
    "host_fs authority instruction",
  );

  const temp = `${path}.beta12.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchWrapper() {
  const path = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  source = replaceOnce(
    source,
    'const action = new Set(["exists", "stat", "list"]).has(String(args.action)) ? String(args.action) : "stat";',
    `const action = new Set(["exists", "stat", "list", "access"]).has(String(args.action)) ? String(args.action) : "stat"; // ${marker}`,
    "hostFs action set",
  );

  const hostFsNeedle = "async function hostFs(args = {}, settings = {}) {\n  const action =";
  if (!source.includes(hostFsNeedle)) throw new Error("หา hostFs function ไม่พบ");

  const helper = `// ${marker}\nasync function hostCanAccess(target, mode) {\n  try {\n    await fs.access(target, mode);\n    return true;\n  } catch {\n    return false;\n  }\n}\n\nasync function nearestExistingHostParent(target) {\n  let current = resolve(target);\n  while (true) {\n    try {\n      const stat = await fs.lstat(current);\n      if (stat.isDirectory()) return current;\n      return resolve(current, "..");\n    } catch (error) {\n      if (error?.code !== "ENOENT") throw error;\n      const parent = resolve(current, "..");\n      if (parent === current) return current;\n      current = parent;\n    }\n  }\n}\n\n`;
  source = source.replace("async function hostFs(args = {}, settings = {}) {", helper + "async function hostFs(args = {}, settings = {}) {");

  const targetNeedle = "  const target = hostFsAllowed(args.path, settings);\n  let stat;";
  const accessBranch = `  const target = hostFsAllowed(args.path, settings);\n  if (action === "access") {\n    try {\n      const accessStat = await fs.lstat(target);\n      const readable = await hostCanAccess(target, 4);\n      const writable = await hostCanAccess(target, 2);\n      const executable = await hostCanAccess(target, 1);\n      return {\n        ok: true,\n        host_scope: "macos",\n        docker_used: false,\n        action: "access",\n        path: target,\n        exists: true,\n        type: accessStat.isDirectory() ? "directory" : accessStat.isFile() ? "file" : accessStat.isSymbolicLink() ? "symlink" : "other",\n        readable,\n        writable,\n        executable,\n        creatable: accessStat.isDirectory() ? (writable && executable) : false,\n        nearest_existing_parent: accessStat.isDirectory() ? target : resolve(target, ".."),\n        app_dir: appDir,\n      };\n    } catch (error) {\n      if (error?.code !== "ENOENT") throw error;\n      const parent = await nearestExistingHostParent(resolve(target, ".."));\n      const parentWritable = await hostCanAccess(parent, 2);\n      const parentExecutable = await hostCanAccess(parent, 1);\n      return {\n        ok: true,\n        host_scope: "macos",\n        docker_used: false,\n        action: "access",\n        path: target,\n        exists: false,\n        readable: false,\n        writable: false,\n        executable: false,\n        creatable: parentWritable && parentExecutable,\n        nearest_existing_parent: parent,\n        parent_writable: parentWritable,\n        parent_executable: parentExecutable,\n        app_dir: appDir,\n      };\n    }\n  }\n  let stat;`;
  source = replaceOnce(source, targetNeedle, accessBranch, "hostFs target/access branch");

  const temp = `${path}.beta12.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatRoute() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const oldDetector = `function hostPathVerificationQuestion(message: string): boolean {\n  return /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,45}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,45}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);\n}`;
  const newDetector = `function hostPathVerificationQuestion(message: string): boolean {\n  const legacy = /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,60}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,60}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);\n  const absoluteHostPath = /\\/(?:Volumes|Users)\\//i.test(message);\n  const hostAccessIntent = /(?:เช็ค|ตรวจ|check|verify|เข้าถึง|access|อ่าน|read|เขียน|write|สิทธิ์|permission|permissions|มีจริง|exists?|อยู่ไหม|สร้างได้ไหม|create|stat|list)/i.test(message);\n  return legacy || (absoluteHostPath && hostAccessIntent);\n}\n\n// ${marker}\nfunction hostPathAccessQuestion(message: string): boolean {\n  return /(?:เข้าถึง|access|อ่าน|read|เขียน|write|สิทธิ์|permission|permissions|สร้างได้ไหม|create|writable|readable)/i.test(message);\n}`;
  source = replaceOnce(source, oldDetector, newDetector, "host path verification detector");

  const oldReply = `function hostFsVerificationReply(path: string, result: Record<string, unknown>): string {\n  if (result.exists === false) return "❌ NOT_FOUND: ไม่พบไฟล์หรือโฟลเดอร์ที่ \\`" + path + "\\` บน macOS host จากการตรวจจริง (ไม่ได้ใช้ Docker)";\n  return "✅ EXISTS: พบ " + String(result.type || "path") + " จริงที่ \\`" + String(result.path || path) + "\\` บน macOS host\\n- size: " + String(result.size ?? "-") + " bytes\\n- permission: " + String(result.mode ?? "-") + "\\n- modified: " + String(result.mtime ?? "-") + "\\n- Docker: ไม่ได้ใช้";\n}`;
  const newReply = `function hostFsVerificationReply(path: string, result: Record<string, unknown>): string {\n  if (result.action === "access") {\n    if (result.exists === false) {\n      return (result.creatable === true ? "✅ HOST_ACCESS" : "❌ HOST_ACCESS_DENIED") + ": \\`" + path + "\\` ยังไม่มีอยู่บน macOS host"\n        + "\\n- creatable: " + String(result.creatable === true)\n        + "\\n- nearest existing parent: \\`" + String(result.nearest_existing_parent || "-") + "\\`"\n        + "\\n- parent writable: " + String(result.parent_writable === true)\n        + "\\n- host: macOS"\n        + "\\n- Docker: ไม่ได้ใช้";\n    }\n    return "✅ HOST_ACCESS: ตรวจสิทธิ์จริงของ \\`" + String(result.path || path) + "\\` บน macOS host"\n      + "\\n- readable: " + String(result.readable === true)\n      + "\\n- writable: " + String(result.writable === true)\n      + "\\n- executable/traversable: " + String(result.executable === true)\n      + "\\n- creatable inside: " + String(result.creatable === true)\n      + "\\n- Docker: ไม่ได้ใช้";\n  }\n  if (result.exists === false) return "❌ NOT_FOUND: ไม่พบไฟล์หรือโฟลเดอร์ที่ \\`" + path + "\\` บน macOS host จากการตรวจจริง (ไม่ได้ใช้ Docker)";\n  return "✅ EXISTS: พบ " + String(result.type || "path") + " จริงที่ \\`" + String(result.path || path) + "\\` บน macOS host\\n- size: " + String(result.size ?? "-") + " bytes\\n- permission: " + String(result.mode ?? "-") + "\\n- modified: " + String(result.mtime ?? "-") + "\\n- Docker: ไม่ได้ใช้";\n}`;
  source = replaceOnce(source, oldReply, newReply, "hostFs verification reply");

  const oldCall = `        const result = await executeTool("host_fs", { action: "stat", path: targetPath }, settings);`;
  const newCall = `        const hostFsAction = hostPathAccessQuestion(message) ? "access" : /(?:รายการ|ข้างใน|ในโฟลเดอร์|list)/i.test(message) ? "list" : "stat";\n        const result = await executeTool("host_fs", { action: hostFsAction, path: targetPath }, settings);`;
  source = replaceOnce(source, oldCall, newCall, "direct host_fs call");

  source = replaceOnce(
    source,
    `      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: "กำลังตรวจ path บน macOS host", tool: "host_fs" });`,
    `      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: hostPathAccessQuestion(message) ? "กำลังตรวจสิทธิ์เข้าถึงบน macOS host" : "กำลังตรวจ path บน macOS host", tool: "host_fs" });`,
    "host_fs run label",
  );

  const temp = `${path}.beta12.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchAgentTools();
await patchWrapper();
await patchChatRoute();
console.log("Applied Alpha beta12: deterministic macOS host access/read/write/path routing");
