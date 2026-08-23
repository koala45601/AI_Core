import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta6-host-filesystem-v1";

async function patchAgentTools() {
  const path = resolve(appDir, "lib", "agent-tools.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const insertBefore = `  {\n    type: "function",\n    function: {\n      name: "manage_file",`;
  if (!source.includes(insertBefore)) throw new Error("หา manage_file schema ไม่พบ");
  const tool = `  // ${marker}\n  {\n    type: "function",\n    function: {\n      name: "host_fs",\n      description: "Read-only inspection of files and directories on the macOS host. Use this for file existence, path verification, stat/metadata, and directory listing. This tool never launches Docker or Skill Lab.",\n      parameters: {\n        type: "object",\n        required: ["action", "path"],\n        properties: {\n          action: { type: "string", enum: ["exists", "stat", "list"] },\n          path: { type: "string", description: "Absolute macOS host path to inspect" },\n          max_entries: { type: "number", description: "Maximum directory entries for list; defaults to 100 and caps at 200" },\n        },\n      },\n    },\n  },\n`;
  source = source.replace(insertBefore, tool + insertBefore);

  const labelNeedle = `export const TOOL_LABELS: Record<string, string> = {\n`;
  if (!source.includes(labelNeedle)) throw new Error("หา TOOL_LABELS ไม่พบ");
  source = source.replace(labelNeedle, labelNeedle + `  host_fs: "กำลังตรวจไฟล์บน macOS โดยตรง",\n`);

  const instructionNeedle = `- หลัง create_files สำเร็จ ต้องจำ path จากผล tool และบอกตำแหน่งไฟล์จริงในคำตอบ ห้ามเดาพาธ\n`;
  if (!source.includes(instructionNeedle)) throw new Error("หา file instruction ไม่พบ");
  source = source.replace(instructionNeedle, instructionNeedle
    + `- เมื่อผู้ใช้ถามว่าไฟล์/โฟลเดอร์มีจริงไหม, เช็ค path, หาไฟล์ไม่เจอ, ตรวจ metadata หรือขอดูรายการไฟล์ ต้องใช้ host_fs บน macOS host โดยตรง ห้ามใช้ run_artifact, run_learned_skill, Skill Lab หรือ Docker สำหรับงานตรวจ filesystem metadata\n`
    + `- ถ้า host_fs คืน exists=false ให้รายงาน NOT_FOUND ตามจริง ห้ามเดาว่า External Drive หลุด; ถ้า path อยู่ใต้ appDir ที่ Alpha กำลังรันอยู่ ให้ถือว่า storage state ต้องยืนยันจาก host tool เท่านั้น\n`);

  const temp = `${path}.beta6.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchWrapper() {
  const path = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  source = source.replace(
    `import { promises as fs } from "node:fs";`,
    `import { promises as fs } from "node:fs";\nimport { homedir } from "node:os";`,
  );
  source = source.replace(
    `import { basename, dirname, resolve } from "node:path";`,
    `import { basename, dirname, join, relative, resolve, sep } from "node:path";`,
  );

  const insertion = `async function systemCapability(args = {}) {`;
  if (!source.includes(insertion)) throw new Error("หา systemCapability ไม่พบ");
  const helper = `// ${marker}\nconst hostOutputsDir = resolve(appDir, "outputs", "Alpha Outputs");\nconst hostBlockedRoots = ["/System", "/usr", "/bin", "/sbin", "/private", "/Library", "/Applications"];\nconst hostBlockedSensitiveParts = ["/.ssh", "/.gnupg", "/Library/Keychains", "/Library/Mail", "/Library/Messages", "/Library/Safari", "/Library/Application Support/Google/Chrome"];\n\nfunction hostPathInside(child, parent) {\n  const rel = relative(resolve(parent), resolve(child));\n  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");\n}\n\nfunction hostFsAllowed(rawPath, settings = {}) {\n  const target = resolve(String(rawPath || ""));\n  if (!String(rawPath || "").startsWith("/")) throw new Error("host_fs ต้องใช้ absolute path ของ macOS");\n  if (hostBlockedRoots.some((root) => target === root || target.startsWith(root + sep))) throw new Error("ตำแหน่งระบบ macOS นี้ไม่อยู่ในขอบเขต host_fs");\n  if (hostBlockedSensitiveParts.some((part) => target.includes(part))) throw new Error("ตำแหน่งนี้มีข้อมูลลับหรือข้อมูลส่วนตัว");\n  if (hostPathInside(target, appDir) || hostPathInside(target, hostOutputsDir)) return target;\n  const mode = String(settings.file_access_mode || "alpha_outputs");\n  if (mode === "full_user_files" && (hostPathInside(target, homedir()) || hostPathInside(target, "/Volumes"))) return target;\n  if (mode === "selected_folders" && Array.isArray(settings.allowed_file_roots) && settings.allowed_file_roots.some((root) => hostPathInside(target, String(root)))) return target;\n  throw new Error("path นี้อยู่นอกขอบเขตไฟล์ที่อนุญาตสำหรับ host_fs");\n}\n\nasync function hostFs(args = {}, settings = {}) {\n  const action = new Set(["exists", "stat", "list"]).has(String(args.action)) ? String(args.action) : "stat";\n  const target = hostFsAllowed(args.path, settings);\n  let stat;\n  try {\n    stat = await fs.lstat(target);\n  } catch (error) {\n    if (error?.code === "ENOENT") return { ok: true, host_scope: "macos", docker_used: false, action, path: target, exists: false, app_dir: appDir };\n    throw error;\n  }\n  const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";\n  const base = {\n    ok: true, host_scope: "macos", docker_used: false, action, path: target, exists: true, type: kind,\n    size: stat.size, mode: (stat.mode & 0o777).toString(8).padStart(3, "0"), mtime: stat.mtime.toISOString(), app_dir: appDir,\n  };\n  if (action !== "list") return base;\n  if (!stat.isDirectory()) throw new Error("host_fs list ใช้ได้เฉพาะ directory");\n  const limit = Math.max(1, Math.min(200, Number(args.max_entries || 100)));\n  const entries = (await fs.readdir(target, { withFileTypes: true })).slice(0, limit).map((entry) => ({\n    name: entry.name,\n    path: join(target, entry.name),\n    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",\n  }));\n  return { ...base, entries, entry_count: entries.length, truncated: entries.length >= limit };\n}\n\n`;
  source = source.replace(insertion, helper + insertion);

  const healthNeedle = `      host_capability_ready: true,\n`;
  if (!source.includes(healthNeedle)) throw new Error("หา augmented health ไม่พบ");
  source = source.replace(healthNeedle, healthNeedle + `      host_filesystem_ready: true,\n      app_dir: appDir,\n`);

  const executeNeedle = `      const name = String(body.name || "");\n      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));`;
  if (!source.includes(executeNeedle)) throw new Error("หา tool execute router ไม่พบ");
  source = source.replace(
    executeNeedle,
    `      const name = String(body.name || "");\n      if (name === "host_fs") return json(response, 200, await hostFs(body.arguments || {}, body.settings || {}));\n      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));`,
  );

  const temp = `${path}.beta6.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatRoute() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const helperNeedle = `function artifactLocationQuestion(message: string): boolean {`;
  if (!source.includes(helperNeedle)) throw new Error("ต้อง apply beta4 chat runtime ก่อน beta6");
  const helpers = `// ${marker}\nfunction hostPathVerificationQuestion(message: string): boolean {\n  return /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,45}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,45}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);\n}\n\nfunction extractAbsoluteHostPath(text: string): string {\n  const code = text.match(/\`(\/(?:Volumes|Users)\/[^\`\\n\\r]+)\`/);\n  if (code?.[1]) return code[1].trim();\n  const plain = text.match(/(\/(?:Volumes|Users)\/[^\\s,;<>"']+)/);\n  return plain?.[1]?.replace(/[.)\\]}]+$/, "") || "";\n}\n\nfunction hostFsVerificationReply(path: string, result: Record<string, unknown>): string {\n  if (result.exists === false) return `❌ NOT_FOUND: ไม่พบไฟล์หรือโฟลเดอร์ที่ \`${path}\` บน macOS host จากการตรวจจริง (ไม่ได้ใช้ Docker)`;\n  return `✅ EXISTS: พบ ${String(result.type || "path")} จริงที่ \`${String(result.path || path)}\` บน macOS host\\n- size: ${String(result.size ?? "-")} bytes\\n- permission: ${String(result.mode ?? "-")}\\n- modified: ${String(result.mtime ?? "-")}\\n- Docker: ไม่ได้ใช้`;\n}\n\n`;
  source = source.replace(helperNeedle, helpers + helperNeedle);

  const recentNeedle = `  const recentStored = await listRecentChatMessages(chat.id, 12);\n  if (artifactLocationQuestion(message)) {`;
  if (!source.includes(recentNeedle)) throw new Error("หา beta4 recentStored block ไม่พบ");
  const direct = `  const recentStored = await listRecentChatMessages(chat.id, 12);\n  if (hostPathVerificationQuestion(message)) {\n    const explicitPath = extractAbsoluteHostPath(message);\n    const recentArtifactPath = [...recentStored].reverse().flatMap((item) => item.role === "assistant" ? (item.metadata.artifacts ?? []) : []).map((item) => item.path).find(Boolean) || "";\n    const recentClaimedPath = [...recentStored].reverse().map((item) => extractAbsoluteHostPath(item.content)).find(Boolean) || "";\n    const targetPath = explicitPath || recentArtifactPath || recentClaimedPath;\n    if (targetPath) {\n      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: "กำลังตรวจ path บน macOS host", tool: "host_fs" });\n      try {\n        const result = await executeTool("host_fs", { action: "stat", path: targetPath }, settings);\n        const reply = hostFsVerificationReply(targetPath, result);\n        await finishAgentRun(runId, "completed", result.exists === false ? "ตรวจแล้วไม่พบ path" : "ตรวจ path บน macOS host แล้ว");\n        const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { host_fs: result }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });\n        return immediateStream([\n          ...baseEvents,\n          { type: "tool_status", payload: { tool: "host_fs", label: "ตรวจ filesystem บน macOS host โดยตรง" } },\n          { type: "token", payload: { text: reply } },\n          ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []),\n          { type: "done", payload: {} },\n        ]);\n      } catch (error) {\n        const failure = error instanceof Error ? error.message : "ตรวจ path ไม่สำเร็จ";\n        await finishAgentRun(runId, "failed", "ตรวจ path บน macOS host ไม่สำเร็จ", failure);\n        const reply = `ตรวจ path บน macOS host ไม่สำเร็จ: ${failure}`;\n        const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { error: true }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });\n        return immediateStream([...baseEvents, { type: "tool_error", payload: { tool: "host_fs", message: failure } }, { type: "token", payload: { text: reply } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);\n      }\n    }\n  }\n  if (artifactLocationQuestion(message)) {`;
  source = source.replace(recentNeedle, direct);

  const temp = `${path}.beta6.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchAgentTools();
await patchWrapper();
await patchChatRoute();
console.log("Applied Alpha beta6 host filesystem routing: path verification is macOS-native and cannot launch Docker");
