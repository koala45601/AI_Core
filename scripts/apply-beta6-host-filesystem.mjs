import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta6-host-filesystem-v1";

async function patchAgentTools() {
  const path = resolve(appDir, "lib", "agent-tools.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const insertBefore = `  {
    type: "function",
    function: {
      name: "manage_file",`;
  if (!source.includes(insertBefore)) throw new Error("หา manage_file schema ไม่พบ");
  const tool = `  // ${marker}
  {
    type: "function",
    function: {
      name: "host_fs",
      description: "Read-only inspection of files and directories on the macOS host. Use this for file existence, path verification, stat/metadata, and directory listing. This tool never launches Docker or Skill Lab.",
      parameters: {
        type: "object",
        required: ["action", "path"],
        properties: {
          action: { type: "string", enum: ["exists", "stat", "list"] },
          path: { type: "string", description: "Absolute macOS host path to inspect" },
          max_entries: { type: "number", description: "Maximum directory entries for list; defaults to 100 and caps at 200" },
        },
      },
    },
  },
`;
  source = source.replace(insertBefore, tool + insertBefore);

  const labelNeedle = `export const TOOL_LABELS: Record<string, string> = {
`;
  if (!source.includes(labelNeedle)) throw new Error("หา TOOL_LABELS ไม่พบ");
  source = source.replace(labelNeedle, labelNeedle + `  host_fs: "กำลังตรวจไฟล์บน macOS โดยตรง",
`);

  const instructionNeedle = `- หลัง create_files สำเร็จ ต้องจำ path จากผล tool และบอกตำแหน่งไฟล์จริงในคำตอบ ห้ามเดาพาธ
`;
  if (!source.includes(instructionNeedle)) throw new Error("หา file instruction ไม่พบ");
  source = source.replace(
    instructionNeedle,
    instructionNeedle
      + `- เมื่อผู้ใช้ถามว่าไฟล์/โฟลเดอร์มีจริงไหม, เช็ค path, หาไฟล์ไม่เจอ, ตรวจ metadata หรือขอดูรายการไฟล์ ต้องใช้ host_fs บน macOS host โดยตรง ห้ามใช้ run_artifact, run_learned_skill, Skill Lab หรือ Docker สำหรับงานตรวจ filesystem metadata
`
      + `- ถ้า host_fs คืน exists=false ให้รายงาน NOT_FOUND ตามจริง ห้ามเดาว่า External Drive หลุด; ถ้า path อยู่ใต้ appDir ที่ Alpha กำลังรันอยู่ ให้ถือว่า storage state ต้องยืนยันจาก host tool เท่านั้น
`,
  );

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
    `import { promises as fs } from "node:fs";
import { homedir } from "node:os";`,
  );
  source = source.replace(
    `import { basename, dirname, resolve } from "node:path";`,
    `import { basename, dirname, join, relative, resolve, sep } from "node:path";`,
  );

  const insertion = `async function systemCapability(args = {}) {`;
  if (!source.includes(insertion)) throw new Error("หา systemCapability ไม่พบ");
  const helper = `// ${marker}
const hostOutputsDir = resolve(appDir, "outputs", "Alpha Outputs");
const hostBlockedRoots = ["/System", "/usr", "/bin", "/sbin", "/private", "/Library", "/Applications"];
const hostBlockedSensitiveParts = ["/.ssh", "/.gnupg", "/Library/Keychains", "/Library/Mail", "/Library/Messages", "/Library/Safari", "/Library/Application Support/Google/Chrome"];

function hostPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

function hostFsAllowed(rawPath, settings = {}) {
  const target = resolve(String(rawPath || ""));
  if (!String(rawPath || "").startsWith("/")) throw new Error("host_fs ต้องใช้ absolute path ของ macOS");
  if (hostBlockedRoots.some((root) => target === root || target.startsWith(root + sep))) throw new Error("ตำแหน่งระบบ macOS นี้ไม่อยู่ในขอบเขต host_fs");
  if (hostBlockedSensitiveParts.some((part) => target.includes(part))) throw new Error("ตำแหน่งนี้มีข้อมูลลับหรือข้อมูลส่วนตัว");
  if (hostPathInside(target, appDir) || hostPathInside(target, hostOutputsDir)) return target;
  const mode = String(settings.file_access_mode || "alpha_outputs");
  if (mode === "full_user_files" && (hostPathInside(target, homedir()) || hostPathInside(target, "/Volumes"))) return target;
  if (mode === "selected_folders" && Array.isArray(settings.allowed_file_roots) && settings.allowed_file_roots.some((root) => hostPathInside(target, String(root)))) return target;
  throw new Error("path นี้อยู่นอกขอบเขตไฟล์ที่อนุญาตสำหรับ host_fs");
}

async function hostFs(args = {}, settings = {}) {
  const action = new Set(["exists", "stat", "list"]).has(String(args.action)) ? String(args.action) : "stat";
  const target = hostFsAllowed(args.path, settings);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, host_scope: "macos", docker_used: false, action, path: target, exists: false, app_dir: appDir };
    throw error;
  }
  const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
  const base = {
    ok: true,
    host_scope: "macos",
    docker_used: false,
    action,
    path: target,
    exists: true,
    type: kind,
    size: stat.size,
    mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
    mtime: stat.mtime.toISOString(),
    app_dir: appDir,
  };
  if (action !== "list") return base;
  if (!stat.isDirectory()) throw new Error("host_fs list ใช้ได้เฉพาะ directory");
  const limit = Math.max(1, Math.min(200, Number(args.max_entries || 100)));
  const entries = (await fs.readdir(target, { withFileTypes: true })).slice(0, limit).map((entry) => ({
    name: entry.name,
    path: join(target, entry.name),
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
  }));
  return { ...base, entries, entry_count: entries.length, truncated: entries.length >= limit };
}

`;
  source = source.replace(insertion, helper + insertion);

  const healthNeedle = `      host_capability_ready: true,
`;
  if (!source.includes(healthNeedle)) throw new Error("หา augmented health ไม่พบ");
  source = source.replace(
    healthNeedle,
    healthNeedle + `      host_filesystem_ready: true,
      app_dir: appDir,
`,
  );

  const executeNeedle = `      const name = String(body.name || "");
      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));`;
  if (!source.includes(executeNeedle)) throw new Error("หา tool execute router ไม่พบ");
  source = source.replace(
    executeNeedle,
    `      const name = String(body.name || "");
      if (name === "host_fs") return json(response, 200, await hostFs(body.arguments || {}, body.settings || {}));
      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));`,
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

  const helpers = [
    `// ${marker}`,
    `function hostPathVerificationQuestion(message: string): boolean {`,
    `  return /(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น).{0,45}(?:ไฟล์|โฟลเดอร์|folder|path|พาธ)|(?:ไฟล์|โฟลเดอร์|folder|path|พาธ).{0,45}(?:เช็ค|ตรวจ|verify|มีจริง|exists?|หาไม่เจอ|ไม่เจอ|เปิดไม่ได้|มองไม่เห็น)/i.test(message);`,
    `}`,
    ``,
    `function extractAbsoluteHostPath(text: string): string {`,
    '  const code = text.match(/`(\\/(?:Volumes|Users)\\/[^`\\n\\r]+)`/);',
    `  if (code?.[1]) return code[1].trim();`,
    `  const plain = text.match(/(\\/(?:Volumes|Users)\\/[^\\s,;<>\"']+)/);`,
    `  return plain?.[1]?.replace(/[.)\\]}]+$/, "") || "";`,
    `}`,
    ``,
    `function hostFsVerificationReply(path: string, result: Record<string, unknown>): string {`,
    '  if (result.exists === false) return "❌ NOT_FOUND: ไม่พบไฟล์หรือโฟลเดอร์ที่ `" + path + "` บน macOS host จากการตรวจจริง (ไม่ได้ใช้ Docker)";',
    '  return "✅ EXISTS: พบ " + String(result.type || "path") + " จริงที่ `" + String(result.path || path) + "` บน macOS host\\n- size: " + String(result.size ?? "-") + " bytes\\n- permission: " + String(result.mode ?? "-") + "\\n- modified: " + String(result.mtime ?? "-") + "\\n- Docker: ไม่ได้ใช้";',
    `}`,
    ``,
  ].join("\n");
  source = source.replace(helperNeedle, helpers + helperNeedle);

  const recentNeedle = `  const recentStored = await listRecentChatMessages(chat.id, 12);
  if (artifactLocationQuestion(message)) {`;
  if (!source.includes(recentNeedle)) throw new Error("หา beta4 recentStored block ไม่พบ");

  const direct = [
    `  const recentStored = await listRecentChatMessages(chat.id, 12);`,
    `  if (hostPathVerificationQuestion(message)) {`,
    `    const explicitPath = extractAbsoluteHostPath(message);`,
    `    const recentArtifactPath = [...recentStored].reverse().flatMap((item) => item.role === "assistant" ? (item.metadata.artifacts ?? []) : []).map((item) => item.path).find(Boolean) || "";`,
    `    const recentClaimedPath = [...recentStored].reverse().map((item) => extractAbsoluteHostPath(item.content)).find(Boolean) || "";`,
    `    const targetPath = explicitPath || recentArtifactPath || recentClaimedPath;`,
    `    if (targetPath) {`,
    `      await updateAgentRun(runId, { status: "running", stage: "host_fs", label: "กำลังตรวจ path บน macOS host", tool: "host_fs" });`,
    `      try {`,
    `        const result = await executeTool("host_fs", { action: "stat", path: targetPath }, settings);`,
    `        const reply = hostFsVerificationReply(targetPath, result);`,
    `        await finishAgentRun(runId, "completed", result.exists === false ? "ตรวจแล้วไม่พบ path" : "ตรวจ path บน macOS host แล้ว");`,
    `        const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { host_fs: result }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });`,
    `        return immediateStream([`,
    `          ...baseEvents,`,
    `          { type: "tool_status", payload: { tool: "host_fs", label: "ตรวจ filesystem บน macOS host โดยตรง" } },`,
    `          { type: "token", payload: { text: reply } },`,
    `          ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []),`,
    `          { type: "done", payload: {} },`,
    `        ]);`,
    `      } catch (error) {`,
    `        const failure = error instanceof Error ? error.message : "ตรวจ path ไม่สำเร็จ";`,
    `        await finishAgentRun(runId, "failed", "ตรวจ path บน macOS host ไม่สำเร็จ", failure);`,
    `        const reply = "ตรวจ path บน macOS host ไม่สำเร็จ: " + failure;`,
    `        const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { error: true }, promptTokens: 0, responseTokens: Math.ceil(reply.length / 3.5) });`,
    `        return immediateStream([...baseEvents, { type: "tool_error", payload: { tool: "host_fs", message: failure } }, { type: "token", payload: { text: reply } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);`,
    `      }`,
    `    }`,
    `  }`,
    `  if (artifactLocationQuestion(message)) {`,
  ].join("\n");
  source = source.replace(recentNeedle, direct);

  const temp = `${path}.beta6.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchAgentTools();
await patchWrapper();
await patchChatRoute();
console.log("Applied Alpha beta6 host filesystem routing: path verification is macOS-native and cannot launch Docker");
