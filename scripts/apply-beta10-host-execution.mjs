import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta10-host-execution-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function patchAgentTools() {
  const path = resolve(appDir, "lib", "agent-tools.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const runArtifactNeedle = `  {\n    type: "function",\n    function: {\n      name: "run_artifact",`;
  const hostTool = `  // ${marker}\n  {\n    type: "function",\n    function: {\n      name: "run_host_artifact",\n      description: "Run a canonical Alpha workspace artifact directly on the user's macOS host when the task genuinely needs real Mac hardware, local network interfaces, local services, filesystem state, or installed CLI tools. This is not Docker and always requires explicit user approval. Do not use it for ordinary unit/syntax tests that belong in run_artifact.",\n      parameters: {\n        type: "object",\n        required: ["path"],\n        properties: {\n          path: { type: "string", description: "Absolute canonical artifact path under the Alpha workspace" },\n          args: { type: "array", maxItems: 32, items: { type: "string" }, description: "Argument array passed directly to the interpreter; never shell syntax" },\n          reason: { type: "string", description: "Why this task needs the real Mac host instead of Docker" },\n          timeout_seconds: { type: "number", minimum: 1, maximum: 600 },\n        },\n      },\n    },\n  },\n`;
  source = replaceOnce(source, runArtifactNeedle, `${hostTool}${runArtifactNeedle}`, "run_artifact schema");

  source = replaceOnce(
    source,
    `  run_artifact: "กำลังเตรียม Docker sandbox",`,
    `  run_host_artifact: "กำลังเตรียมรันงานบน Mac จริง",\n  run_artifact: "กำลังเตรียม Docker sandbox",`,
    "run_artifact label",
  );

  const instructionNeedle = `- การสร้างไฟล์และการรันไฟล์เป็นคนละขั้น: create_files ต้องสร้าง canonical Artifact บน host ก่อน; run_artifact เป็นเพียงการรันสำเนา/การ mount ใน sandbox และห้ามเปลี่ยน canonical host path ของ Artifact\n`;
  const extraInstructions = instructionNeedle
    + `- ${marker}: Sandbox ไม่ใช่สภาพแวดล้อมหลักของอัลฟ่า แต่เป็น isolation domain สำหรับทดสอบโค้ดที่ไม่จำเป็นต้องแตะเครื่องจริงเท่านั้น\n`
    + `- ถ้างานต้องใช้ hardware, Wi-Fi/network interface, local service, installed CLI หรือ filesystem/runtime state ของ Mac จริง ให้ใช้ run_host_artifact หลังสร้าง Artifact บน host และขออนุญาตผู้ใช้ ห้ามสรุปว่างานทำจริงไม่ได้เพียงเพราะ run_artifact เป็น Docker\n`
    + `- run_host_artifact และ run_artifact เป็นคนละ execution domain: งานทดสอบโค้ดทั่วไป -> Docker; งานที่ต้อง interact กับ Mac จริง -> macOS host หลัง approval\n`
    + `- ห้ามใช้ run_host_artifact เพื่อเช็คว่าไฟล์มีอยู่ไหมหรือดู path; งาน metadata ใช้ host_fs โดยตรง และงาน package ใช้ install_package/install_packages\n`
    + `- งาน security/network ที่ผู้ใช้ยืนยันว่าเป็นระบบหรือ lab ของตนเอง สามารถใช้ host-native execution เมื่อจำเป็นต่อ hardware/local interface จริง แต่ต้องคง target scope ที่ได้รับอนุญาตและอ้างผลจากเครื่องมือจริงเท่านั้น\n`;
  source = replaceOnce(source, instructionNeedle, extraInstructions, "beta8 execution-domain instruction");

  const temporary = `${path}.beta10-host.tmp`;
  await fs.writeFile(temporary, source, "utf8");
  await fs.rename(temporary, path);
}

async function patchWrapper() {
  const path = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const functionNeedle = "function virtualWirelessSkill() {";
  const hostRuntime = `// ${marker}\nfunction hostPathInsideWorkspace(target) {\n  const root = resolve(appDir);\n  const absolute = resolve(target);\n  return absolute === root || absolute.startsWith(root + "/");\n}\n\nfunction hostPathSensitive(target) {\n  const absolute = resolve(target);\n  const relativePath = absolute === resolve(appDir) ? "" : absolute.slice(resolve(appDir).length + 1);\n  const segments = relativePath.split("/").filter(Boolean);\n  if (segments.includes(".git")) return true;\n  const leaf = segments.at(-1) || "";\n  return leaf === ".dev.vars" || leaf === ".env" || leaf.startsWith(".env.");\n}\n\nfunction validateHostArgs(value) {\n  const args = Array.isArray(value) ? value.slice(0, 32).map((item) => String(item)) : [];\n  for (const item of args) {\n    if (item.length > 2000 || item.includes("\\0")) throw new Error("argument สำหรับ host execution ไม่ถูกต้อง");\n  }\n  return args;\n}\n\nasync function resolveHostArtifact(rawPath) {\n  const requested = String(rawPath || "").trim();\n  if (!requested.startsWith("/")) throw new Error("run_host_artifact ต้องใช้ absolute path ของ Artifact");\n  const resolved = resolve(requested);\n  if (!hostPathInsideWorkspace(resolved)) throw new Error("HOST_ARTIFACT_OUT_OF_WORKSPACE: รันบน Mac ได้เฉพาะ Artifact ภายใน workspace ของ Alpha");\n  if (hostPathSensitive(resolved)) throw new Error("HOST_ARTIFACT_PROTECTED: ไม่อนุญาตให้รันไฟล์ลับหรือ metadata ของ workspace");\n  const real = await fs.realpath(resolved).catch(() => "");\n  if (!real || !hostPathInsideWorkspace(real) || hostPathSensitive(real)) throw new Error("HOST_ARTIFACT_INVALID: Artifact ไม่มีอยู่จริงหรือ symlink ออกจาก workspace");\n  const stat = await fs.stat(real);\n  if (!stat.isFile()) throw new Error("run_host_artifact รองรับเฉพาะไฟล์");\n  if (stat.size > 2 * 1024 * 1024) throw new Error("Artifact ใหญ่เกิน 2MB สำหรับ host execution preview");\n  const lower = basename(real).toLowerCase();\n  let interpreter = "";\n  if (lower.endsWith(".sh")) interpreter = "/bin/zsh";\n  else if (lower.endsWith(".py")) interpreter = await executablePath("python3");\n  else if (lower.endsWith(".js") || lower.endsWith(".mjs")) interpreter = process.execPath;\n  else throw new Error("run_host_artifact รองรับ .sh, .py, .js และ .mjs เท่านั้น");\n  if (!interpreter) throw new Error("ไม่พบ interpreter ที่ต้องใช้บน Mac");\n  return { path: real, interpreter };\n}\n\nfunction runHostProcess(command, args, options = {}) {\n  return new Promise((resolveRun, reject) => {\n    const safeEnv = {};\n    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"]) {\n      if (process.env[key]) safeEnv[key] = process.env[key];\n    }\n    safeEnv.ALPHA_EXECUTION_SCOPE = "macos_host";\n    const child = spawn(command, args, {\n      cwd: options.cwd || appDir,\n      env: safeEnv,\n      stdio: ["ignore", "pipe", "pipe"],\n    });\n    const stdout = [];\n    const stderr = [];\n    let settled = false;\n    const timeout = Math.min(600_000, Math.max(1_000, Number(options.timeout || 120_000)));\n    const timer = setTimeout(() => {\n      child.kill("SIGKILL");\n      if (!settled) { settled = true; reject(new Error("HOST_EXECUTION_TIMEOUT")); }\n    }, timeout);\n    child.stdout.on("data", (chunk) => stdout.push(chunk));\n    child.stderr.on("data", (chunk) => stderr.push(chunk));\n    child.on("error", (error) => {\n      if (settled) return;\n      settled = true;\n      clearTimeout(timer);\n      reject(error);\n    });\n    child.on("close", (code) => {\n      if (settled) return;\n      settled = true;\n      clearTimeout(timer);\n      resolveRun({\n        code: code ?? 1,\n        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 64_000),\n        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32_000),\n      });\n    });\n  });\n}\n\nasync function queueHostArtifactConfirmation(args, resolvedArtifact) {\n  const now = Date.now();\n  const key = resolvedArtifact.path + "|" + JSON.stringify(validateHostArgs(args.args));\n  for (const [id, item] of pending) {\n    const existingKey = item.type === "run_host_artifact" ? String(item.key || "") : "";\n    if (existingKey === key && ["pending", "running"].includes(String(item.status))) {\n      item.updatedAt = now;\n      item.expiresAt = now + CONFIRMATION_TTL_MS;\n      await persistPending();\n      return id;\n    }\n  }\n  const id = randomUUID();\n  pending.set(id, {\n    type: "run_host_artifact",\n    key,\n    args: { ...args, path: resolvedArtifact.path },\n    status: "pending",\n    createdAt: now,\n    updatedAt: now,\n    expiresAt: now + CONFIRMATION_TTL_MS,\n    cachedResult: null,\n  });\n  await persistPending();\n  return id;\n}\n\nasync function runHostArtifact(args, approved = false) {\n  const artifact = await resolveHostArtifact(args.path);\n  const runArgs = validateHostArgs(args.args);\n  const reason = String(args.reason || "งานนี้ต้องใช้ environment จริงของ Mac").trim().slice(0, 600);\n  const timeoutSeconds = Math.min(600, Math.max(1, Number(args.timeout_seconds || 120)));\n  if (!approved) {\n    const id = await queueHostArtifactConfirmation(args, artifact);\n    return {\n      ok: false,\n      confirmation_required: true,\n      confirmation_id: id,\n      expires_at: pending.get(id)?.expiresAt,\n      summary: "อนุญาตให้อัลฟ่ารัน " + basename(artifact.path) + " บน Mac เครื่องจริง (ไม่ใช่ Docker) เพื่อ" + reason + " หรือไม่?",\n      path: artifact.path,\n      interpreter: artifact.interpreter,\n      execution_scope: "macos_host",\n      docker_used: false,\n    };\n  }\n  const result = await runHostProcess(artifact.interpreter, [artifact.path, ...runArgs], { cwd: dirname(artifact.path), timeout: timeoutSeconds * 1000 });\n  return {\n    ok: result.code === 0,\n    message: result.code === 0 ? "รัน " + basename(artifact.path) + " บน Mac จริงเสร็จแล้ว" : "รัน " + basename(artifact.path) + " บน Mac จริงจบด้วย exit code " + result.code,\n    path: artifact.path,\n    interpreter: artifact.interpreter,\n    args: runArgs,\n    exit_code: result.code,\n    stdout: result.stdout,\n    stderr: result.stderr,\n    execution_scope: "macos_host",\n    host_scope: "macos",\n    docker_used: false,\n    resume: result.code === 0,\n    resume_prompt: result.code === 0 ? "host execution สำเร็จแล้ว ให้ใช้ stdout/stderr เป็นหลักฐานและดำเนิน workflow เดิมต่อจนจบ" : "",\n  };\n}\n\n`;
  source = replaceOnce(source, functionNeedle, hostRuntime + functionNeedle, "virtualWirelessSkill insertion point");

  const executeNeedle = `      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));\n      if (name === "install_packages") {`;
  const executeReplacement = `      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));\n      if (name === "run_host_artifact") {\n        const result = await runHostArtifact(body.arguments || {}, false);\n        return json(response, result.confirmation_required ? 409 : (result.ok ? 200 : 500), result);\n      }\n      if (name === "install_packages") {`;
  source = replaceOnce(source, executeNeedle, executeReplacement, "host execute route");

  const confirmNeedle = `    const result = item.type === "install_package"\n      ? await installPackage(item.args || {}, true, id)\n      : item.type === "install_packages"\n        ? await installPackages(item.args || {}, true)\n        : { ok: false, error: "confirmation type ไม่รู้จัก", resume: false };`;
  const confirmReplacement = `    const result = item.type === "install_package"\n      ? await installPackage(item.args || {}, true, id)\n      : item.type === "install_packages"\n        ? await installPackages(item.args || {}, true)\n        : item.type === "run_host_artifact"\n          ? await runHostArtifact(item.args || {}, true)\n          : { ok: false, error: "confirmation type ไม่รู้จัก", resume: false };`;
  source = replaceOnce(source, confirmNeedle, confirmReplacement, "host approval dispatch");

  const temporary = `${path}.beta10-host.tmp`;
  await fs.writeFile(temporary, source, "utf8");
  await fs.rename(temporary, path);
}

async function patchChatPrompt() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const beta8Needle = `- alpha-beta8-permission-domains-v1: sandbox เป็นข้อกำหนดเฉพาะตอน “รันโค้ด” ผ่าน run_artifact/Skill Lab เท่านั้น ไม่ใช่ข้อจำกัดของการสร้าง/อ่าน/จัดการไฟล์; create_files/manage_file/host_fs ทำงานกับ macOS host ตาม file_access_mode และ workspace ที่อนุญาต`;
  const beta10Line = `${beta8Needle}\n- ${marker}: ถ้างานจริงต้อง interact กับ Mac hardware, network interface, local service, installed CLI หรือ host runtime ให้ใช้ run_host_artifact หลัง approval; Docker เป็น isolation สำหรับการทดสอบ ไม่ใช่ข้ออ้างว่าทำงานบนเครื่องจริงไม่ได้`;
  source = replaceOnce(source, beta8Needle, beta10Line, "beta8 chat permission instruction");

  const temporary = `${path}.beta10-host.tmp`;
  await fs.writeFile(temporary, source, "utf8");
  await fs.rename(temporary, path);
}

await patchAgentTools();
await patchWrapper();
await patchChatPrompt();
console.log("Applied Alpha beta10 host execution: capability-scoped real Mac runtime is available after approval");
