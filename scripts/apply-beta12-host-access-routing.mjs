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

  const helper = [
    `// ${marker}`,
    "async function hostCanAccess(target, mode) {",
    "  try {",
    "    await fs.access(target, mode);",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "async function nearestExistingHostParent(target) {",
    "  let current = resolve(target);",
    "  while (true) {",
    "    try {",
    "      const stat = await fs.lstat(current);",
    "      if (stat.isDirectory()) return current;",
    "      return resolve(current, \"..\");",
    "    } catch (error) {",
    "      if (error?.code !== \"ENOENT\") throw error;",
    "      const parent = resolve(current, \"..\");",
    "      if (parent === current) return current;",
    "      current = parent;",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  source = replaceOnce(
    source,
    "async function hostFs(args = {}, settings = {}) {",
    helper + "async function hostFs(args = {}, settings = {}) {",
    "hostFs helper insertion point",
  );

  source = replaceOnce(
    source,
    "  const target = hostFsAllowed(args.path, settings);\n  let stat;",
    [
      "  const target = hostFsAllowed(args.path, settings);",
      "  if (action === \"access\") {",
      "    try {",
      "      const accessStat = await fs.lstat(target);",
      "      const readable = await hostCanAccess(target, 4);",
      "      const writable = await hostCanAccess(target, 2);",
      "      const executable = await hostCanAccess(target, 1);",
      "      return {",
      "        ok: true,",
      "        host_scope: \"macos\",",
      "        docker_used: false,",
      "        action: \"access\",",
      "        path: target,",
      "        exists: true,",
      "        type: accessStat.isDirectory() ? \"directory\" : accessStat.isFile() ? \"file\" : accessStat.isSymbolicLink() ? \"symlink\" : \"other\",",
      "        readable,",
      "        writable,",
      "        executable,",
      "        creatable: accessStat.isDirectory() ? (writable && executable) : false,",
      "        nearest_existing_parent: accessStat.isDirectory() ? target : resolve(target, \"..\"),",
      "        app_dir: appDir,",
      "      };",
      "    } catch (error) {",
      "      if (error?.code !== \"ENOENT\") throw error;",
      "      const parent = await nearestExistingHostParent(resolve(target, \"..\"));",
      "      const parentWritable = await hostCanAccess(parent, 2);",
      "      const parentExecutable = await hostCanAccess(parent, 1);",
      "      return {",
      "        ok: true,",
      "        host_scope: \"macos\",",
      "        docker_used: false,",
      "        action: \"access\",",
      "        path: target,",
      "        exists: false,",
      "        readable: false,",
      "        writable: false,",
      "        executable: false,",
      "        creatable: parentWritable && parentExecutable,",
      "        nearest_existing_parent: parent,",
      "        parent_writable: parentWritable,",
      "        parent_executable: parentExecutable,",
      "        app_dir: appDir,",
      "      };",
      "    }",
      "  }",
      "  let stat;",
    ].join("\n"),
    "hostFs target/access branch",
  );

  const temp = `${path}.beta12.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatRoute() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const oldDetector = [
    "function hostPathVerificationQuestion(message: string): boolean {",
    "  return /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,45}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,45}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);",
    "}",
  ].join("\n");
  const newDetector = [
    "function hostPathVerificationQuestion(message: string): boolean {",
    "  const legacy = /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,60}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,60}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);",
    "  const absoluteHostPath = /\\/(?:Volumes|Users)\\//i.test(message);",
    "  const hostAccessIntent = /(?:เช็ค|ตรวจ|check|verify|เข้าถึง|access|อ่าน|read|เขียน|write|สิทธิ์|permission|permissions|มีจริง|exists?|อยู่ไหม|สร้างได้ไหม|create|stat|list)/i.test(message);",
    "  return legacy || (absoluteHostPath && hostAccessIntent);",
    "}",
    "",
    `// ${marker}`,
    "function hostPathAccessQuestion(message: string): boolean {",
    "  return /(?:เข้าถึง|access|อ่าน|read|เขียน|write|สิทธิ์|permission|permissions|สร้างได้ไหม|create|writable|readable)/i.test(message);",
    "}",
  ].join("\n");
  source = replaceOnce(source, oldDetector, newDetector, "host path verification detector");

  const replyHeader = "function hostFsVerificationReply(path: string, result: Record<string, unknown>): string {\n";
  const accessReply = [
    "function hostFsVerificationReply(path: string, result: Record<string, unknown>): string {",
    "  if (result.action === \"access\") {",
    "    if (result.exists === false) {",
    "      return (result.creatable === true ? \"✅ HOST_ACCESS\" : \"❌ HOST_ACCESS_DENIED\") + \": \" + path + \" ยังไม่มีอยู่บน macOS host\"",
    "        + \"\\n- creatable: \" + String(result.creatable === true)",
    "        + \"\\n- nearest existing parent: \" + String(result.nearest_existing_parent || \"-\")",
    "        + \"\\n- parent writable: \" + String(result.parent_writable === true)",
    "        + \"\\n- host: macOS\"",
    "        + \"\\n- Docker: ไม่ได้ใช้\";",
    "    }",
    "    return \"✅ HOST_ACCESS: ตรวจสิทธิ์จริงของ \" + String(result.path || path) + \" บน macOS host\"",
    "      + \"\\n- readable: \" + String(result.readable === true)",
    "      + \"\\n- writable: \" + String(result.writable === true)",
    "      + \"\\n- executable/traversable: \" + String(result.executable === true)",
    "      + \"\\n- creatable inside: \" + String(result.creatable === true)",
    "      + \"\\n- Docker: ไม่ได้ใช้\";",
    "  }",
  ].join("\n") + "\n";
  source = replaceOnce(source, replyHeader, accessReply, "hostFs access reply insertion");

  source = replaceOnce(
    source,
    '        const result = await executeTool("host_fs", { action: "stat", path: targetPath }, settings);',
    [
      '        const hostFsAction = hostPathAccessQuestion(message) ? "access" : /(?:รายการ|ข้างใน|ในโฟลเดอร์|list)/i.test(message) ? "list" : "stat";',
      '        const result = await executeTool("host_fs", { action: hostFsAction, path: targetPath }, settings);',
    ].join("\n"),
    "direct host_fs call",
  );

  source = replaceOnce(
    source,
    '      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: "กำลังตรวจ path บน macOS host", tool: "host_fs" });',
    '      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: hostPathAccessQuestion(message) ? "กำลังตรวจสิทธิ์เข้าถึงบน macOS host" : "กำลังตรวจ path บน macOS host", tool: "host_fs" });',
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
