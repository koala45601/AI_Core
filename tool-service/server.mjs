import http from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import net from "node:net";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { evaluateTicketPreflight, extractTicketPageFacts } from "../lib/ticket-workflow.js";
import { createTicketRunManager } from "./ticket-run-manager.mjs"; // alpha-beta21-ticket-runtime-v1

process.env.PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", process.env.PATH || ""].join(":");

const appDir = resolve(process.env.ALPHA_APP_DIR || process.argv[2] || process.cwd());
const appVersion = await fs.readFile(resolve(appDir, "package.json"), "utf8").then((value) => JSON.parse(value).version).catch(() => "1.0.0");
const varsFile = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8").catch(() => "");
const token = String(process.env.ALPHA_TOOL_TOKEN || varsFile.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1] || "").trim();
const port = Number(process.env.ALPHA_TOOL_PORT || 4317);
const outputsDir = resolve(appDir, "outputs", "Alpha Outputs");
const programCreateDir = resolve(appDir, "Program_Create");
const workDir = resolve(appDir, "work");
const skillLabDir = resolve(workDir, "skill-lab");
const learnedSkillsDir = resolve(outputsDir, "Learned Skills");
const learnedResultsDir = resolve(outputsDir, "Learned Results");
const autoLearnWorkDir = resolve(workDir, "auto-learn");
const autoLearnOutputDir = resolve(outputsDir, "Auto Learning");
const autoLearnHistoryFile = resolve(workDir, "auto-learn-history.json");
const autoLearnSkillBacklogFile = resolve(workDir, "auto-learn-skill-backlog.json");
const autoLearnLastJobFile = resolve(workDir, "auto-learn-last-job.json");
const autoLearnRunsDir = resolve(workDir, "auto-learn-runs");
const skillsIndexFile = resolve(workDir, "skills-index.json");
const browserProfileDir = resolve(workDir, "alpha-browser-profile");
const publicInspectionProfileDir = resolve(workDir, "public-inspection-profile");
const ticketBrowserProfileDir = resolve(workDir, "ticket-browser-profile");
const composeFile = resolve(appDir, "infra", "searxng", "docker-compose.yml");
const artifacts = new Map();
const pending = new Map();
const extensionClients = new Set();
let alphaContext = null;
let publicInspectionContext = null;
const publicInspectionNavigationAt = new Map();
let lastHeavyUse = 0;
let idleSeconds = 300;
let dockerOpenedByAlpha = false;
let lastToolError = "";
let storageConnected = true;
let storageError = "";
let autoLearnJob = null;
let autoLearnAbort = null;
let autoLearnLoopPromise = null;
const ticketRunManager = createTicketRunManager({ programCreateDir, ticketBrowserProfileDir, requiredGeneratorVersion: "1.1.0-beta.24" });

if (token.length < 32) {
  console.error("ALPHA_TOOL_TOKEN is missing or too short");
  process.exit(1);
}

await fs.mkdir(outputsDir, { recursive: true });
await fs.mkdir(programCreateDir, { recursive: true });
await fs.mkdir(workDir, { recursive: true });
await fs.mkdir(skillLabDir, { recursive: true });
await fs.mkdir(learnedSkillsDir, { recursive: true });
await fs.mkdir(learnedResultsDir, { recursive: true });
await fs.mkdir(autoLearnWorkDir, { recursive: true });
await fs.mkdir(autoLearnOutputDir, { recursive: true });
await fs.mkdir(autoLearnRunsDir, { recursive: true });

const mimeByExtension = {
  ".py": "text/x-python", ".js": "text/javascript", ".mjs": "text/javascript", ".sh": "text/x-shellscript", // alpha-beta4-shell-artifacts-v1
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".zip": "application/zip", ".pdf": "application/pdf", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

// Only these reviewed packages may be downloaded automatically by Skill Lab.
// Normal skill execution always runs without network access.
const trustedDependencyCatalog = {
  "python-stdlib": { runtime: "python", source: "Python official image", packages: [] },
  "python-pillow": { runtime: "python", source: "PyPI / Pillow project", packages: ["Pillow==11.3.0"] },
  "python-numpy": { runtime: "python", source: "PyPI / NumPy project", packages: ["numpy==2.3.2"] },
  "node-stdlib": { runtime: "node", source: "Node official image", packages: [] },
};

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(request) {
  return constantTimeEqual(request.headers.authorization, `Bearer ${token}`);
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("คำขอมีขนาดใหญ่เกินกำหนด");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || appDir,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = options.timeout === 0 ? 0 : (options.timeout || 30_000);
    const timer = timeout ? setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`หมดเวลารอ ${basename(command)}`));
      }
    }, timeout) : null;
    const abort = () => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new DOMException("ยกเลิก process แล้ว", "AbortError"));
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const result = { code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0 || options.allowFailure) resolveRun(result);
      else reject(new Error(result.stderr.trim() || result.stdout.trim() || `${basename(command)} ล้มเหลว`));
    });
  });
}

function sanitizeName(value, fallback = "alpha-project") {
  const name = String(value || fallback).normalize("NFKC").replace(/[^\p{L}\p{N}._ -]+/gu, "-").trim().replace(/[ .]+$/g, "").slice(0, 80);
  return name && name !== "." && name !== ".." ? name : fallback;
}

function safeRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("พาธไฟล์ไม่ปลอดภัย");
  }
  const extension = extname(normalized).toLowerCase();
  const allowed = new Set([".py", ".js", ".mjs", ".sh", ".html", ".css", ".json", ".md", ".txt", ".csv"]);
  if (!allowed.has(extension)) throw new Error(`ยังไม่รองรับไฟล์ชนิด ${extension || "ไม่มีนามสกุล"}`);
  return normalized;
}

function safeOutputRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("พาธไฟล์ผลลัพธ์ไม่ปลอดภัย");
  }
  if (Buffer.byteLength(normalized) > 512) throw new Error("พาธไฟล์ผลลัพธ์ยาวเกินไป");
  return normalized;
}

const blockedRoots = ["/System", "/usr", "/bin", "/sbin", "/private", "/Library", "/Applications"];
const blockedSensitiveParts = [
  "/Library/Keychains", "/Library/Mail", "/Library/Messages", "/Library/Safari",
  "/Library/Application Support/Google/Chrome", "/.ssh", "/.gnupg",
];

function pathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

function assertNotBlocked(target) {
  const absolute = resolve(target);
  if (blockedRoots.some((root) => absolute === root || absolute.startsWith(root + sep))) throw new Error("อัลฟ่าไม่แก้ไขไฟล์ระบบ macOS");
  if (blockedSensitiveParts.some((part) => absolute.includes(part))) throw new Error("ตำแหน่งนี้มีข้อมูลลับหรือข้อมูลส่วนตัวที่อัลฟ่าไม่เปิดอ่าน");
  return absolute;
}

// alpha-beta8-permission-domains-v1
function workspacePathSensitive(target) {
  const absolute = resolve(target);
  const gitRoot = resolve(appDir, ".git");
  if (pathInside(absolute, gitRoot)) return true;
  const rel = relative(appDir, absolute);
  const first = rel.split(sep)[0] || "";
  if (first === ".dev.vars" || first === ".env" || first.startsWith(".env.")) return true;
  return false;
}

function allowedTarget(destination, settings, approved = false) {
  const mode = settings.file_access_mode || "ask";
  const target = assertNotBlocked(destination);
  if (pathInside(target, outputsDir) || pathInside(target, programCreateDir)) return target;
  if (pathInside(target, appDir)) {
    if (workspacePathSensitive(target)) throw new Error("ตำแหน่งนี้เป็นไฟล์ลับหรือ metadata ภายใน workspace ของ Alpha");
    return target;
  }
  if (mode === "ask" && approved && (pathInside(target, homedir()) || pathInside(target, "/Volumes"))) return target;
  if (mode === "full_user_files") {
    if (pathInside(target, homedir()) || pathInside(target, "/Volumes")) return target;
  }
  if (mode === "selected_folders" && (settings.allowed_file_roots || []).some((root) => pathInside(target, root))) return target;
  throw new Error("ตำแหน่งนี้อยู่นอกขอบเขตไฟล์ที่อนุญาต");
}

async function assertNoSymlinkEscape(target) {
  const absolute = resolve(target);
  const parts = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("ไม่อนุญาตให้ทำงานผ่าน symbolic link");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

function registerArtifact(filePath, project, kind = "file") {
  const id = randomUUID();
  const artifact = { id, name: basename(filePath), path: filePath, size: 0, mime: mimeByExtension[extname(filePath).toLowerCase()] || "application/octet-stream", kind, project };
  artifacts.set(id, artifact);
  return artifact;
}

async function hydrateArtifact(artifact) {
  const stat = await fs.stat(artifact.path);
  artifact.size = stat.size;
  return artifact;
}

async function validateStaging(staging, files) {
  const errors = [];
  for (const item of files) {
    const filePath = join(staging, item.path);
    try {
      if (extname(item.path).toLowerCase() === ".json") JSON.parse(item.content);
      if (extname(item.path).toLowerCase() === ".py") await run("/usr/bin/python3", ["-m", "py_compile", filePath], { timeout: 12_000 });
      if ([".js", ".mjs"].includes(extname(item.path).toLowerCase())) await run(process.execPath, ["--check", filePath], { timeout: 12_000 });
      if (extname(item.path).toLowerCase() === ".sh") await run("/bin/zsh", ["-n", filePath], { timeout: 12_000 });
    } catch (error) {
      errors.push(`${item.path}: ${error.message}`);
    }
  }
  await fs.rm(join(staging, "__pycache__"), { recursive: true, force: true });
  return errors;
}

async function createFiles(args, settings, approved = false) {
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  if (!rawFiles.length || rawFiles.length > 50) throw new Error("ต้องมีไฟล์ 1–50 ไฟล์ต่อครั้ง");
  const files = rawFiles.map((item) => ({ path: safeRelativePath(item.path), content: String(item.content ?? "") }));
  const totalBytes = files.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
  if (totalBytes > 20 * 1024 * 1024) throw new Error("ขนาดไฟล์รวมเกิน 20MB");
  const project = sanitizeName(args.project_name || (files.length === 1 ? files[0].path.replace(extname(files[0].path), "") : "alpha-project"));
  let requestedDestination;
  if (args.destination && isAbsolute(args.destination)) {
    requestedDestination = resolve(args.destination);
  } else {
    requestedDestination = join(programCreateDir, project);
    let suffix = 2;
    while (await fs.access(requestedDestination).then(() => true).catch(() => false)) {
      requestedDestination = join(programCreateDir, `${project}-${suffix}`);
      suffix += 1;
    }
  }
  // alpha-beta7-file-workflow-recovery-v1
  let destination;
  try {
    destination = allowedTarget(requestedDestination, settings, approved);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || "");
    if (reason.includes("ตำแหน่งนี้อยู่นอกขอบเขตไฟล์ที่อนุญาต")) {
      return {
        ok: false,
        code: "FILE_DESTINATION_OUT_OF_SCOPE",
        error: reason,
        requested_destination: requestedDestination,
        safe_fallback_destination: join(outputsDir, project),
        file_access_mode: settings.file_access_mode || "ask",
        requires_approval: settings.file_access_mode === "ask" && !approved,
        host_scope: "macos",
        docker_used: false,
        message: "ปลายทางที่ขออยู่นอกขอบเขตไฟล์ที่อนุญาต สามารถสร้างใน Alpha Outputs เป็น fallback ได้โดยไม่ใช้ Docker",
      };
    }
    throw error;
  }
  await assertNoSymlinkEscape(destination);
  const staging = join(outputsDir, `.staging-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const item of files) {
      const filePath = join(staging, item.path);
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, item.content, "utf8");
    }
    const validationErrors = await validateStaging(staging, files);
    if (validationErrors.length) return { ok: false, validation_errors: validationErrors, message: "ไฟล์ยังไม่ผ่านการตรวจ syntax กรุณาแก้แล้วเรียก create_files อีกครั้ง" };

    const backupRoot = join(outputsDir, ".alpha-backups", new Date().toISOString().replaceAll(":", "-"));
    for (const item of files) {
      const source = join(staging, item.path);
      const target = join(destination, item.path);
      assertNotBlocked(target);
      if (!pathInside(target, destination)) throw new Error("พาธไฟล์ออกนอกโปรเจกต์");
      await assertNoSymlinkEscape(target);
      await fs.mkdir(dirname(target), { recursive: true });
      try {
        await fs.access(target);
        const backup = join(backupRoot, project, item.path);
        await fs.mkdir(dirname(backup), { recursive: true });
        await fs.copyFile(target, backup);
      } catch {
        // New files do not need a backup.
      }
      await fs.copyFile(source, target);
    }

    const created = [];
    for (const item of files) created.push(await hydrateArtifact(registerArtifact(join(destination, item.path), project)));
    if (files.length > 1 || args.zip === true) {
      const archivePath = `${destination}.zip`;
      await fs.rm(archivePath, { force: true });
      await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", destination, archivePath], { timeout: 30_000 });
      created.push(await hydrateArtifact(registerArtifact(archivePath, project, "archive")));
    }
    return { ok: true, message: `สร้าง ${files.length} ไฟล์เรียบร้อย`, artifacts: created, destination, host_scope: "macos", file_scope: "macos_host", execution_scope: "none", docker_used: false, workspace_root: appDir };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function artifactOrPath(args) {
  const artifact = artifacts.get(String(args.artifact_id || ""));
  const candidate = artifact?.path || String(args.path || "");
  if (!candidate || !isAbsolute(candidate)) throw new Error("ต้องระบุพาธแบบเต็มหรือ artifact_id");
  return resolve(candidate);
}

async function manageFile(args, settings, approved = false) {
  const action = String(args.action || "read");
  const source = allowedTarget(artifactOrPath(args), settings, approved);
  await assertNoSymlinkEscape(source);

  if (action === "read") {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error("อ่านได้เฉพาะไฟล์");
    if (stat.size > 2 * 1024 * 1024) throw new Error("ไฟล์ใหญ่เกิน 2MB สำหรับการอ่านในแชต");
    return { ok: true, path: source, content: await fs.readFile(source, "utf8") };
  }
  if (action === "open_finder") {
    spawn("/usr/bin/open", ["-R", source], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path: source, message: "แสดงไฟล์ใน Finder แล้ว" };
  }
  if (action === "edit") {
    if (!approved && settings.file_access_mode === "ask") return queueConfirmation("manage_file", args, settings, `อนุญาตให้อัลฟ่าแก้ไฟล์ ${basename(source)} หรือไม่?`);
    const extension = extname(source).toLowerCase();
    if (!mimeByExtension[extension] || [".zip", ".pdf"].includes(extension)) throw new Error("ไฟล์ชนิดนี้ไม่รองรับการแก้ไข");
    const result = await createFiles({ project_name: basename(dirname(source)), destination: dirname(source), files: [{ path: basename(source), content: String(args.content ?? "") }] }, settings, approved);
    return result;
  }
  if (action === "move") {
    if (!approved && settings.file_access_mode === "ask") return queueConfirmation("manage_file", args, settings, `อนุญาตให้ย้ายไฟล์ ${basename(source)} หรือไม่?`);
    if (!isAbsolute(String(args.destination || ""))) throw new Error("ปลายทางต้องเป็นพาธแบบเต็ม");
    const destination = allowedTarget(String(args.destination), settings, approved);
    await assertNoSymlinkEscape(destination);
    await fs.mkdir(dirname(destination), { recursive: true });
    try {
      await fs.access(destination);
      const backup = join(outputsDir, ".alpha-backups", new Date().toISOString().replaceAll(":", "-"), basename(destination));
      await fs.mkdir(dirname(backup), { recursive: true });
      await fs.copyFile(destination, backup);
    } catch { /* no existing destination */ }
    await fs.rename(source, destination);
    const artifact = await hydrateArtifact(registerArtifact(destination, "moved-file"));
    return { ok: true, message: "ย้ายไฟล์เรียบร้อย", artifacts: [artifact] };
  }
  if (action === "zip") {
    const zipName = sanitizeName(args.zip_name || `${basename(source)}.zip`);
    const archivePath = join(outputsDir, zipName.endsWith(".zip") ? zipName : `${zipName}.zip`);
    await fs.rm(archivePath, { force: true });
    await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", source, archivePath], { timeout: 30_000 });
    const artifact = await hydrateArtifact(registerArtifact(archivePath, "archive", "archive"));
    return { ok: true, message: "สร้าง ZIP เรียบร้อย", artifacts: [artifact] };
  }
  if (action === "delete") {
    if (!approved) return queueConfirmation("manage_file", args, settings, `ยืนยันย้าย ${basename(source)} ไปถังขยะหรือไม่?`);
    const trashTarget = join(homedir(), ".Trash", `${basename(source)}-${Date.now()}`);
    await fs.rename(source, trashTarget);
    return { ok: true, message: `ย้าย ${basename(source)} ไปถังขยะแล้ว สามารถกู้คืนได้จาก Trash` };
  }
  throw new Error(`ไม่รองรับคำสั่งไฟล์ ${action}`);
}

async function dockerReady() {
  try { await run("/usr/local/bin/docker", ["info"], { timeout: 5000 }); return true; } catch { return false; }
}

async function refreshStorageState() {
  let available = false;
  try {
    await fs.access(appDir);
    available = true;
  } catch { /* external storage is disconnected */ }
  if (available === storageConnected) return storageConnected;
  storageConnected = available;
  if (available) {
    storageError = "";
    if (lastToolError.includes("External HDD")) lastToolError = "";
    return true;
  }
  storageError = `External HDD ไม่พร้อมที่ ${appDir}`;
  lastToolError = storageError;
  autoLearnAbort?.abort();
  if (autoLearnJob?.status === "running") {
    autoLearnJob.status = "stopped";
    autoLearnJob.stage = "storage_disconnected";
    autoLearnJob.stop_reason = "External HDD ถูกถอดออก — งานถูกหยุดโดยไม่ติดตั้งผลลัพธ์ค้าง";
    autoLearnJob.ended_at = Date.now();
  }
  if (alphaContext) await alphaContext.close().catch(() => {});
  alphaContext = null;
  if (publicInspectionContext) await publicInspectionContext.close().catch(() => {});
  publicInspectionContext = null;
  if (await dockerReady()) {
    await run("/usr/local/bin/docker", ["rm", "-f", "alpha-searxng"], { timeout: 15_000, allowFailure: true }).catch(() => {});
    await removeSkillLabContainers().catch(() => {});
  }
  return false;
}

async function dockerAppRunning() {
  const result = await run("/usr/bin/pgrep", ["-f", "^/Applications/Docker.app/Contents/MacOS/com.docker.backend"], { timeout: 3000, allowFailure: true });
  return result.code === 0 && Boolean(result.stdout.trim());
}

async function quitDockerOpenedByAlpha() {
  if (!dockerOpenedByAlpha) return;
  await run("/usr/bin/osascript", ["-e", 'tell application "Docker" to quit'], { timeout: 5000, allowFailure: true }).catch(() => {});
  if (await dockerAppRunning()) {
    await run("/usr/bin/pkill", ["-f", "^/Applications/Docker.app/Contents/MacOS/com.docker.backend"], { timeout: 3000, allowFailure: true });
  }
  await run("/usr/bin/pkill", ["-f", "Docker Desktop requires privileged access"], { timeout: 3000, allowFailure: true });
}

async function ensureDocker() {
  if (await dockerReady()) return;
  dockerOpenedByAlpha = !(await dockerAppRunning());
  spawn("/usr/bin/open", ["-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    if (await dockerReady()) return;
  }
  throw new Error("Docker Desktop เปิดไม่สำเร็จ");
}

async function ensureSearxng() {
  if (!await refreshStorageState()) throw new Error(storageError);
  try {
    const response = await fetch("http://127.0.0.1:8888/healthz", { signal: AbortSignal.timeout(1500) });
    if (response.ok) return;
  } catch { /* start below */ }
  await ensureDocker();
  await run("/usr/local/bin/docker", ["compose", "-f", composeFile, "up", "-d"], { timeout: 180_000 });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    try {
      const response = await fetch("http://127.0.0.1:8888/", { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* keep waiting */ }
  }
  throw new Error("SearXNG ยังไม่พร้อมใช้งาน");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");
}

function stripHtml(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function duckDuckGoTarget(rawHref) {
  try {
    const parsed = new URL(decodeEntities(rawHref), "https://html.duckduckgo.com");
    return parsed.searchParams.get("uddg") || parsed.toString();
  } catch {
    return "";
  }
}

async function searchDuckDuckGo(query, degradedReason = "") {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", String(query).slice(0, 400));
  url.searchParams.set("kl", "th-th");
  url.searchParams.set("kp", "1");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 AlphaLocalAssistant/1.0", Accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ระบบค้นสำรองตอบกลับ ${response.status}`);
  const html = await response.text();
  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result(?:\s|__)[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const target = duckDuckGoTarget(anchor[1]);
    if (!/^https?:\/\//i.test(target)) continue;
    const snippetMatch = block.match(/<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    results.push({ title: stripHtml(anchor[2]), url: target, snippet: stripHtml(snippetMatch?.[1] || "") });
    if (results.length >= 8) break;
  }
  if (!results.length) throw new Error("ระบบค้นสำรองไม่พบผลลัพธ์หรือถูกจำกัดชั่วคราว");
  return { ok: true, results, backend: "duckduckgo", degraded_reason: degradedReason || "SearXNG ไม่พร้อม จึงใช้ DuckDuckGo แบบข้อความ" };
}

async function searchWeb(query) {
  lastHeavyUse = Date.now();
  let searxError = "";
  try {
    await ensureSearxng();
  } catch (error) {
    searxError = error instanceof Error ? error.message : "SearXNG ไม่พร้อม";
    return searchDuckDuckGo(query, searxError);
  }
  const url = new URL("http://127.0.0.1:8888/search");
  url.searchParams.set("q", String(query).slice(0, 400));
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "2");
  url.searchParams.set("categories", "general");
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return searchDuckDuckGo(query, `SearXNG ตอบกลับ ${response.status}`);
  const payload = await response.json();
  const results = (payload.results || []).slice(0, 8).map((item) => ({ title: String(item.title || ""), url: String(item.url || ""), snippet: stripHtml(item.content || "") }));
  if (!results.length) return searchDuckDuckGo(query, "SearXNG ไม่พบผลลัพธ์");
  return { ok: true, results, backend: "searxng", degraded_reason: "" };
}

function privateIp(address) {
  if (!net.isIP(address)) return true;
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("รองรับเฉพาะ URL แบบ HTTP/HTTPS");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new Error("ไม่อนุญาต URL ภายในเครื่อง");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => privateIp(item.address))) throw new Error("URL ชี้ไปยังเครือข่ายภายในหรือพิเศษ");
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, value) => { const code = Number(value); return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " "; })
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => { const code = Number.parseInt(value, 16); return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " "; })
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&copy;/gi, "©")
    .replace(/\s+/g, " ").trim();
}

async function readWebPage(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  let response;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "AlphaLocalAssistant/1.0", Accept: "text/html,application/pdf,text/plain" }, signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await assertPublicUrl(new URL(response.headers.get("location"), url).toString());
      continue;
    }
    break;
  }
  if (!response?.ok) throw new Error(`เว็บไซต์ตอบกลับ ${response?.status || "ไม่ได้"}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 20 * 1024 * 1024) throw new Error("หน้าเว็บหรือเอกสารใหญ่เกิน 20MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("หน้าเว็บหรือเอกสารใหญ่เกิน 20MB");
  const contentType = response.headers.get("content-type") || "";
  let text = "";
  let title = "";
  if (contentType.includes("pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
    const pages = [];
    for (let index = 1; index <= Math.min(pdf.numPages, 50); index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    text = pages.join("\n\n");
    title = basename(url.pathname) || "PDF";
  } else {
    const raw = new TextDecoder().decode(bytes);
    if (contentType.includes("html")) {
      title = htmlToText(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").slice(0, 160);
      text = htmlToText(raw);
    } else {
      text = raw;
    }
  }
  return { ok: true, url: url.toString(), title: title || url.hostname, content: text.slice(0, 60_000) };
}

async function ensureAlphaBrowser() {
  lastHeavyUse = Date.now();
  if (alphaContext) return alphaContext;
  await fs.mkdir(browserProfileDir, { recursive: true });
  alphaContext = await chromium.launchPersistentContext(browserProfileDir, {
    channel: "chrome",
    headless: false,
    // Chrome on macOS has its own sandbox. Playwright's Linux-oriented
    // --no-sandbox default both weakens isolation and makes the window look
    // abnormal to strict CDNs.
    ignoreDefaultArgs: ["--no-sandbox", "--enable-automation"],
    acceptDownloads: true,
    downloadsPath: outputsDir,
    viewport: { width: 1280, height: 820 },
  });
  alphaContext.on("close", () => { alphaContext = null; });
  return alphaContext;
}

async function ensurePublicInspectionBrowser() {
  lastHeavyUse = Date.now();
  if (publicInspectionContext) return publicInspectionContext;
  await fs.mkdir(publicInspectionProfileDir, { recursive: true });
  publicInspectionContext = await chromium.launchPersistentContext(publicInspectionProfileDir, {
    channel: "chrome",
    // ThaiTicketMajor's CDN rejects Chrome's headless transport even for public
    // event pages. A normal isolated Chrome window can read the same public
    // page without moving the user's system pointer or using their profile.
    headless: false,
    ignoreDefaultArgs: ["--no-sandbox", "--enable-automation"],
    acceptDownloads: false,
    viewport: { width: 1280, height: 820 },
  });
  publicInspectionContext.on("close", () => {
    publicInspectionContext = null;
  });
  return publicInspectionContext;
}

async function throttlePublicInspectionNavigation(rawUrl) {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  const previous = Number(publicInspectionNavigationAt.get(hostname) || 0);
  const remaining = 2_500 - (Date.now() - previous);
  if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
  publicInspectionNavigationAt.set(hostname, Date.now());
}

async function browserRisk(page) {
  const url = page.url().toLowerCase();
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  if (/captcha|recaptcha|hcaptcha|ยืนยันว่า.*มนุษย์/.test(body)) return "captcha";
  if (/checkout|payment|billing|credit.card|ชำระเงิน|บัตรเครดิต/.test(url + " " + body.slice(0, 5000))) return "financial";
  return "";
}

function classifyFormControl(control) {
  const haystack = `${control.type || ""} ${control.name || ""} ${control.id || ""} ${control.autocomplete || ""} ${control.label || ""} ${control.placeholder || ""} ${control.aria_label || ""}`.toLowerCase();
  const label = String(control.label || "").trim();
  const href = String(control.href || "").toLowerCase();
  const dataButton = String(control.data_button || "");
  const targetUrl = String(control.target_url || "").toLowerCase();
  if (/order\s*history|purchase\s*history|ประวัติการสั่งซื้อ/.test(haystack)) return "unknown";
  // Recommended-event cards and social links can also say "ซื้อบัตร" or sit
  // inside a purchase-themed section. They are navigation, not a purchase
  // control for the event currently being inspected.
  if (/facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|utm_source=ttm-index|ticketmaster\.co\.th\/activity\/detail/.test(href)) return "unknown";
  if (String(control.type).toLowerCase() === "password" || /password|passcode|รหัสผ่าน/.test(haystack)) return "password";
  if (/one-time|otp|verification.code|รหัสยืนยัน/.test(haystack)) return "otp";
  if (/user(name)?|login|member|email|อีเมล|ผู้ใช้/.test(haystack)) return "username_or_email";
  if (/concert|event|show|performance|คอนเสิร์ต|การแสดง/.test(haystack)) return "event";
  if (/date|day|schedule|round|session|รอบ|วันที่|เวลา|เลือกรอบ/.test(haystack) || /^\s*\d{1,2}:\d{2}(?:\s*(?:ซื้อบัตร|จองบัตร))?\s*$/i.test(label)) return "schedule";
  if (/zone|section|seat|ที่นั่ง|โซน/.test(haystack)) return "seat_or_zone";
  if (/quantity|qty|amount|ticket.count|จำนวน/.test(haystack)) return "quantity";
  if (/address|district|province|postal|zip|ที่อยู่|จังหวัด|ไปรษณีย์/.test(haystack)) return "address";
  if (/name|ชื่อ/.test(haystack)) return "customer_name";
  if (/qr|promptpay|payment|ชำระ|พร้อมเพย์/.test(haystack)) return "payment_method";
  if (/buy|purchase|reserve|book|checkout|ซื้อ|จอง|ดำเนินการต่อ/.test(haystack)
    && (dataButton || /booking\.thaiticketmajor\.com/.test(`${href} ${targetUrl}`) || !href)) return "purchase_action";
  return "unknown";
}

async function browserAccessBlock(page) {
  const title = String(await page.title().catch(() => ""));
  const body = String(await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 10_000);
  const combined = `${title}\n${body}`;
  if (/access\s*denied|permission\s+to\s+access|errors\.edgesuite\.net|reference\s*#[\d.]+/i.test(combined)) {
    return { blocked: true, reason: "เว็บไซต์ปฏิเสธหน้า public ใน browser session นี้", title, body };
  }
  return { blocked: false, reason: "", title, body };
}

async function inspectBrowserForm(page) {
  const accessBlock = await browserAccessBlock(page);
  if (accessBlock.blocked) {
    return {
      ok: false,
      access_blocked: true,
      block_reason: accessBlock.reason,
      url: page.url(),
      title: accessBlock.title,
      controls: [],
      candidates: {},
      ambiguous_roles: [],
      facts: {},
      functional_preflight: { passed: false, public_page_verified: false, unresolved: ["access_denied"], can_build: false },
    };
  }
  const controls = await page.locator("input, select, textarea, button, a[href], [role=button], [role=option]").evaluateAll((nodes) => nodes.slice(0, 500).map((node) => {
    const element = node;
    const id = element.getAttribute("id") || "";
    const name = element.getAttribute("name") || "";
    const dataButton = element.getAttribute("data-button") || "";
    const href = element.getAttribute("href") || "";
    const onclick = element.getAttribute("onclick") || "";
    const targetMatch = onclick.match(/https?:\/\/[^'"\s)]+/i);
    const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || "" : "";
    const wrapping = element.closest("label")?.textContent || "";
    const selector = id ? `#${CSS.escape(id)}`
      : name ? `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
        : element.getAttribute("data-testid") ? `[data-testid="${CSS.escape(element.getAttribute("data-testid"))}"]`
          : dataButton ? `[data-button="${CSS.escape(dataButton)}"]`
          : element.tagName === "A" && element.getAttribute("href") && !String(element.getAttribute("href")).startsWith("javascript:")
            ? `a[href="${CSS.escape(element.getAttribute("href"))}"]`
          : "";
    const options = element.tagName === "SELECT"
      ? [...element.options].slice(0, 100).map((option) => ({ text: String(option.textContent || "").trim().slice(0, 160), value: String(option.value || "").slice(0, 160) }))
      : [];
    return {
      tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", id, name,
      autocomplete: element.getAttribute("autocomplete") || "", placeholder: element.getAttribute("placeholder") || "",
      aria_label: element.getAttribute("aria-label") || "", label: String(explicit || wrapping || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
      context_text: String(element.closest("tr, li, .row, .showtime, .round, .event, article, section, div")?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300),
      selector, data_button: dataButton, href: href.slice(0, 2_000), target_url: String(targetMatch?.[0] || "").slice(0, 2_000), options,
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true" || element.classList.contains("disabled"), required: Boolean(element.required),
    };
  }));
  const mapped = controls.map((control) => ({ ...control, semantic_role: classifyFormControl(control), selector_confidence: control.selector ? (control.id ? 0.98 : 0.9) : 0.35 }));
  const candidates = {};
  for (const control of mapped) {
    if (control.semantic_role === "unknown") continue;
    (candidates[control.semantic_role] ||= []).push(control);
  }
  const ambiguous_roles = Object.entries(candidates).filter(([, items]) => items.length > 1).map(([role]) => role);
  const pageSnapshot = await page.evaluate(() => {
    const structured_events = [];
    const visit = (item) => {
      if (!item || typeof item !== "object") return;
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (types.some((type) => /event/i.test(String(type || "")))) {
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers || {};
        structured_events.push({
          name: String(item.name || item.headline || ""),
          start_date: String(item.startDate || ""),
          sale_open_at: String(offers.validFrom || item.saleOpenAt || ""),
        });
      }
      if (Array.isArray(item["@graph"])) item["@graph"].forEach(visit);
      if (Array.isArray(item.itemListElement)) item.itemListElement.forEach((entry) => visit(entry?.item || entry));
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(visit);
      } catch { /* ignore invalid structured data */ }
    }
    return {
      url: location.href,
      title: document.title,
      body_text: String(document.body?.innerText || "").slice(0, 60_000),
      structured_events: structured_events.slice(0, 30),
      announced_performances: [...document.querySelectorAll(".box-event-list .row")].map((row) => {
        const control = row.querySelector("a[data-button], button[data-button], a[onclick*='zones.php'], a[onclick*='rdId'], a, button");
        const product = row.closest(".event-detail-item");
        const productText = String(product?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 2_000);
        const productBase = productText.split(/ราคาบัตร|ticket\s*price|วันที่แสดง/i)[0].trim();
        const productQualifier = productText.match(/\((?:Mastercard Preferred|[^)]*(?:pre[- ]?sale|presale)[^)]*)\)/i)?.[0] || "";
        const productName = `${productBase}${productQualifier ? ` ${productQualifier}` : ""}`.trim().slice(0, 160);
        const productType = /rerun/i.test(productName) ? "rerun"
          : /live\s*stream|ttm\s*live/i.test(productName) ? "live_stream"
            : "in_person";
        const onclick = control?.getAttribute("onclick") || "";
        const targetMatch = onclick.match(/https?:\/\/[^'"\s)]+/i);
        const dataButton = control?.getAttribute("data-button") || "";
        const text = String(row.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
        const label = String(control?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
        // Some TTM product rows do not expose the historical `row-enable`
        // class even though their visible control is active. Treat only an
        // actually absent/disabled control as unavailable.
        const disabled = !control || Boolean(control.disabled) || control.getAttribute("aria-disabled") === "true" || control.classList.contains("disabled");
        const status = /sold\s*out|ขายหมด/i.test(text) ? "sold_out"
          : /ปิดขาย|sale\s*ended|closed/i.test(text) ? "closed"
            : !disabled && /ซื้อบัตร|จองบัตร|buy\s*(?:now|ticket)|book\s*now/i.test(`${label} ${text}`) ? "open"
              : "upcoming";
        return {
          label,
          context_text: text,
          product_name: productName,
          product_type: productType,
          status,
          selectable: status === "open",
          selector: dataButton ? `[data-button="${CSS.escape(dataButton)}"]` : "",
          data_button: dataButton,
          target_url: String(targetMatch?.[0] || "").slice(0, 2_000),
          disabled,
        };
      }).filter((item) => /(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s*\d{4})/.test(`${item.label} ${item.context_text}`)).slice(0, 50),
      discovered_zones: [...new Set([...document.querySelectorAll("area[href*='#'], [data-zone], [data-section]")].map((element) => {
        const href = String(element.getAttribute("href") || "");
        return String(element.getAttribute("data-zone") || element.getAttribute("data-section") || element.getAttribute("alt") || element.getAttribute("title") || href.split("#").pop() || "").trim();
      }).filter(Boolean))].slice(0, 100),
      discovered_rows: [...new Set([...document.querySelectorAll("[data-row]")].map((element) => String(element.getAttribute("data-row") || "").trim()).filter(Boolean))].slice(0, 200),
      seat_map_detected: Boolean(document.querySelector("map area, [data-seat], [data-zone], [data-section], [data-row]")),
    };
  });
  const facts = extractTicketPageFacts({ ...pageSnapshot, controls: mapped });
  const functional_preflight = evaluateTicketPreflight(facts);
  return {
    ok: true,
    url: page.url(),
    title: await page.title(),
    controls: mapped,
    candidates,
    ambiguous_roles,
    needs_user_clarification: ambiguous_roles.length > 0,
    facts,
    functional_preflight,
  };
}

async function inspectBrowserEvents(page) {
  const accessBlock = await browserAccessBlock(page);
  if (accessBlock.blocked) {
    return {
      ok: false,
      access_blocked: true,
      block_reason: accessBlock.reason,
      url: page.url(),
      title: accessBlock.title,
      events: [],
      excluded_count: 0,
      counts: { open: 0, upcoming: 0, sold_out: 0, closed: 0, ended: 0, cancelled: 0 },
      inventory_scope: "not_checked",
    };
  }
  const rawEvents = await page.evaluate(() => {
    const records = [];
    const pushRecord = (item) => {
      if (!item || typeof item !== "object") return;
      const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers || {};
      const name = String(item.name || item.headline || "").trim();
      if (!name) return;
      records.push({
        source: "structured_data",
        id: String(item.identifier?.value || item.identifier || item["@id"] || item.url || name).slice(0, 300),
        name: name.slice(0, 240),
        start_date: String(item.startDate || ""),
        end_date: String(item.endDate || ""),
        sale_open_at: String(offers.validFrom || item.saleOpenAt || ""),
        availability: String(offers.availability || ""),
        event_status: String(item.eventStatus || ""),
        url: String(item.url || offers.url || location.href),
        text: "",
      });
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          if (types.some((type) => /event/i.test(String(type || "")))) pushRecord(item);
          if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
          if (Array.isArray(item.itemListElement)) queue.push(...item.itemListElement.map((entry) => entry?.item || entry));
        }
      } catch { /* invalid JSON-LD */ }
    }
    const selectors = [
      "article", "[data-event-id]", "[data-event]", "[class*='event-card']", "[class*='eventCard']",
      "[class*='concert-card']", "[class*='concertCard']", "a[href*='/event']", "a[href*='/concert']",
    ].join(",");
    for (const element of [...document.querySelectorAll(selectors)].slice(0, 500)) {
      const card = element.matches("article,[data-event-id],[data-event],[class*='event-card'],[class*='eventCard'],[class*='concert-card'],[class*='concertCard']")
        ? element
        : element.closest("article,li,[data-event-id],[data-event],[class*='event-card'],[class*='eventCard'],[class*='concert-card'],[class*='concertCard']") || element;
      const text = String(card.innerText || card.textContent || element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 900);
      if (text.length < 3) continue;
      const heading = element.querySelector("h1,h2,h3,h4,[role=heading]") || card.querySelector("h1,h2,h3,h4,[role=heading]");
      const link = element.matches("a[href]") ? element : element.querySelector("a[href]");
      const times = [...card.querySelectorAll("time")];
      const imageAlt = card.querySelector("img[alt]")?.getAttribute("alt") || "";
      const name = String(heading?.textContent || imageAlt || element.getAttribute("aria-label") || text.split(/\s[|·•-]\s/)[0] || text).trim().replace(/\s+/g, " ").slice(0, 240);
      const url = link ? new URL(link.getAttribute("href"), location.href).toString() : location.href;
      records.push({
        source: "page_card",
        id: String(element.getAttribute("data-event-id") || url || name).slice(0, 300),
        name,
        start_date: String(times[0]?.getAttribute("datetime") || ""),
        end_date: String(times[1]?.getAttribute("datetime") || ""),
        sale_open_at: String(element.getAttribute("data-sale-open-at") || ""),
        availability: "",
        event_status: "",
        url,
        text,
      });
    }
    return records;
  });
  const now = Date.now();
  const closedPattern = /sold.?out|sale.?ended|closed|cancelled|canceled|past.?event|หมดเขต|ปิดขาย|ยกเลิก|สิ้นสุดแล้ว|ขายหมด/;
  const openPattern = /on.?sale|buy.?now|book.?now|available|จำหน่ายแล้ว|เปิดขาย|ซื้อบัตร|จองบัตร/;
  const upcomingPattern = /coming.?soon|sale.?starts|on.?sale.?soon|เร็ว.?ๆ.?นี้|เตรียมเปิดขาย|เปิดขายวันที่|เริ่มจำหน่าย/;
  const genericNamePattern = /^(?:ซื้อบัตร|จองบัตร|buy(?:\s+now)?|book(?:\s+now)?|คอนเสิร์ต|concerts?|events?|กิจกรรม)$/i;
  const candidateScore = (candidate) => {
    const name = String(candidate.name || "").trim();
    return (candidate.source === "structured_data" ? 200 : 0)
      + (genericNamePattern.test(name) ? 0 : 120)
      + (candidate.start_date ? 30 : 0)
      + (candidate.sale_open_at ? 20 : 0)
      + Math.min(60, name.length);
  };
  const mergedByUrl = new Map();
  for (const candidate of rawEvents) {
    let normalizedUrl;
    try {
      const parsed = new URL(String(candidate.url || ""), page.url());
      parsed.hash = "";
      parsed.search = "";
      normalizedUrl = parsed.toString().replace(/\/$/, "");
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2 && /^(?:concert|concerts|event|events)$/i.test(segments[0] || "")) continue;
    } catch { continue; }
    const current = mergedByUrl.get(normalizedUrl);
    if (!current) {
      mergedByUrl.set(normalizedUrl, { ...candidate, normalized_url: normalizedUrl });
      continue;
    }
    const preferred = candidateScore(candidate) > candidateScore(current) ? candidate : current;
    const fallback = preferred === candidate ? current : candidate;
    mergedByUrl.set(normalizedUrl, {
      ...preferred,
      normalized_url: normalizedUrl,
      start_date: preferred.start_date || fallback.start_date,
      end_date: preferred.end_date || fallback.end_date,
      sale_open_at: preferred.sale_open_at || fallback.sale_open_at,
      availability: preferred.availability || fallback.availability,
      event_status: preferred.event_status || fallback.event_status,
      text: `${preferred.text || ""} ${fallback.text || ""}`.trim().slice(0, 1200),
    });
  }
  const seen = new Set();
  const eligible = [];
  const excluded = [];
  for (const candidate of mergedByUrl.values()) {
    if (genericNamePattern.test(String(candidate.name || "").trim())) continue;
    const key = String(candidate.normalized_url || candidate.url || "");
    if (seen.has(key)) continue;
    seen.add(key);
    const combined = `${candidate.availability || ""} ${candidate.event_status || ""} ${candidate.text || ""}`.toLowerCase();
    const startAt = Date.parse(candidate.start_date || "");
    const endAt = Date.parse(candidate.end_date || "");
    const saleAt = Date.parse(candidate.sale_open_at || "");
    const dateExpired = Number.isFinite(endAt) ? endAt < now : Number.isFinite(startAt) ? startAt < now - 24 * 60 * 60 * 1000 : false;
    const isClosed = dateExpired || closedPattern.test(combined);
    const statusEvidence = String(candidate.text || candidate.availability || candidate.event_status || "").slice(0, 300);
    let sale_status = "open";
    if (Number.isFinite(saleAt) && saleAt > now) sale_status = "upcoming";
    else if (upcomingPattern.test(combined) || (Number.isFinite(startAt) && startAt > now && !openPattern.test(combined))) sale_status = "upcoming";
    if (isClosed) {
      const closedStatus = /sold.?out|ขายหมด/.test(combined) ? "sold_out"
        : /cancelled|canceled|ยกเลิก/.test(combined) ? "cancelled"
          : dateExpired ? "ended" : "closed";
      excluded.push({
        id: candidate.normalized_url || candidate.id || candidate.url,
        name: candidate.name,
        url: candidate.normalized_url || candidate.url,
        start_date: candidate.start_date,
        end_date: candidate.end_date,
        sale_open_at: candidate.sale_open_at,
        sale_status: closedStatus,
        source: candidate.source,
        selectable: false,
        status_evidence: statusEvidence,
        inventory_status: closedStatus === "sold_out" ? "sold_out" : "not_checked",
        inventory_evidence: closedStatus === "sold_out" ? "explicit_sold_out_label_on_listing" : "listing_only",
        exclusion_reason: dateExpired ? "event_ended" : "sale_closed",
      });
      continue;
    }
    eligible.push({
      id: candidate.normalized_url || candidate.id || candidate.url,
      name: candidate.name,
      url: candidate.normalized_url || candidate.url,
      start_date: candidate.start_date,
      end_date: candidate.end_date,
      sale_open_at: candidate.sale_open_at,
      sale_status,
      source: candidate.source,
      selectable: true,
      status_evidence: statusEvidence,
      inventory_status: "not_checked",
      inventory_evidence: "sale_window_label_only",
    });
  }
  const statusOrder = { open: 0, upcoming: 1, sold_out: 2, closed: 3, ended: 4, cancelled: 5 };
  const events = [...eligible, ...excluded];
  events.sort((a, b) => {
    const statusDifference = (statusOrder[a.sale_status] ?? 9) - (statusOrder[b.sale_status] ?? 9);
    if (statusDifference) return statusDifference;
    const aTime = Date.parse(a.start_date || a.sale_open_at || "") || Number.MAX_SAFE_INTEGER;
    const bTime = Date.parse(b.start_date || b.sale_open_at || "") || Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.name.localeCompare(b.name, "th");
  });
  const counts = events.reduce((result, event) => {
    result[event.sale_status] = (result[event.sale_status] || 0) + 1;
    return result;
  }, { open: 0, upcoming: 0, sold_out: 0, closed: 0, ended: 0, cancelled: 0 });
  return {
    ok: true,
    url: page.url(),
    title: await page.title(),
    events: events.slice(0, 100),
    excluded_count: excluded.length,
    counts,
    inventory_scope: "listing_only",
    inventory_instruction: "สถานะ open หมายถึงช่วงขายเปิดแล้ว ไม่ได้ยืนยันว่ามีที่นั่ง ต้องตรวจ inventory หลัง Login ในหน้าเลือกโซน/ที่นั่ง",
    needs_user_choice: eligible.length > 0,
    selection_instruction: eligible.length
      ? "แสดงชื่อคอนเสิร์ต วันที่แสดง และวันเปิดขายทั้งหมดนี้ให้ผู้ใช้เลือกก่อนสร้างโปรแกรม"
      : "ไม่พบคอนเสิร์ตที่เปิดขายหรือกำลังจะเปิดจากหน้าปัจจุบัน",
  };
}

async function alphaBrowserAction(action, args) {
  if (action === "reset_public_inspection") {
    if (publicInspectionContext) await publicInspectionContext.close().catch(() => {});
    publicInspectionContext = null;
    return { ok: true, action, reset: true };
  }
  const context = args.public_inspection === true ? await ensurePublicInspectionBrowser() : await ensureAlphaBrowser();
  let pages = context.pages();
  let page = pages.at(-1) || await context.newPage();
  if (pages.length > 3) {
    await pages[0].close();
    pages = context.pages();
    page = pages.at(-1);
  }
  if (action === "open") {
    const url = (await assertPublicUrl(args.url)).toString();
    if (args.fresh_page === true) {
      page = await context.newPage();
      pages = context.pages();
      if (args.public_inspection === true) {
        for (const candidate of pages.filter((item) => item !== page)) await candidate.close().catch(() => {});
      } else {
        while (pages.length > 3) {
          const candidate = pages.find((item) => item !== page);
          if (!candidate) break;
          await candidate.close();
          pages = context.pages();
        }
      }
    }
    if (args.public_inspection === true) await throttlePublicInspectionNavigation(url);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (args.public_inspection === true) {
      const status = response?.status() || 0;
      const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 5000);
      const accessBlocked = [401, 403].includes(status)
        || /access\s*denied|permission\s+to\s+access|errors\.edgesuite\.net/i.test(`${await page.title().catch(() => "")} ${body}`);
      if (accessBlocked) {
        const blockedUrl = page.url();
        // Do not leave a raw CDN error window in front of the user. The API
        // reports the exact denial and can use an official listing fallback.
        await page.close().catch(() => {});
        return {
          ok: false,
          access_blocked: true,
          block_reason: status ? `HTTP ${status} Access Denied` : "Access Denied",
          url: blockedUrl,
          title: "Access Denied",
          content: body,
        };
      }
    }
  } else if (action === "inspect_form") {
    return inspectBrowserForm(page);
  } else if (action === "inspect_events") {
    return inspectBrowserEvents(page);
  } else if (action === "scroll") {
    await page.mouse.wheel(0, Number(args.y || 700));
  } else if (action === "click") {
    const locator = args.selector ? page.locator(String(args.selector)).first() : page.getByText(String(args.text || ""), { exact: false }).first();
    await locator.click({ timeout: 10_000 });
  } else if (action === "type") {
    const locator = page.locator(String(args.selector || "input, textarea")).first();
    const type = (await locator.getAttribute("type") || "").toLowerCase();
    const name = `${await locator.getAttribute("name") || ""} ${await locator.getAttribute("autocomplete") || ""}`.toLowerCase();
    if (type === "password" || /password|otp|one-time|cc-|card|cvv/.test(name)) return { ok: false, handoff_required: true, reason: "ข้อมูลรหัสผ่าน OTP หรือการเงินต้องให้ผู้ใช้กรอกเอง" };
    await locator.fill(String(args.text || ""));
  } else if (action === "download") {
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    const locator = args.selector ? page.locator(String(args.selector)).first() : page.getByText(String(args.text || "ดาวน์โหลด"), { exact: false }).first();
    await locator.click();
    const download = await downloadPromise;
    const target = join(outputsDir, sanitizeName(download.suggestedFilename(), "download.bin"));
    await download.saveAs(target);
    const artifact = await hydrateArtifact(registerArtifact(target, "browser-download"));
    return { ok: true, artifact, artifacts: [artifact], url: page.url(), title: await page.title() };
  } else if (action === "upload") {
    const filePath = assertNotBlocked(resolve(String(args.file_path || "")));
    await assertNoSymlinkEscape(filePath);
    const locator = page.locator(String(args.selector || "input[type=file]")).first();
    await locator.setInputFiles(filePath);
  } else if (action === "submit") {
    const riskBeforeSubmit = await browserRisk(page);
    if (riskBeforeSubmit) return { ok: false, handoff_required: true, reason: riskBeforeSubmit === "captcha" ? "พบ CAPTCHA ต้องให้ผู้ใช้รับช่วง" : "พบหน้าการเงิน ต้องให้ผู้ใช้รับช่วง" };
    const locator = args.selector ? page.locator(String(args.selector)).first() : page.locator("button[type=submit], input[type=submit]").first();
    await locator.click({ timeout: 10_000 });
  }
  const risk = await browserRisk(page);
  if (risk) return { ok: false, handoff_required: true, reason: risk === "captcha" ? "พบ CAPTCHA ต้องให้ผู้ใช้รับช่วง" : "พบหน้าการเงิน ต้องให้ผู้ใช้รับช่วง" };
  const text = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 20_000);
  return { ok: true, url: page.url(), title: await page.title(), content: text };
}

function extensionRequest(command) {
  return new Promise((resolveRequest, reject) => {
    const client = [...extensionClients].find((socket) => socket.readyState === 1);
    if (!client) return reject(new Error("Chrome Extension ยังไม่ได้เชื่อมต่อ"));
    const id = randomUUID();
    const timer = setTimeout(() => reject(new Error("Chrome Extension ไม่ตอบกลับ")), 30_000);
    const listener = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        clearTimeout(timer);
        client.off("message", listener);
        resolveRequest(message.result);
      } catch { /* ignore unrelated messages */ }
    };
    client.on("message", listener);
    client.send(JSON.stringify({ id, ...command }));
  });
}

async function browserAction(args, settings, approved = false) {
  lastHeavyUse = Date.now();
  const action = String(args.action || "snapshot");
  if (settings.browser_mode === "off") throw new Error("ปิดเครื่องมือเบราว์เซอร์อยู่");
  if (action === "open") args.url = (await assertPublicUrl(args.url)).toString();
  if (action === "upload") {
    const filePath = allowedTarget(resolve(String(args.file_path || "")), settings, approved);
    await assertNoSymlinkEscape(filePath);
    args.file_path = filePath;
  }
  if (settings.browser_mode === "chrome") return extensionRequest({ action, args });
  return alphaBrowserAction(action, args);
}

async function assertSecurityTarget(raw, settings, requireListed = false) {
  const url = new URL(String(raw || ""));
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Security Lab รองรับเฉพาะ HTTP/HTTPS");
  const hostname = url.hostname.toLowerCase();
  const allowed = (Array.isArray(settings.security_test_domains) ? settings.security_test_domains : [])
    .map((item) => String(item).toLowerCase());
  const listed = allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (requireListed && !listed) {
    throw new Error(`โดเมน ${hostname} ยังไม่อยู่ใน Security Test Domains`);
  }
  if (!listed) await assertPublicUrl(url.toString());
  return url;
}

function redactStructured(value, key = "") {
  if (/pass(word)?|secret|token|authorization|cookie|otp|session|api[-_]?key|credit|card|cvv/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactStructured(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([childKey, child]) => [childKey, redactStructured(child, childKey)]));
  return typeof value === "string" ? value.slice(0, 1000) : value;
}

function redactBody(value) {
  const text = String(value || "").slice(0, 20_000);
  if (!text) return null;
  try { return redactStructured(JSON.parse(text)); } catch {
    return text.replace(/((?:password|secret|token|authorization|cookie|otp|api[_-]?key)\s*[=:]\s*)[^&\s]+/gi, "$1[REDACTED]");
  }
}

function jsonShape(value, depth = 0) {
  if (depth > 5) return "unknown";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [jsonShape(value[0], depth + 1)] : [];
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, child]) => [key, jsonShape(child, depth + 1)]));
  return typeof value;
}

async function apiDiscovery(args, settings) {
  lastHeavyUse = Date.now();
  if (settings.browser_mode !== "alpha") throw new Error("API Discovery Lab ต้องเลือก Alpha Browser ใน Settings");
  const action = String(args.action || "discover");
  const context = args.public_inspection === true ? await ensurePublicInspectionBrowser() : await ensureAlphaBrowser();

  if (action === "probe") {
    const method = String(args.method || "GET").toUpperCase();
    if (!new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]).has(method)) throw new Error("method ไม่อยู่ในรายการที่รองรับ");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const target = await assertSecurityTarget(args.url, settings, mutating);
    if (mutating && settings.security_active_testing_enabled !== true) {
      throw new Error("ต้องเปิด Active API Testing ก่อนใช้ POST, PUT, PATCH หรือ DELETE");
    }
    const suppliedHeaders = args.headers && typeof args.headers === "object" ? args.headers : {};
    const headers = Object.fromEntries(Object.entries(suppliedHeaders).filter(([key]) => !/authorization|cookie|token|secret|api[-_]?key/i.test(key)).slice(0, 20).map(([key, value]) => [key, String(value).slice(0, 1000)]));
    const body = args.body === undefined ? undefined : typeof args.body === "string" ? args.body.slice(0, 100_000) : JSON.stringify(args.body);
    const response = await context.request.fetch(target.toString(), { method, headers, data: body, timeout: 30_000, maxRedirects: 3 });
    const contentType = response.headers()["content-type"] || "";
    const text = (await response.text().catch(() => "")).slice(0, 30_000);
    let schema = null;
    if (/json/i.test(contentType)) {
      try { schema = jsonShape(JSON.parse(text)); } catch { /* invalid JSON response */ }
    }
    return { ok: response.ok(), action, method, url: target.toString(), status: response.status(), content_type: contentType, response_schema: schema, response_preview: redactBody(text) };
  }

  const target = await assertSecurityTarget(args.url, settings, false);
  if (action === "observe_existing") {
    const page = context.pages().at(-1);
    if (!page || !/^https?:/i.test(page.url())) throw new Error("ไม่มีหน้าปัจจุบันสำหรับอ่าน Network แบบ passive");
    const current = await assertSecurityTarget(page.url(), settings, false);
    if (current.hostname !== target.hostname) throw new Error("หน้าปัจจุบันไม่ตรงกับโดเมนที่ขอตรวจ API");
    const accessBlock = await browserAccessBlock(page);
    if (accessBlock.blocked) return { ok: false, action, access_blocked: true, block_reason: accessBlock.reason, page: { url: page.url(), title: accessBlock.title }, api_calls: [], forms: [], options: [], secrets_redacted: true };
    const forms = await page.locator("form").evaluateAll((items) => items.slice(0, 30).map((form) => ({
      action: (form instanceof HTMLFormElement ? form.action : ""),
      method: (form instanceof HTMLFormElement ? form.method : "GET").toUpperCase(),
      fields: [...form.querySelectorAll("input, textarea, select")].slice(0, 50).map((field) => ({
        name: field.getAttribute("name") || "", type: field.getAttribute("type") || field.tagName.toLowerCase(), required: field.hasAttribute("required"),
      })).filter((field) => field.name && !/pass|secret|token|otp|card|cvv/i.test(field.name)),
    })));
    const resources = await page.evaluate(() => performance.getEntriesByType("resource").slice(-250).flatMap((entry) => {
      const resource = entry;
      const initiator = String(resource.initiatorType || "").toLowerCase();
      if (!new Set(["fetch", "xmlhttprequest"]).has(initiator)) return [];
      return [{ url: resource.name, method: "", resource_type: initiator === "xmlhttprequest" ? "xhr" : "fetch", status: null, content_type: "", response_content_type: "" }];
    }));
    const apiCalls = resources.flatMap((item) => {
      try {
        const resourceUrl = new URL(item.url);
        return [{ ...item, same_origin: resourceUrl.origin === target.origin }];
      } catch { return []; }
    }).slice(0, 100);
    return { ok: true, action, page: { url: page.url(), title: await page.title() }, api_calls: apiCalls, forms, options: [], passive_existing_page: true, secrets_redacted: true };
  }
  const page = await context.newPage();
  const calls = new Map();
  const onRequest = (request) => {
    if (!new Set(["fetch", "xhr"]).has(request.resourceType())) return;
    try {
      const url = new URL(request.url());
      const headers = request.headers();
      calls.set(request.url(), {
        url: request.url(), method: request.method(), resource_type: request.resourceType(),
        same_origin: url.origin === target.origin, content_type: headers["content-type"] || "",
        request_body: redactBody(request.postData()), status: null, response_content_type: "",
      });
    } catch { /* ignore malformed request URL */ }
  };
  const onResponse = (response) => {
    const record = calls.get(response.url());
    if (!record) return;
    record.status = response.status();
    record.response_content_type = response.headers()["content-type"] || "";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(Math.min(15_000, Math.max(1000, Number(args.observe_seconds || 4) * 1000)));
    const forms = await page.locator("form").evaluateAll((items) => items.slice(0, 30).map((form) => ({
      action: (form instanceof HTMLFormElement ? form.action : ""),
      method: (form instanceof HTMLFormElement ? form.method : "GET").toUpperCase(),
      fields: [...form.querySelectorAll("input, textarea, select")].slice(0, 50).map((field) => ({
        name: field.getAttribute("name") || "", type: field.getAttribute("type") || field.tagName.toLowerCase(), required: field.hasAttribute("required"),
      })).filter((field) => field.name && !/pass|secret|token|otp|card|cvv/i.test(field.name)),
    })));
    const discovered = [...calls.values()].slice(0, 100);
    const options = [];
    for (const call of discovered.filter((item) => item.same_origin).slice(0, 12)) {
      try {
        const endpoint = await assertSecurityTarget(call.url, settings, false);
        const response = await context.request.fetch(endpoint.toString(), { method: "OPTIONS", timeout: 10_000, maxRedirects: 0 });
        options.push({ url: endpoint.toString(), status: response.status(), allow: response.headers().allow || response.headers()["access-control-allow-methods"] || "" });
      } catch (error) {
        options.push({ url: call.url, status: 0, error: error instanceof Error ? error.message : "OPTIONS failed" });
      }
    }
    return { ok: true, action, page: { url: page.url(), title: await page.title() }, api_calls: discovered, forms, options, secrets_redacted: true };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    await page.close().catch(() => {});
  }
}

async function runArtifact(args) {
  const artifact = artifacts.get(String(args.artifact_id || ""));
  if (!artifact) throw new Error("ไม่พบไฟล์นี้ในรอบการทำงานปัจจุบัน");
  await ensureDocker();
  const extension = extname(artifact.path).toLowerCase();
  const directory = dirname(artifact.path);
  const file = basename(artifact.path);
  let image;
  let command;
  if (extension === ".py") { image = "python:3.13-alpine"; command = ["python", file]; }
  else if ([".js", ".mjs"].includes(extension)) { image = "node:22-alpine"; command = ["node", file]; }
  else throw new Error("รันได้เฉพาะ Python และ JavaScript");
  const result = await run("/usr/local/bin/docker", ["run", "--rm", "--network", "none", "--memory", "256m", "--cpus", "1", "--pids-limit", "64", "-v", `${directory}:/work:ro`, "-w", "/work", image, ...command], { timeout: 30_000, allowFailure: true });
  return { ok: result.code === 0, exit_code: result.code, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000) };
}

function skillId(value) {
  const id = String(value || "alpha-skill").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return id || `alpha-skill-${Date.now()}`;
}

function validateSkillDefinition(raw, testLimit = 0) {
  const runtime = String(raw?.runtime || "");
  if (!new Set(["python", "node"]).has(runtime)) throw new Error("Skill Lab รองรับ runtime Python หรือ Node เท่านั้น");
  const entrypoint = safeRelativePath(raw?.entrypoint || (runtime === "python" ? "main.py" : "index.js"));
  if (runtime === "python" && extname(entrypoint) !== ".py") throw new Error("Python skill ต้องใช้ entrypoint .py");
  if (runtime === "node" && ![".js", ".mjs"].includes(extname(entrypoint))) throw new Error("Node skill ต้องใช้ entrypoint .js หรือ .mjs");
  const dependencies = [...new Set((Array.isArray(raw?.dependencies) ? raw.dependencies : []).map(String))];
  if (!dependencies.length) dependencies.push(runtime === "python" ? "python-stdlib" : "node-stdlib");
  for (const dependency of dependencies) {
    const item = trustedDependencyCatalog[dependency];
    if (!item) throw new Error(`dependency ${dependency} ไม่อยู่ใน trusted catalog`);
    if (item.runtime !== runtime) throw new Error(`dependency ${dependency} ไม่ตรงกับ runtime ${runtime}`);
  }
  const rawTests = Array.isArray(raw?.test_cases) ? raw.test_cases : [];
  const tests = (testLimit > 0 ? rawTests.slice(0, testLimit) : rawTests).map((item, index) => {
    const stdoutContains = String(item?.stdout_contains || "").slice(0, 500);
    const expectedFiles = (Array.isArray(item?.expected_files) ? item.expected_files : []).slice(0, 10).map((file) => safeOutputRelativePath(file));
    if (!stdoutContains && !expectedFiles.length) throw new Error(`test case ${index + 1} ไม่มีเกณฑ์ตรวจสอบ`);
    const input = item?.input && typeof item.input === "object" ? item.input : {};
    if (Buffer.byteLength(JSON.stringify(input)) > 16_000) throw new Error(`test case ${index + 1} มี input ใหญ่เกินไป`);
    return { name: String(item?.name || `test-${index + 1}`).slice(0, 100), input, stdout_contains: stdoutContains, expected_files: expectedFiles };
  });
  if (!tests.length) throw new Error("Skill Lab ต้องมี test case อย่างน้อย 1 รายการ");
  const executionTargets = [...new Set((Array.isArray(raw?.execution_targets) ? raw.execution_targets : ["sandbox"])
    .map(String).filter((target) => ["sandbox", "macos_host"].includes(target)))];
  if (!executionTargets.length) executionTargets.push("sandbox");
  return {
    id: skillId(raw?.id),
    name: String(raw?.name || raw?.id || "Alpha Skill").slice(0, 100),
    description: String(raw?.description || "").slice(0, 1000),
    runtime,
    entrypoint,
    dependencies,
    trigger_examples: (Array.isArray(raw?.trigger_examples) ? raw.trigger_examples : []).map(String).slice(0, 8),
    test_cases: tests,
    execution_targets: executionTargets,
  };
}

function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, Math.min(100, ((center - margin) / denominator) * 100));
}

function environmentFingerprint(skill) {
  return createHash("sha256").update(JSON.stringify({
    runtime: skill.runtime,
    entrypoint: skill.entrypoint,
    dependencies: skill.dependencies,
    execution_targets: skill.execution_targets,
    images: { python: "python:3.13-slim", node: "node:22-alpine" },
    trusted_catalog_version: 2,
  })).digest("hex").slice(0, 16);
}

async function readSkillsIndex() {
  try {
    const parsed = JSON.parse(await fs.readFile(skillsIndexFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeSkillsIndex(items) {
  const temporary = `${skillsIndexFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items, null, 2), "utf8");
  await fs.rename(temporary, skillsIndexFile);
}

async function upsertSkillIndex(manifest) {
  const index = await readSkillsIndex();
  const next = index.filter((item) => item.id !== manifest.id);
  next.push(manifest);
  await writeSkillsIndex(next);
}

function skillImageSpec(skill) {
  const base = skill.runtime === "python" ? "python:3.13-slim" : "node:22-alpine";
  const packages = skill.dependencies.flatMap((id) => trustedDependencyCatalog[id].packages);
  if (!packages.length) return { image: base, custom: false, dockerfile: "" };
  if (skill.runtime === "python") {
    return {
      image: `alpha-skill-${createHash("sha256").update(packages.join("\n")).digest("hex").slice(0, 12)}`,
      custom: true,
      dockerfile: `FROM ${base}\nRUN python -m pip install --no-cache-dir ${packages.join(" ")}\n`,
    };
  }
  throw new Error("ยังไม่มี dependency ภายนอกที่อนุมัติสำหรับ Node");
}

async function ensureSkillImage(skill, directory) {
  const spec = skillImageSpec(skill);
  if (!spec.custom) return spec;
  const exists = await run("/usr/local/bin/docker", ["image", "inspect", spec.image], { timeout: 8000, allowFailure: true });
  if (exists.code === 0) return spec;
  const dockerfile = join(directory, ".alpha-skill.Dockerfile");
  await fs.writeFile(dockerfile, spec.dockerfile, "utf8");
  await run("/usr/local/bin/docker", ["build", "--label", "alpha.skill-lab=true", "-f", dockerfile, "-t", spec.image, directory], { timeout: 300_000 });
  return { ...spec, dockerfile };
}

async function removeSkillImage(spec) {
  if (spec?.dockerfile) await fs.rm(spec.dockerfile, { force: true }).catch(() => {});
  if (spec?.custom) await run("/usr/local/bin/docker", ["image", "rm", "-f", spec.image], { timeout: 30_000, allowFailure: true }).catch(() => {});
}

async function removePathWithRetry(target, attempts = 8) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return { removed: true, error: "" };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1000, attempt * 125)));
    }
  }
  return { removed: false, error: lastError instanceof Error ? lastError.message : "ลบไฟล์ชั่วคราวไม่สำเร็จ" };
}

async function removeSkillLabContainers(runId = "") {
  if (!await dockerReady().catch(() => false)) return { removed: 0, ids: [] };
  const filters = ["ps", "-aq", "--filter", "label=alpha.skill-lab=true"];
  if (runId) filters.push("--filter", `label=alpha.run-id=${skillId(runId)}`);
  const listed = await run("/usr/local/bin/docker", filters, { timeout: 10_000, allowFailure: true });
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await run("/usr/local/bin/docker", ["rm", "-f", ...ids], { timeout: 30_000, allowFailure: true });
  return { removed: ids.length, ids };
}

async function createSkillLabRunRoot(runId, goal) {
  const ownerId = skillId(runId || `manual-${goal}`);
  const runRoot = join(skillLabDir, ownerId);
  if (!pathInside(runRoot, skillLabDir)) throw new Error("รหัสเจ้าของ Skill Lab ไม่ปลอดภัย");
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(join(runRoot, ".alpha-resource.json"), JSON.stringify({
    version: 1,
    run_id: ownerId,
    kind: "skill-lab-staging",
    temporary: true,
    created_at: new Date().toISOString(),
  }, null, 2), "utf8");
  return { ownerId, runRoot };
}

async function cleanupSkillLabRun(runId) {
  const ownerId = skillId(runId);
  const runRoot = join(skillLabDir, ownerId);
  if (!pathInside(runRoot, skillLabDir)) throw new Error("รหัส cleanup ของ Skill Lab ไม่ปลอดภัย");
  const containers = await removeSkillLabContainers(ownerId);
  const marker = await fs.readFile(join(runRoot, ".alpha-resource.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!marker || marker.temporary !== true || marker.run_id !== ownerId) {
    const exists = await fs.stat(runRoot).then(() => true).catch(() => false);
    return { ok: !exists, run_id: ownerId, containers_removed: containers.removed, staging_removed: !exists, orphaned_path: exists ? runRoot : "" };
  }
  const removed = await removePathWithRetry(runRoot);
  return { ok: removed.removed, run_id: ownerId, containers_removed: containers.removed, staging_removed: removed.removed, orphaned_path: removed.removed ? "" : runRoot, error: removed.error };
}

async function cleanupOwnedSkillLabResources() {
  const results = [];
  await removeSkillLabContainers();
  for (const entry of await fs.readdir(skillLabDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const marker = await fs.readFile(join(skillLabDir, entry.name, ".alpha-resource.json"), "utf8").then(JSON.parse).catch(() => null);
    if (marker?.temporary === true && marker.run_id === entry.name) results.push(await cleanupSkillLabRun(entry.name));
  }
  return results;
}

async function runSkillSandbox(skill, directory, input, outputDirectory, timeout = 45_000, signal, runId = "manual") {
  await ensureDocker();
  const imageSpec = await ensureSkillImage(skill, directory);
  await fs.mkdir(outputDirectory, { recursive: true });
  const runner = skill.runtime === "python" ? ["python", skill.entrypoint] : ["node", skill.entrypoint];
  const containerName = `alpha-skill-${randomUUID().slice(0, 12)}`;
  const killContainer = () => spawn("/usr/local/bin/docker", ["rm", "-f", containerName], { detached: true, stdio: "ignore" }).unref();
  signal?.addEventListener("abort", killContainer, { once: true });
  try {
    const result = await run("/usr/local/bin/docker", [
      "run", "--rm", "--name", containerName, "--label", "alpha.skill-lab=true", "--label", `alpha.run-id=${skillId(runId)}`, "--network", "none", "--read-only", "--memory", "512m", "--cpus", "1",
      "--pids-limit", "96", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-v", `${directory}:/skill:ro`,
      "-v", `${outputDirectory}:/output:rw`, "-w", "/skill", "-e", "ALPHA_OUTPUT_DIR=/output",
      imageSpec.image, ...runner, JSON.stringify(input),
    ], { timeout, allowFailure: true, signal });
    return { ...result, imageSpec };
  } catch (error) {
    await run("/usr/local/bin/docker", ["rm", "-f", containerName], { timeout: 15_000, allowFailure: true }).catch(() => {});
    await removeSkillImage(imageSpec);
    throw error;
  } finally {
    signal?.removeEventListener("abort", killContainer);
  }
}

async function findHostSkillRuntime(runtime) {
  if (runtime === "node") return process.execPath;
  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("ไม่พบ Python 3 บน macOS host สำหรับสกิลนี้");
}

async function runSkillHost(skill, directory, input, outputDirectory, timeout = 90_000, signal) {
  const runtime = await findHostSkillRuntime(skill.runtime);
  await fs.mkdir(outputDirectory, { recursive: true });
  const result = await run(runtime, [skill.entrypoint, JSON.stringify(input)], {
    cwd: directory,
    env: { ALPHA_OUTPUT_DIR: outputDirectory, ALPHA_PROGRAM_CREATE_DIR: programCreateDir, ALPHA_EXECUTION_TARGET: "macos_host" },
    timeout,
    allowFailure: true,
    signal,
  });
  return { ...result, imageSpec: null };
}

async function listFilesRecursive(directory, prefix = "", skipTestOutput = false) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    // External APFS/HFS volumes can expose AppleDouble sidecar files (._*).
    // They are filesystem metadata, never skill source or test output.
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipTestOutput && relativePath === ".test-output") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listFilesRecursive(absolute, relativePath, skipTestOutput));
    else if (entry.isFile()) found.push({ path: relativePath, absolute });
    if (found.length >= 100) break;
  }
  return found.slice(0, 100);
}

async function installLearnedSkill(skill, candidateDirectory, report, origin = "skill_lab") {
  const destination = join(learnedSkillsDir, skill.id);
  const backup = join(learnedSkillsDir, ".backups", `${skill.id}-${Date.now()}`);
  const staging = join(learnedSkillsDir, ".staging", `${skill.id}-${randomUUID()}`);
  let backedUp = false;
  let committed = false;
  try {
    await fs.mkdir(staging, { recursive: true });
    const files = await listFilesRecursive(candidateDirectory, "", true);
    for (const item of files.filter((item) => !item.path.startsWith(".alpha-skill.") && !item.path.startsWith(".test-output/"))) {
      const target = join(staging, item.path);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(item.absolute, target);
    }
    const now = new Date().toISOString();
    const visibleTests = Array.isArray(report.tests) ? report.tests : [];
    const hiddenTests = Array.isArray(report.hidden_tests) ? report.hidden_tests : [];
    const visiblePassed = visibleTests.filter((item) => item.passed).length;
    const hiddenPassed = hiddenTests.filter((item) => item.passed).length;
    const verifiedPassRate = visibleTests.length ? (visiblePassed / visibleTests.length) * 100 : 0;
    const confidenceSample = hiddenTests.length ? hiddenTests : visibleTests;
    const confidenceSuccesses = hiddenTests.length ? hiddenPassed : visiblePassed;
    const manifest = {
      ...skill,
      version: 1,
      enabled: true,
      origin: origin === "auto_learn" ? "auto_learn" : "skill_lab",
      installed_at: now,
      updated_at: now,
      verification_status: verifiedPassRate === 100 && (!hiddenTests.length || hiddenPassed === hiddenTests.length) ? "verified" : verifiedPassRate > 0 ? "partial" : "failed",
      verified_pass_rate: Number(verifiedPassRate.toFixed(2)),
      verified_passed: visiblePassed,
      verified_total: visibleTests.length,
      verification_scope: String(report.verification_scope || `${visibleTests.length} deterministic test cases for ${skill.description}`).slice(0, 2000),
      hidden_test_result: { passed: hiddenPassed, total: hiddenTests.length },
      generalization_confidence: Number(Math.min(99.9, wilsonLowerBound(confidenceSuccesses, confidenceSample.length)).toFixed(2)),
      confidence_sample_size: confidenceSample.length,
      environment_fingerprint: environmentFingerprint(skill),
      usage_count: 0,
      success_count: 0,
      last_run_at: null,
      last_error: "",
      sandbox: { network: "off", memory_mb: 512 },
      trusted_catalog_version: 2,
    };
    await fs.writeFile(join(staging, "alpha-skill.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(join(staging, "training-report.json"), JSON.stringify(report, null, 2), "utf8");
    const stagedManifest = JSON.parse(await fs.readFile(join(staging, "alpha-skill.json"), "utf8"));
    if (stagedManifest.id !== skill.id || stagedManifest.verification_status !== "verified") throw new Error("manifest ที่ staging ไม่ผ่านการตรวจสอบก่อนติดตั้ง");

    try {
      await fs.access(destination);
      await fs.mkdir(dirname(backup), { recursive: true });
      await fs.rename(destination, backup);
      backedUp = true;
    } catch { /* first install */ }
    await fs.rename(staging, destination);
    committed = true;
    await fs.access(join(destination, skill.entrypoint));

    const archivePath = join(outputsDir, `${skill.id}.alpha-skill.zip`);
    await fs.rm(archivePath, { force: true });
    await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", destination, archivePath], { timeout: 30_000 });
    const artifactsCreated = [
      await hydrateArtifact(registerArtifact(join(destination, "alpha-skill.json"), skill.id, "skill-manifest")),
      await hydrateArtifact(registerArtifact(archivePath, skill.id, "skill-archive")),
    ];
    await upsertSkillIndex(manifest);
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
    return { destination, manifest, artifacts: artifactsCreated };
  } catch (error) {
    if (committed) await removePathWithRetry(destination);
    if (backedUp) await fs.rename(backup, destination).catch(() => {});
    throw error;
  } finally {
    await removePathWithRetry(staging);
  }
}

async function skillLabTest(args, signal) {
  lastHeavyUse = Date.now();
  const testLimit = Math.max(0, Number(args.test_case_limit) || 0);
  const skill = validateSkillDefinition(args.skill || {}, testLimit);
  const hiddenSkill = Array.isArray(args.hidden_test_cases) && args.hidden_test_cases.length
    ? validateSkillDefinition({ ...args.skill, test_cases: args.hidden_test_cases }, 0)
    : { ...skill, test_cases: [] };
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  const files = rawFiles.slice(0, 100).map((item) => ({
    path: safeRelativePath(item?.path), content: String(item?.content ?? ""),
  }));
  if (!files.some((item) => item.path === skill.entrypoint)) throw new Error(`ไม่พบ entrypoint ${skill.entrypoint}`);
  const totalBytes = files.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
  if (!files.length || totalBytes > 2 * 1024 * 1024) throw new Error("ไฟล์สกิลต้องมีขนาดรวมไม่เกิน 2MB");
  const goal = skillId(args.goal_id || skill.id);
  const { ownerId, runRoot } = await createSkillLabRunRoot(args.run_id, goal);
  const attempt = Math.min(12, Math.max(1, Number(args.attempt) || 1));
  const goalRoot = join(runRoot, goal);
  const environment = join(goalRoot, `attempt-${attempt}-${randomUUID()}`);
  let imageSpec = null;
  let installed = false;
  try {
    await fs.mkdir(environment, { recursive: true });
    for (const item of files) {
      const target = join(environment, item.path);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, item.content, "utf8");
    }
    const validationErrors = await validateStaging(environment, files);
    if (validationErrors.length) return { ok: false, passed: false, failure_kind: "candidate_syntax", skill, attempt, reason: "syntax validation failed", validation_errors: validationErrors, tests: [], candidate_files: files };

    const runCases = async (cases, prefix) => {
      const results = [];
      for (let index = 0; index < cases.length; index += 1) {
      const test = cases[index];
      const testOutput = join(environment, ".test-output", `${prefix}-${index + 1}`);
      const execution = await runSkillSandbox(skill, environment, test.input, testOutput, 45_000, signal, ownerId);
      imageSpec = execution.imageSpec;
      const outputFiles = (await listFilesRecursive(testOutput)).map((item) => item.path);
      const stdoutPass = !test.stdout_contains || execution.stdout.includes(test.stdout_contains);
      const filesPass = test.expected_files.every((file) => outputFiles.includes(file));
      const passed = execution.code === 0 && stdoutPass && filesPass;
      results.push({ name: test.name, passed, case: test, exit_code: execution.code, stdout: execution.stdout.slice(0, 6000), stderr: execution.stderr.slice(0, 6000), output_files: outputFiles, checks: { stdout: stdoutPass, files: filesPass } });
      }
      return results;
    };
    const tests = await runCases(skill.test_cases, "visible");
    const hiddenTests = tests.every((test) => test.passed) ? await runCases(hiddenSkill.test_cases, "hidden") : [];
    const passed = tests.length === skill.test_cases.length && tests.every((test) => test.passed)
      && hiddenTests.length === hiddenSkill.test_cases.length && hiddenTests.every((test) => test.passed);
    const report = {
      objective: String(args.objective || "").slice(0, 2000), success_criteria: String(args.success_criteria || "").slice(0, 2000),
      passed, attempt, tested_at: new Date().toISOString(), tests, hidden_tests: hiddenTests,
      verification_scope: String(args.verification_scope || `${tests.length} visible fixtures and ${hiddenTests.length} hidden validation fixtures`).slice(0, 2000),
      dependencies: skill.dependencies.map((id) => ({ id, source: trustedDependencyCatalog[id].source })),
    };
    if (!passed) return { ok: false, passed: false, failure_kind: "candidate_behavior", skill, attempt, reason: "test criteria not met", tests, hidden_tests: hiddenTests, candidate_files: files };
    const installation = await installLearnedSkill(skill, environment, report, args.origin);
    installed = true;
    return { ok: true, passed: true, skill: installation.manifest, attempt, report, destination: installation.destination, artifacts: installation.artifacts };
  } finally {
    await removeSkillImage(imageSpec);
    await removePathWithRetry(environment);
    await removePathWithRetry(goalRoot);
    if (installed || args.cleanup_run === true || signal?.aborted) await cleanupSkillLabRun(ownerId);
  }
}

async function rebuildSkillsIndexIfNeeded() {
  const indexed = await readSkillsIndex();
  if (indexed.length) return indexed;
  const skills = [];
  for (const entry of await fs.readdir(learnedSkillsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try { skills.push(JSON.parse(await fs.readFile(join(learnedSkillsDir, entry.name, "alpha-skill.json"), "utf8"))); }
    catch { /* skip invalid skill */ }
  }
  if (skills.length) await writeSkillsIndex(skills);
  return skills;
}

async function listLearnedSkills(args = {}) {
  const query = String(args.q || "").toLowerCase().trim();
  const statuses = String(args.status || "").split(",").filter(Boolean);
  const origins = String(args.origin || "").split(",").filter(Boolean);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const offset = Math.max(0, Number(args.cursor) || 0);
  let skills = await rebuildSkillsIndexIfNeeded();
  skills = skills.filter((skill) => {
    const searchable = [skill.name, skill.description, ...(skill.trigger_examples || []), ...(skill.dependencies || [])].join(" ").toLowerCase();
    return (!query || searchable.includes(query))
      && (!statuses.length || statuses.includes(String(skill.verification_status || "untested")) || (statuses.includes("enabled") && skill.enabled !== false))
      && (!origins.length || origins.includes(String(skill.origin || "skill_lab")));
  });
  const sort = String(args.sort || "latest");
  skills.sort((left, right) => {
    if (sort === "name") return String(left.name).localeCompare(String(right.name), "th");
    if (sort === "used") return Number(right.usage_count || 0) - Number(left.usage_count || 0);
    if (sort === "success_rate") return (Number(right.success_count || 0) / Math.max(1, Number(right.usage_count || 0))) - (Number(left.success_count || 0) / Math.max(1, Number(left.usage_count || 0)));
    if (sort === "confidence") return Number(right.generalization_confidence || 0) - Number(left.generalization_confidence || 0);
    return String(right.updated_at || right.installed_at || "").localeCompare(String(left.updated_at || left.installed_at || ""));
  });
  const page = skills.slice(offset, offset + limit);
  return { ok: true, skills: page, total: skills.length, next_cursor: offset + limit < skills.length ? String(offset + limit) : null };
}

async function readSkill(idValue) {
  const id = skillId(idValue);
  const directory = join(learnedSkillsDir, id);
  if (!pathInside(directory, learnedSkillsDir)) throw new Error("รหัสสกิลไม่ปลอดภัย");
  const manifest = JSON.parse(await fs.readFile(join(directory, "alpha-skill.json"), "utf8"));
  const report = JSON.parse(await fs.readFile(join(directory, "training-report.json"), "utf8").catch(() => "{}"));
  const files = (await listFilesRecursive(directory)).filter((item) => !item.path.startsWith(".test-output/"));
  return { directory, manifest, report, files: files.map((item) => ({ path: item.path })) };
}

async function patchLearnedSkill(idValue, patch) {
  const skill = await readSkill(idValue);
  const allowed = {};
  if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
  if (typeof patch.name === "string" && patch.name.trim()) allowed.name = patch.name.trim().slice(0, 100);
  if (typeof patch.description === "string") allowed.description = patch.description.trim().slice(0, 1000);
  const manifest = { ...skill.manifest, ...allowed, updated_at: new Date().toISOString() };
  await fs.writeFile(join(skill.directory, "alpha-skill.json"), JSON.stringify(manifest, null, 2), "utf8");
  await upsertSkillIndex(manifest);
  return { ok: true, skill: manifest };
}

async function deleteLearnedSkill(idValue) {
  const skill = await readSkill(idValue);
  const trash = join(homedir(), ".Trash", `alpha-skill-${skill.manifest.id}-${Date.now()}`);
  await fs.rename(skill.directory, trash);
  await writeSkillsIndex((await readSkillsIndex()).filter((item) => item.id !== skill.manifest.id));
  return { ok: true, deleted: skill.manifest.id, recoverable_from: trash };
}

async function skillAction(idValue, action) {
  const skill = await readSkill(idValue);
  if (action === "open") {
    spawn("/usr/bin/open", [skill.directory], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }
  if (action === "export") {
    const archivePath = join(outputsDir, `${skill.manifest.id}.alpha-skill.zip`);
    await fs.rm(archivePath, { force: true });
    await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", skill.directory, archivePath], { timeout: 30_000 });
    return { ok: true, artifacts: [await hydrateArtifact(registerArtifact(archivePath, skill.manifest.id, "skill-archive"))] };
  }
  if (["test", "reverify"].includes(action)) {
    const files = await Promise.all(skill.files.filter((item) => !["alpha-skill.json", "training-report.json"].includes(item.path)).map(async (item) => ({ path: item.path, content: await fs.readFile(join(skill.directory, item.path), "utf8") })));
    return skillLabTest({ objective: skill.report.objective, success_criteria: skill.report.success_criteria, skill: skill.manifest, files, hidden_test_cases: skill.report.hidden_tests?.map((item) => item.case).filter(Boolean) || [], origin: skill.manifest.origin });
  }
  throw new Error(`ไม่รองรับ action ${action}`);
}

async function runLearnedSkill(args, signal, settings = {}) {
  lastHeavyUse = Date.now();
  const id = skillId(args.skill_id);
  const directory = join(learnedSkillsDir, id);
  if (!pathInside(directory, learnedSkillsDir)) throw new Error("รหัสสกิลไม่ปลอดภัย");
  const savedManifest = JSON.parse(await fs.readFile(join(directory, "alpha-skill.json"), "utf8"));
  if (savedManifest.enabled === false) throw new Error("สกิลนี้ถูกปิดใช้งานอยู่");
  const skill = validateSkillDefinition(savedManifest);
  const targets = Array.isArray(savedManifest.execution_targets) ? savedManifest.execution_targets.map(String) : ["sandbox"];
  const requestedTarget = ["auto", "sandbox", "macos_host"].includes(String(args.execution_target)) ? String(args.execution_target) : "auto";
  const hostAllowed = targets.includes("macos_host") && settings.file_access_mode === "full_user_files";
  if (requestedTarget !== "auto" && !targets.includes(requestedTarget)) throw new Error(`สกิลนี้ไม่ได้รับรองการรันบน ${requestedTarget}`);
  if (requestedTarget === "macos_host" && !hostAllowed) throw new Error("ต้องเปิด Full local access ก่อนรันสกิลบน macOS host");
  if (requestedTarget === "auto" && !hostAllowed && !targets.includes("sandbox")) throw new Error("สกิลนี้รันบน macOS host เท่านั้น ต้องเปิด Full local access ก่อนใช้งาน");
  const executionTarget = requestedTarget === "sandbox" ? "sandbox" : hostAllowed ? "macos_host" : "sandbox";
  const input = args.input && typeof args.input === "object" ? args.input : { prompt: String(args.input || "") };
  if (Buffer.byteLength(JSON.stringify(input)) > 32_000) throw new Error("input ของสกิลใหญ่เกิน 32KB");
  const outputDirectory = join(learnedResultsDir, `${id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  let execution;
  try {
    execution = executionTarget === "macos_host"
      ? await runSkillHost(skill, directory, input, outputDirectory, 90_000, signal)
      : await runSkillSandbox(skill, directory, input, outputDirectory, 90_000, signal);
    const artifactsCreated = [];
    for (const item of await listFilesRecursive(outputDirectory)) artifactsCreated.push(await hydrateArtifact(registerArtifact(item.absolute, id, "skill-output")));
    if (!artifactsCreated.length) await fs.rm(outputDirectory, { recursive: true, force: true });
    const succeeded = execution.code === 0;
    const usageCount = Number(savedManifest.usage_count || 0) + 1;
    const successCount = Number(savedManifest.success_count || 0) + (succeeded ? 1 : 0);
    // Keep the verified hidden-test evidence when production runs begin. Using only
    // the first live run made a verified skill's confidence collapse to the Wilson
    // bound for 1/1 even though the same build had already passed hidden fixtures.
    const hiddenPassed = Number(savedManifest.hidden_test_result?.passed || 0);
    const hiddenTotal = Number(savedManifest.hidden_test_result?.total || 0);
    const confidenceSuccesses = hiddenPassed + successCount;
    const confidenceSamples = hiddenTotal + usageCount;
    const productionConfidence = wilsonLowerBound(confidenceSuccesses, confidenceSamples);
    const manifest = {
      ...savedManifest,
      usage_count: usageCount,
      success_count: successCount,
      last_run_at: new Date().toISOString(),
      last_execution_target: executionTarget,
      last_error: succeeded ? "" : execution.stderr.slice(0, 2000),
      generalization_confidence: Number(Math.min(99.9, productionConfidence).toFixed(2)),
      confidence_sample_size: confidenceSamples,
    };
    await fs.writeFile(join(directory, "alpha-skill.json"), JSON.stringify(manifest, null, 2), "utf8");
    await upsertSkillIndex(manifest);
    return { ok: succeeded, execution_target: executionTarget, skill: { id: skill.id, name: skill.name }, exit_code: execution.code, stdout: execution.stdout.slice(0, 20_000), stderr: execution.stderr.slice(0, 20_000), artifacts: artifactsCreated };
  } finally {
    await removeSkillImage(execution?.imageSpec);
  }
}

async function readAutoLearnHistory() {
  try {
    const parsed = JSON.parse(await fs.readFile(autoLearnHistoryFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeAutoLearnHistory(items) {
  const temporary = `${autoLearnHistoryFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items, null, 2), "utf8");
  await fs.rename(temporary, autoLearnHistoryFile);
}

async function readAutoLearnSkillBacklog() {
  try {
    const parsed = JSON.parse(await fs.readFile(autoLearnSkillBacklogFile, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.mode === "skill" && item.objective) : [];
  } catch { return []; }
}

async function writeAutoLearnSkillBacklog(items) {
  const temporary = `${autoLearnSkillBacklogFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items.slice(0, 100), null, 2), "utf8");
  await fs.rename(temporary, autoLearnSkillBacklogFile);
}

async function upsertAutoLearnSkillBacklog(plan) {
  const backlog = await readAutoLearnSkillBacklog();
  const backlogId = String(plan.backlog_id || plan.resume_checkpoint?.skill?.id || skillId(plan.title));
  const item = { ...plan, mode: "skill", backlog_id: backlogId, queued_at: Number(plan.queued_at || Date.now()), updated_at: Date.now() };
  await writeAutoLearnSkillBacklog([item, ...backlog.filter((entry) => entry.backlog_id !== backlogId)]);
  return item;
}

async function removeAutoLearnSkillBacklog(backlogId) {
  if (!backlogId) return;
  await writeAutoLearnSkillBacklog((await readAutoLearnSkillBacklog()).filter((item) => item.backlog_id !== backlogId));
}

async function saveAutoLearnJournal() {
  if (!autoLearnJob) return;
  await fs.mkdir(join(autoLearnWorkDir, autoLearnJob.id), { recursive: true });
  await fs.writeFile(join(autoLearnWorkDir, autoLearnJob.id, "journal.json"), JSON.stringify(autoLearnJob, null, 2), "utf8");
  await fs.writeFile(join(autoLearnRunsDir, `${autoLearnJob.id}.json`), JSON.stringify(autoLearnJob, null, 2), "utf8");
}

async function recordAutoLearnEvent(type, label, detail = "", extra = {}) {
  if (!autoLearnJob) return;
  const item = {
    id: Number(autoLearnJob.event_sequence || 0) + 1,
    at: Date.now(),
    type,
    label: String(label || type),
    detail: String(detail || ""),
    round: Number(extra.round ?? autoLearnJob.current_round ?? 0),
    attempt: Number(extra.attempt ?? autoLearnJob.current_attempt ?? 0),
    stage: String(extra.stage || autoLearnJob.stage || ""),
    current_tool: String(extra.current_tool || autoLearnJob.current_tool || ""),
    ...extra,
  };
  autoLearnJob.event_sequence = item.id;
  autoLearnJob.last_activity_at = item.at;
  autoLearnJob.events.push(item);
  autoLearnJob.log.push({ at: item.at, label: item.label, detail: item.detail });
  await saveAutoLearnJournal();
}

async function listAutoLearnRuns(args = {}) {
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const offset = Math.max(0, Number(args.cursor) || 0);
  const names = (await fs.readdir(autoLearnRunsDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort().reverse();
  const runs = [];
  for (const name of names.slice(offset, offset + limit)) {
    try {
      const run = JSON.parse(await fs.readFile(join(autoLearnRunsDir, name), "utf8"));
      runs.push({ id: run.id, status: run.status, stage: run.stage, started_at: run.started_at, ended_at: run.ended_at, findings_count: run.findings?.length || 0, event_count: run.events?.length || 0, stop_reason: run.stop_reason || "" });
    } catch { /* skip corrupt journal */ }
  }
  return { ok: true, runs, total: names.length, next_cursor: offset + limit < names.length ? String(offset + limit) : null };
}

async function readAutoLearnRun(idValue) {
  const id = basename(String(idValue || "")).replace(/\.json$/i, "");
  const path = join(autoLearnRunsDir, `${id}.json`);
  if (!pathInside(path, autoLearnRunsDir)) throw new Error("รหัส Auto Learn ไม่ปลอดภัย");
  return JSON.parse(await fs.readFile(path, "utf8"));
}

function publicAutoLearnJob() {
  if (!autoLearnJob) return { status: "idle" };
  const job = { ...autoLearnJob, events: autoLearnJob.events || [], log: autoLearnJob.log || [] };
  delete job.focus_context;
  return job;
}

function topicSimilarity(left, right) {
  const normalize = (value) => String(value || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
  const grams = (value) => {
    const text = normalize(value);
    if (text.length < 3) return new Set([text]);
    return new Set(Array.from({ length: text.length - 2 }, (_, index) => text.slice(index, index + 3)));
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function fallbackAutoLearnTopic(focusContext, history, cycle, skillFrequency = 3) {
  const focus = String(focusContext || "ทักษะพื้นฐานของผู้ช่วย AI").replace(/\s+/g, " ").slice(0, 700);
  const closest = history.at(-1);
  const shouldBuildSkill = skillFrequency > 0 && cycle % skillFrequency === 0;
  return {
    mode: shouldBuildSkill ? "skill" : "research",
    title: shouldBuildSkill ? `สร้างเครื่องมือจากงานล่าสุด — รอบ ${cycle}` : `วิเคราะห์และต่อยอดจากงานล่าสุด — รอบ ${cycle}`,
    objective: shouldBuildSkill
      ? `สร้าง learned skill ที่ใช้งานซ้ำได้จริงจากงานล่าสุดนี้ โดยเลือกความสามารถย่อยที่ตรวจผลแบบ deterministic ได้ ใช้ standard library ก่อน และติดตั้งเมื่อผ่าน test เท่านั้น:\n${focus}`
      : `ศึกษาจุดอ่อน เทคนิคใหม่ และแนวทางที่ตรวจสอบได้จากบริบทงานล่าสุดนี้ โดยเลือกประเด็นที่สร้างพัฒนาการจากรอบก่อนเอง:\n${focus}`,
    success_criteria: shouldBuildSkill
      ? "มี entrypoint รับ JSON ผ่าน visible และ hidden tests ติดตั้งใน Skill Registry และเรียกซ้ำได้จริง"
      : "ได้ความรู้ใหม่ที่อ้างอิงได้ ระบุสิ่งที่ดีขึ้นจากรอบก่อน และมีแนวทางนำไปใช้จริง",
    why_new: "แผนสำรองสร้างจากบริบทงานล่าสุดโดยตรง ไม่ใช้รายการหัวข้อที่เขียนตายตัว",
    progression_from: String(closest?.title || ""),
  };
}

async function chooseAutoLearnTopic(model, focusContext, history, cycle, signal, skillFrequency = 3) {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: false, think: false, format: "json", keep_alive: "5m",
      options: { num_ctx: 4096, num_predict: 350, temperature: 0.65 },
      messages: [
        {
          role: "system",
          content: `คุณเป็นผู้อำนวยการเรียนรู้ของอัลฟ่า เลือกสิ่งที่จะเรียนรอบถัดไปให้เก่งขึ้นอย่างมีพัฒนาการ
ให้น้ำหนักสูงสุดกับงานที่ผู้ใช้ทำบ่อยใน focus context ถ้าเป็นงานเขียนโปรแกรมให้ต่อยอด framework, debugging, testing, architecture, UX, performance และ cybersecurity สำหรับโปรแกรมของผู้ใช้
ห้ามเลือกหัวข้อเดิมซ้ำ เว้นแต่ระบุระดับที่ลึกขึ้นหรือแก้จุดอ่อนจากผลเดิม
	เลือกหัวข้อได้อย่างอิสระจากบริบทจริง จุดอ่อน ผลล้มเหลว และสกิลเดิม โดยต้องระบุพัฒนาการที่วัดผลได้
	ถ้าพบคำว่า capability unavailable, ไม่รู้จักเครื่องมือ, ทำไม่ได้ หรือความสามารถที่ผู้ใช้เรียกบ่อยแต่ยังไม่มี ให้เลือก mode=skill เพื่อสร้างความสามารถนั้นเป็น learned tool ที่เรียกใช้ซ้ำได้ โดยพยายามใช้ standard library หรือ trusted dependency ที่มีจริงก่อน
	เมื่อหัวข้อเดิมบรรลุเป้าหมายแล้ว ให้เลือกขั้นที่ลึกขึ้นหรือหัวข้อใกล้เคียงที่ช่วยงานเดียวกันต่อไป ห้ามหยุดเพียงเพราะหัวข้อหนึ่งเสร็จแล้ว
${skillFrequency > 0 ? `ทุกประมาณ ${skillFrequency} รอบควรสร้างทักษะที่ทดสอบได้ใน Skill Lab` : "เลือก research หรือ skill ตามความเหมาะสมโดยไม่บังคับความถี่"}
ตอบ JSON เท่านั้น: {"mode":"research|skill","title":"หัวข้อสั้น","objective":"คำสั่งฝึกที่ชัดเจน","success_criteria":"เกณฑ์ผ่านสำหรับ skill หรือเป้าความรู้","why_new":"ใหม่/ลึกกว่าเดิมอย่างไร","progression_from":"หัวข้อเดิมที่ต่อยอดหรือว่าง"}`,
        },
        { role: "user", content: `รอบที่ ${cycle}\n\nสิ่งที่ผู้ใช้ทำช่วงนี้:\n${focusContext || "ยังไม่มีบริบท ให้เลือกทักษะพื้นฐานที่ช่วยงานผู้ช่วย AI"}\n\nประวัติที่เรียนแล้ว:\n${history.slice(-40).map((item) => `- ${item.title}: ${item.outcome || ""}`).join("\n") || "ยังไม่มี"}` },
      ],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`เลือกหัวข้อ Auto Learn ไม่สำเร็จ (${response.status})`);
  const payload = await response.json();
  let parsed;
  try { parsed = JSON.parse(payload.message?.content || "{}"); } catch { throw new Error("โมเดลส่งแผน Auto Learn ไม่เป็น JSON"); }
  const title = String(parsed.title || parsed.objective || "หัวข้อใหม่").trim().slice(0, 200);
  const rawObjective = String(parsed.objective || title).trim().slice(0, 1000);
  const closest = history
    .map((item) => ({ item, score: topicSimilarity(item.title, title) }))
    .sort((left, right) => right.score - left.score)[0];
  const seen = Boolean(closest && closest.score >= 0.52);
  const progressionFrom = String(parsed.progression_from || (seen ? closest.item.title : "")).slice(0, 200);
  const objective = rawObjective;
  return {
    mode: skillFrequency > 0 && cycle % skillFrequency === 0 ? "skill" : (parsed.mode === "skill" ? "skill" : "research"),
    title: seen ? `${title} — ระดับต่อยอด ${cycle}` : title,
    objective: seen
      ? `${objective}\nต้องต่อยอดจาก “${progressionFrom}” ด้วยเทคนิค กรณีทดสอบ หรือชิ้นงานที่ลึกกว่าเดิม ห้ามใช้เพียงเนื้อหาพื้นฐานซ้ำ และต้องระบุสิ่งที่ดีขึ้นอย่างวัดผลได้`.slice(0, 1500)
      : objective,
    success_criteria: String(parsed.success_criteria || "").trim().slice(0, 1500),
    why_new: String(seen ? `${parsed.why_new || ""} ต้องลึกกว่าเดิมและมีผลวัดได้` : parsed.why_new || "หัวข้อใหม่").trim().slice(0, 1000),
    progression_from: progressionFrom,
  };
}

async function runTrainingRequest(plan, signal, config = {}) {
  const timeoutMs = Math.max(0, Number(config.step_timeout_seconds) || 0) * 1000;
  const inactivityAbort = new AbortController();
  let watchdog = null;
  const touchWatchdog = () => {
    if (!timeoutMs) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => inactivityAbort.abort(new Error(`ไม่มีสถานะใหม่เกิน ${Math.round(timeoutMs / 1000)} วินาที`)), timeoutMs);
  };
  touchWatchdog();
  const response = await fetch("http://localhost:3000/api/train", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([signal, inactivityAbort.signal]),
    body: JSON.stringify({ mode: plan.mode, origin: "auto_learn", run_id: config.id, objective: plan.objective, success_criteria: plan.success_criteria, max_attempts: config.skill_lab_max_attempts, max_rounds: config.research_max_rounds, target_confidence: 85, resume_checkpoint: plan.resume_checkpoint || null }),
  });
  if (!response.body) throw new Error(`Training API ไม่ตอบ stream (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split("\n\n");
      buffer = packets.pop() || "";
      for (const packet of packets) {
        const line = packet.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          events.push(parsed);
          touchWatchdog();
          const label = String(parsed.label || parsed.message || parsed.type || "สถานะการฝึก");
          const currentTool = /docker/i.test(label) ? "Docker" : /ค้น|search/i.test(label) ? "Search" : /ollama|สร้าง|ออกแบบ|อ่าน/i.test(label) ? "Ollama" : "Training";
          if (autoLearnJob) {
            autoLearnJob.current_attempt = Number(parsed.round || autoLearnJob.current_attempt || 0);
            autoLearnJob.current_tool = currentTool;
          }
          await recordAutoLearnEvent(String(parsed.type || "training_event"), label, String(parsed.reason || parsed.summary || ""), { attempt: Number(parsed.round || 0), current_tool: currentTool });
        } catch { /* malformed event */ }
      }
    }
  } catch (error) {
    const checkpoint = events.findLast((item) => item.type === "checkpoint")?.checkpoint || plan.resume_checkpoint || null;
    if (signal.aborted) {
      return { success: false, recalled: true, summary: `เรียกกลับระหว่างกำลังสร้างสกิล หลังทำถึง Attempt ${Number(autoLearnJob?.current_attempt || 0)}`, confidence: 0, rounds: Number(autoLearnJob?.current_attempt || 0), skill: null, sources: [], checkpoint, cleanup: checkpoint ? "บันทึก checkpoint แล้วและกำลังล้าง environment ของรอบนี้" : "ยังสร้าง source ชุดแรกไม่เสร็จ จึงไม่มี checkpoint และล้าง environment ของรอบนี้แล้ว" };
    }
    throw error;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await reader.cancel().catch(() => {});
  }
  const error = events.findLast((item) => item.type === "error");
  const complete = events.findLast((item) => item.type === "complete");
  if (!complete) throw new Error(String(error?.message || "Training API จบโดยไม่มีผลสรุป"));
  return {
    success: complete.success !== false,
    summary: String(complete.summary || complete.reason || "").slice(0, 8000),
    confidence: Number(complete.generalization_confidence ?? complete.confidence ?? 0),
    rounds: Number(complete.rounds || complete.attempts || 0),
    skill: complete.skill || null,
    sources: Array.isArray(complete.sources) ? complete.sources.slice(0, 10) : [],
    checkpoint: complete.checkpoint || events.findLast((item) => item.type === "checkpoint")?.checkpoint || null,
    recalled: false,
    reason: String(complete.reason || ""),
    cleanup: String(complete.cleanup || ""),
  };
}

async function finalizeAutoLearn(reason) {
  if (!autoLearnJob || autoLearnJob.status === "completed" || autoLearnJob.status === "stopped") return;
  const job = autoLearnJob;
  const skillCleanup = await cleanupSkillLabRun(job.id).catch((error) => ({ ok: false, containers_removed: 0, staging_removed: false, error: error instanceof Error ? error.message : "cleanup failed" }));
  job.status = reason.startsWith("ครบ") ? "completed" : "stopped";
  job.ended_at = Date.now();
  job.stage = "finished";
  job.current_topic = "";
  job.stop_reason = reason;
  const successful = job.findings.filter((item) => item.success);
  const skills = successful.filter((item) => item.skill).map((item) => item.skill);
  const skillFindings = job.findings.filter((item) => item.mode === "skill");
  const installedSkillFindings = skillFindings.filter((item) => item.success && item.skill);
  const recalledSkillFindings = skillFindings.filter((item) => item.recalled);
  job.report = {
    outcome: installedSkillFindings.length > 0 ? "success" : "no_skill_installed",
    summary: installedSkillFindings.length > 0
      ? `อัลฟ่าเรียน ${job.findings.length} รอบ สำเร็จ ${successful.length} รอบ และสร้างทักษะที่ผ่านการทดสอบ ${skills.length} รายการ`
      : `Auto Learn จบรอบโดยยังไม่มีสกิลติดตั้งสำเร็จ — ไม่นับ session นี้ว่าสำเร็จ (ทำ ${job.findings.length} รอบ)`,
    topics: job.findings.map((item) => ({ title: item.title, mode: item.mode, success: item.success, recalled: Boolean(item.recalled), attempts: Number(item.rounds || 0), why_new: item.why_new, progression_from: item.progression_from, summary: item.summary, failure_reason: item.reason || "", checkpoint: item.checkpoint || null })),
    skills,
    skill_summary: {
      tested: skillFindings.length,
      installed: installedSkillFindings.length,
      failed: skillFindings.length - installedSkillFindings.length - recalledSkillFindings.length,
      recalled: recalledSkillFindings.length,
    },
    cleanup: skillCleanup,
    duration_minutes: Math.max(0, Math.round((job.ended_at - job.started_at) / 60_000)),
    stop_reason: reason,
  };
  const reportDirectory = join(autoLearnOutputDir, job.id);
  await fs.mkdir(reportDirectory, { recursive: true });
  const jsonPath = join(reportDirectory, "auto-learn-report.json");
  const markdownPath = join(reportDirectory, "auto-learn-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(job.report, null, 2), "utf8");
  const markdown = [`# Alpha Auto Learn Report`, "", job.report.summary, "", `- ระยะเวลา: ${job.report.duration_minutes} นาที`, `- เหตุผลที่จบ: ${reason}`, `- สกิลที่ทดสอบ: ${job.report.skill_summary.tested}`, `- สกิลที่ติดตั้งและพร้อมใช้: ${job.report.skill_summary.installed}`, `- สกิลที่ยังไม่ผ่าน: ${job.report.skill_summary.failed}`, `- สกิลที่เรียกกลับระหว่างทำ: ${job.report.skill_summary.recalled}`, `- Cleanup: container ${Number(skillCleanup.containers_removed || 0)} ตัว · staging ${skillCleanup.staging_removed ? "ลบแล้ว" : skillCleanup.orphaned_path ? "พบไฟล์กำพร้าและไม่ลบเพราะไม่มีทะเบียนเจ้าของ" : "ไม่มี"}`, "", "## สิ่งที่เรียนรู้", "", ...job.findings.flatMap((item, index) => [`### ${index + 1}. ${item.title}`, `- โหมด: ${item.mode}`, `- ผล: ${item.success ? "สำเร็จ" : item.recalled ? "เรียกกลับระหว่างทำ" : "ไม่สำเร็จ"}`, ...(item.mode === "skill" ? [`- Attempt ที่ทำแล้ว: ${Number(item.rounds || 0)}`, `- การติดตั้ง: ${item.skill ? "ติดตั้งแล้ว" : "ยังไม่ติดตั้ง"}`] : []), `- พัฒนาการ: ${item.why_new}`, "", item.summary || "ไม่มีบทสรุป", ""])].join("\n");
  await fs.writeFile(markdownPath, markdown, "utf8");
  job.artifacts = [await hydrateArtifact(registerArtifact(markdownPath, job.id, "file")), await hydrateArtifact(registerArtifact(jsonPath, job.id, "file"))];
  job.last_activity_at = Date.now();
  job.events.push({ id: Number(job.event_sequence || 0) + 1, at: job.last_activity_at, type: "finished", label: "เก็บกวาดและสร้างรายงานเสร็จแล้ว", detail: reason, round: job.current_round || 0, attempt: 0, stage: "finished", current_tool: "" });
  job.event_sequence = Number(job.event_sequence || 0) + 1;
  await fs.writeFile(autoLearnLastJobFile, JSON.stringify(publicAutoLearnJob(), null, 2), "utf8");
  await fs.writeFile(join(autoLearnRunsDir, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
  await fs.rm(join(autoLearnWorkDir, job.id), { recursive: true, force: true });
}

async function restoreLastAutoLearn() {
  try {
    const activeJournals = [];
    for (const entry of await fs.readdir(autoLearnWorkDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      try {
        const journal = JSON.parse(await fs.readFile(join(autoLearnWorkDir, entry.name, "journal.json"), "utf8"));
        if (journal.status === "running") activeJournals.push(journal);
      } catch { /* skip corrupt journal */ }
    }
    const active = activeJournals.sort((left, right) => Number(right.started_at || 0) - Number(left.started_at || 0))[0];
    if (active) {
      autoLearnJob = { ...active, events: active.events || [], log: active.log || [], findings: active.findings || [], artifacts: [] };
      if ((!Number(active.deadline || 0) || Date.now() < Number(active.deadline)) && !active.stop_requested) {
        await recordAutoLearnEvent("recovered", "กู้สถานะจาก journal แล้ว", "Tool Service เริ่มใหม่และทำงานต่อจากรอบล่าสุด");
        autoLearnLoopPromise = runAutoLearnLoop();
        void autoLearnLoopPromise.finally(() => { autoLearnLoopPromise = null; });
      } else {
        await finalizeAutoLearn("Tool Service เริ่มใหม่หลัง run หมดเวลาหรือถูกหยุด");
      }
      return;
    }
    const restored = JSON.parse(await fs.readFile(autoLearnLastJobFile, "utf8"));
    if (!["completed", "stopped"].includes(String(restored.status))) return;
    const restoredArtifacts = [];
    for (const item of Array.isArray(restored.artifacts) ? restored.artifacts : []) {
      const artifactPath = resolve(String(item.path || ""));
      if (pathInside(artifactPath, autoLearnOutputDir) && await fs.stat(artifactPath).then((stat) => stat.isFile()).catch(() => false)) {
        restoredArtifacts.push(await hydrateArtifact(registerArtifact(artifactPath, String(restored.id || "auto-learn"), "file")));
      }
    }
    autoLearnJob = { ...restored, artifacts: restoredArtifacts, focus_context: "", events: restored.events || [], log: restored.log || [] };
  } catch { /* no completed Auto Learn session yet */ }
}

// alpha-beta14-auto-learn-recovery-v1
async function runAutoLearnLoop() {
  if (!autoLearnJob) return;
  const job = autoLearnJob;
  try {
    const history = await readAutoLearnHistory();
    while (!job.stop_requested && (!job.deadline || Date.now() < job.deadline) && (!job.max_rounds || job.findings.length < job.max_rounds)) {
      const cycle = job.findings.length + 1;
      job.current_round = cycle;
      job.current_attempt = 0;
      job.current_tool = "Ollama";
      job.stage = "choosing";
      job.current_topic = "กำลังเลือกหัวข้อจากงานที่ผู้ใช้ทำบ่อย";
      await recordAutoLearnEvent("stage", `รอบ ${cycle}: เลือกหัวข้อ`, "วิเคราะห์งานล่าสุด จุดอ่อน และพัฒนาการจากรอบก่อน", { round: cycle, current_tool: "Ollama" });
      autoLearnAbort = new AbortController();
      let plan;
      const skillBacklog = await readAutoLearnSkillBacklog();
      const readyBacklog = skillBacklog
        .filter((item) => !Number(item.deferred_until || 0) || Number(item.deferred_until) <= Date.now())
        .map((item) => ({
          item,
          relevance: topicSimilarity(`${item.title || ""} ${item.objective || ""}`, job.focus_context),
        }))
        .sort((left, right) => right.relevance - left.relevance || Number(left.item.failure_count || 0) - Number(right.item.failure_count || 0));
      const readyBacklogItem = !job.focus_context || readyBacklog[0]?.relevance >= 0.08 ? readyBacklog[0]?.item : null;
      if (readyBacklogItem) {
        plan = readyBacklogItem;
        job.skill_backlog_count = skillBacklog.length;
        await recordAutoLearnEvent("skill_backlog", `หยิบสกิลค้างมาทำต่อ: ${plan.title}`, plan.resume_checkpoint ? "โหลด source และผล test จาก checkpoint" : "แปลงความรู้ที่สำเร็จให้เป็นเครื่องมือที่ทดสอบและเรียกใช้ได้", { round: cycle, current_tool: "Training" });
      } else {
        job.skill_backlog_count = 0;
        const installedInThisRun = job.findings.some((item) => item.mode === "skill" && item.success && item.skill);
        const effectiveSkillFrequency = installedInThisRun ? job.skill_frequency : 1;
        try {
          if (!installedInThisRun && cycle === 1) {
            await recordAutoLearnEvent("skill_required", "บังคับสร้างสกิลที่ใช้งานได้เป็นเป้าหมายแรก", "Auto Learn จะยังไม่ถือว่าสำเร็จจนกว่าจะมีสกิลที่ผ่าน test และติดตั้งจริง", { round: cycle, current_tool: "Training" });
          }
          plan = await chooseAutoLearnTopic(job.model, job.focus_context, [...history, ...job.findings], cycle, autoLearnAbort.signal, effectiveSkillFrequency);
        } catch (error) {
          if (job.stop_requested) break;
          plan = fallbackAutoLearnTopic(job.focus_context, [...history, ...job.findings], cycle, effectiveSkillFrequency);
          await recordAutoLearnEvent("fallback", "ใช้แผนสำรองจากบริบทจริง", error instanceof Error ? error.message : "โมเดลเลือกหัวข้อไม่ทันเวลา", { round: cycle });
        }
      }
      const resumable = [...history].reverse().find((item) => item.checkpoint && topicSimilarity(item.title, plan.title) >= 0.45);
      if (resumable) {
        plan.resume_checkpoint = resumable.checkpoint;
        plan.progression_from = plan.progression_from || resumable.title;
        plan.why_new = `${plan.why_new} · แก้ต่อจาก checkpoint เดิม ไม่เริ่ม source code ใหม่`;
        await recordAutoLearnEvent("checkpoint_resumed", "พบ checkpoint และเตรียมแก้ต่อ", resumable.title, { round: cycle, current_tool: "Training" });
      }
      job.current_topic = plan.title;
      job.stage = plan.mode === "skill" ? "building_skill" : "researching";
      await recordAutoLearnEvent("topic", `รอบ ${cycle}: ${plan.title}`, plan.why_new, { round: cycle, stage: job.stage });
      let outcome = null;
      let retry = 0;
      const retryFailures = new Map();
      while (!job.stop_requested && (!job.deadline || Date.now() < job.deadline) && !outcome) {
        job.retry_requested = false;
        job.skip_requested = false;
        autoLearnAbort = new AbortController();
        try {
          outcome = await runTrainingRequest(plan, autoLearnAbort.signal, job);
        } catch (error) {
          if (job.stop_requested) {
            outcome = { success: false, recalled: true, summary: `เรียกกลับระหว่างทำ “${plan.title}”`, confidence: 0, rounds: Number(job.current_attempt || 0), skill: null, sources: [], checkpoint: null, cleanup: "ยกเลิก process ของรอบนี้และล้าง environment แล้ว" };
            break;
          }
          if (job.skip_requested) {
            outcome = { success: false, summary: "ผู้ใช้ข้ามหัวข้อนี้", confidence: 0, rounds: 0, skill: null, sources: [], cleanup: "ยกเลิก process และเก็บกวาดแล้ว" };
            await recordAutoLearnEvent("skipped", "ข้ามหัวข้อนี้แล้ว", plan.title, { round: cycle });
            break;
          }
          retry += 1;
          const reason = error instanceof Error ? error.message : "รอบการเรียนไม่สำเร็จ";
          const retrySignature = reason.replace(/\b\d+\b/g, "#").slice(0, 1000);
          const sameFailureCount = (retryFailures.get(retrySignature) || 0) + 1;
          retryFailures.set(retrySignature, sameFailureCount);
          // runTrainingRequest already performs bounded repair attempts. Restarting the
          // entire pipeline here repeats topic selection, planning and model work and
          // was the source of hour-long Auto Learn loops. Only an explicit user Retry
          // is allowed to restart the pipeline.
          if (job.retry_requested) {
            await recordAutoLearnEvent("retry", `Retry ${retry}: ${plan.title}`, reason, { round: cycle, attempt: retry });
            continue;
          }
          const repeated = sameFailureCount > 1;
          outcome = {
            success: false,
            summary: repeated ? `หยุด retry เพราะ pipeline ผิดแบบเดิมซ้ำ ${sameFailureCount} ครั้ง: ${reason}` : reason,
            reason,
            confidence: 0,
            rounds: retry,
            skill: null,
            sources: [],
            checkpoint: null,
            repeated_pipeline_failure: repeated,
            cleanup: "ยกเลิก request/process ที่ค้างและล้าง environment แล้ว",
          };
        }
      }
      if (job.stop_requested) {
        outcome ||= { success: false, recalled: true, summary: `เรียกกลับระหว่างทำ “${plan.title}”`, confidence: 0, rounds: Number(job.current_attempt || 0), skill: null, sources: [], checkpoint: null, cleanup: "ยกเลิก process ของรอบนี้และล้าง environment แล้ว" };
        const recalledFinding = { ...plan, ...outcome, completed_at: Date.now() };
        job.findings.push(recalledFinding);
        history.push({ title: plan.title, outcome: outcome.summary, mode: plan.mode, checkpoint: outcome.checkpoint || null, at: Date.now() });
        await writeAutoLearnHistory(history);
        if (plan.mode === "skill" && outcome.checkpoint) {
          await upsertAutoLearnSkillBacklog({ ...plan, resume_checkpoint: outcome.checkpoint, backlog_id: plan.backlog_id || outcome.checkpoint?.skill?.id, why_new: `${plan.why_new || ""} · Recall แล้วบันทึก checkpoint เพื่อแก้ต่อ` });
        }
        await recordAutoLearnEvent("round_recalled", `เรียกกลับระหว่างรอบ ${cycle}`, outcome.summary, { round: cycle, current_tool: "" });
        await saveAutoLearnJournal();
        break;
      }
      outcome ||= { success: false, summary: "หมดเวลารอบการเรียน", confidence: 0, rounds: retry, skill: null, sources: [], cleanup: "ล้างงานชั่วคราวแล้ว" };
      const finding = { ...plan, ...outcome, completed_at: Date.now() };
      job.findings.push(finding);
      await recordAutoLearnEvent(outcome.success ? "round_complete" : "round_failed", outcome.success ? `รอบ ${cycle} สำเร็จ` : `รอบ ${cycle} ไม่สำเร็จ`, outcome.summary, { round: cycle, current_tool: "" });
      history.push({ title: plan.title, outcome: outcome.success ? "สำเร็จ" : `ไม่สำเร็จ: ${outcome.summary.slice(0, 200)}`, mode: plan.mode, checkpoint: outcome.checkpoint || null, at: Date.now() });
      await writeAutoLearnHistory(history);
      if (plan.mode === "skill") {
        if (outcome.success && outcome.skill) {
          await removeAutoLearnSkillBacklog(plan.backlog_id || plan.resume_checkpoint?.skill?.id || outcome.skill.id);
          await recordAutoLearnEvent("skill_installed", `ติดตั้งสกิลพร้อมใช้: ${outcome.skill.name || outcome.skill.id}`, "นำออกจาก Skill-first backlog แล้ว", { round: cycle, current_tool: "" });
        } else if (outcome.checkpoint) {
          const stalled = outcome.checkpoint?.stalled === true;
          await upsertAutoLearnSkillBacklog({ ...plan, resume_checkpoint: outcome.checkpoint, backlog_id: plan.backlog_id || outcome.checkpoint?.skill?.id, deferred_until: stalled ? Date.now() + 10 * 60_000 : 0, why_new: `${plan.why_new || ""} · แก้ต่อจากผล test จริงจนกว่าจะผ่าน` });
          await recordAutoLearnEvent(stalled ? "skill_deferred" : "skill_requeued", stalled ? `พักสกิลที่วนซ้ำไว้ 10 นาที: ${plan.title}` : `เก็บสกิลไว้แก้ต่อรอบหน้า: ${plan.title}`, stalled ? "ลองหลายกลยุทธ์แล้วยังได้ failure เดิม จึงไปพัฒนางานอื่นก่อนและเก็บ checkpoint ไว้" : `ผ่านไปแล้ว ${Number(outcome.rounds || 0)} attempts และยังไม่ติดตั้ง`, { round: cycle, current_tool: "Training" });
        } else {
          const failureCount = Math.max(1, Number(plan.failure_count || 0) + 1);
          const deferMinutes = Math.min(360, 5 * (2 ** Math.min(6, failureCount - 1)));
          const lastError = String(outcome.reason || outcome.summary || "pipeline error").slice(0, 2000);
          await upsertAutoLearnSkillBacklog({
            ...plan,
            backlog_id: plan.backlog_id,
            failure_count: failureCount,
            last_error: lastError,
            deferred_until: Date.now() + deferMinutes * 60_000,
            why_new: `${plan.why_new || ""} · พักหลัง pipeline ล้มก่อนสร้าง checkpoint เพื่อไม่วนงานเดิม`,
          });
          await recordAutoLearnEvent(
            "skill_pipeline_deferred",
            `พักงานที่ pipeline ล้ม ${deferMinutes} นาที แล้วไปเรียนหัวข้ออื่น: ${plan.title}`,
            lastError,
            { round: cycle, current_tool: "Training", failure_count: failureCount },
          );
        }
      } else if (outcome.success) {
        const conversion = await upsertAutoLearnSkillBacklog({
          backlog_id: `research-${createHash("sha256").update(plan.title).digest("hex").slice(0, 12)}`,
          mode: "skill",
          title: `${plan.title} — สกิลใช้งานจริง`,
          objective: `เปลี่ยนความรู้ที่ค้นคว้าสำเร็จนี้เป็น learned skill ที่รับ input จากงานผู้ใช้และให้ผลลัพธ์ที่ตรวจซ้ำได้จริง:\n${String(outcome.summary || "").slice(0, 2200)}`,
          success_criteria: "มี entrypoint ใช้งานจริง ผ่าน visible และ hidden tests ทุกชุด ติดตั้งในหน้า Skills และเรียกซ้ำจากแชตได้",
          why_new: "เปลี่ยนผลวิจัยที่สำเร็จให้เป็นความสามารถใช้งานจริง ไม่จบแค่บทสรุป",
          progression_from: plan.title,
        });
        await recordAutoLearnEvent("research_to_skill", `นำความรู้เข้าคิวสร้างสกิล: ${conversion.title}`, "รอบถัดไปจะทำ Skill-first backlog ก่อนเลือกหัวข้อใหม่", { round: cycle, current_tool: "Training" });
      }
      await saveAutoLearnJournal();
      if (job.stop_requested || (job.deadline && Date.now() >= job.deadline)) break;
      job.stage = "resting";
      const remaining = job.deadline ? job.deadline - Date.now() : Infinity;
      job.current_topic = remaining < 120_000 ? "ใกล้ครบเวลา กำลังพักและเตรียมสรุปผล" : "พักโมเดลก่อนต่อยอดหัวข้อหรือเครื่องมือถัดไป";
      const restMs = Math.max(0, Number(job.rest_seconds || 0)) * 1000;
      const waitUntil = job.deadline ? Math.min(job.deadline, Date.now() + restMs) : Date.now() + restMs;
      if (restMs) await recordAutoLearnEvent("resting", "พักก่อนเริ่มรอบใหม่", `${job.rest_seconds} วินาที`, { round: cycle });
      while (!job.stop_requested && Date.now() < waitUntil) await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
    const reason = job.stop_requested ? "ผู้ใช้เรียกกลับหรือหยุดการเรียนรู้"
      : job.max_rounds && job.findings.length >= job.max_rounds ? "ครบจำนวนรอบที่ตั้งไว้"
        : "ครบเวลาที่ตั้งไว้";
    await finalizeAutoLearn(reason);
  } catch (error) {
    await recordAutoLearnEvent("fatal_error", "Auto Learn หยุดเพราะข้อผิดพลาด", error instanceof Error ? error.message : "unknown error");
    await finalizeAutoLearn(error instanceof Error ? error.message : "เกิดข้อผิดพลาด");
  } finally {
    autoLearnAbort = null;
  }
}

async function startAutoLearn(args) {
  if (autoLearnJob?.status === "running") return { ok: true, already_running: true, job: publicAutoLearnJob() };
  const requestedDuration = Number(args.duration_minutes);
  const durationMinutes = Number.isFinite(requestedDuration) && requestedDuration === 0
    ? 0
    : Math.min(1_440, Math.max(1, requestedDuration || 60));
  const id = `auto-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const skillBacklogCount = (await readAutoLearnSkillBacklog()).length;
  autoLearnJob = {
    id, status: "running", stage: "starting", model: String(args.model || "qwen3.5:9b"),
    focus_context: String(args.focus_context || "").slice(0, 20_000), current_topic: "กำลังเริ่ม Auto Learn",
    duration_minutes: durationMinutes, started_at: Date.now(), deadline: durationMinutes === 0 ? 0 : Date.now() + durationMinutes * 60_000,
    ended_at: 0, stop_requested: false, retry_requested: false, skip_requested: false, stop_reason: "", findings: [], log: [], events: [], event_sequence: 0,
    last_activity_at: Date.now(), current_round: 0, current_attempt: 0, current_tool: "Training",
    max_rounds: Math.max(0, Number(args.max_rounds) || 0), step_timeout_seconds: Math.max(0, Number(args.step_timeout_seconds) || 0),
    retry_limit: Math.max(0, Number(args.retry_limit) || 0), skill_frequency: Math.max(0, Number(args.skill_frequency) || 0),
    rest_seconds: Math.max(0, Number(args.rest_seconds) || 0), skill_lab_max_attempts: Math.max(0, Number(args.skill_lab_max_attempts) || 0),
    research_max_rounds: Math.max(0, Number(args.research_max_rounds) || 0),
    skill_backlog_count: skillBacklogCount,
    report: null, artifacts: [], imported: false,
  };
  await recordAutoLearnEvent("started", "เริ่ม Auto Learn", durationMinutes === 0 ? "ไม่จำกัดเวลา — ทำงานต่อเนื่องจนกดเรียกกลับ" : `กำหนดเวลา ${durationMinutes} นาที`, { stage: "starting" });
  autoLearnLoopPromise = runAutoLearnLoop();
  void autoLearnLoopPromise.finally(() => { autoLearnLoopPromise = null; });
  return { ok: true, job: publicAutoLearnJob() };
}

async function stopAutoLearn() {
  if (!autoLearnJob || autoLearnJob.status !== "running") return { ok: true, job: publicAutoLearnJob() };
  autoLearnJob.stop_requested = true;
  autoLearnJob.stage = "stopping";
  autoLearnJob.current_topic = "กำลังเรียกอัลฟ่ากลับและสรุปผล";
  autoLearnAbort?.abort();
  await recordAutoLearnEvent("stopping", "กำลังหยุด process และเก็บกวาด", "รอให้ Ollama request และ Docker task ปิดจริง");
  await autoLearnLoopPromise;
  return { ok: true, job: publicAutoLearnJob() };
}

async function retryAutoLearn(idValue) {
  if (!autoLearnJob || autoLearnJob.id !== idValue || autoLearnJob.status !== "running") throw new Error("run นี้ไม่ได้กำลังทำงาน");
  autoLearnJob.retry_requested = true;
  autoLearnAbort?.abort();
  await recordAutoLearnEvent("retry_requested", "ขอ Retry ขั้นปัจจุบัน", autoLearnJob.current_topic || "");
  return { ok: true, job: publicAutoLearnJob() };
}

async function skipAutoLearn(idValue) {
  if (!autoLearnJob || autoLearnJob.id !== idValue || autoLearnJob.status !== "running") throw new Error("run นี้ไม่ได้กำลังทำงาน");
  autoLearnJob.skip_requested = true;
  autoLearnAbort?.abort();
  await recordAutoLearnEvent("skip_requested", "ข้ามขั้นปัจจุบัน", autoLearnJob.current_topic || "");
  return { ok: true, job: publicAutoLearnJob() };
}

async function executeTool(name, args, settings, approved = false, signal) {
  idleSeconds = Math.min(1800, Math.max(60, Number(settings.tool_idle_timeout_seconds || 300)));
  if (name === "create_files") {
    if (settings.file_access_mode === "off") throw new Error("ปิดสิทธิ์สร้างไฟล์อยู่");
    if (settings.file_access_mode === "ask" && !approved) return queueConfirmation(name, args, settings, "อนุญาตให้อัลฟ่าสร้างไฟล์ตามรายการนี้หรือไม่?");
    return createFiles(args, settings, approved);
  }
  if (name === "manage_file") {
    if (settings.file_access_mode === "off") throw new Error("ปิดสิทธิ์จัดการไฟล์อยู่");
    if (settings.file_access_mode === "ask" && !approved && String(args.action || "read") !== "open_finder") {
      return queueConfirmation(name, args, settings, `อนุญาตให้อัลฟ่า${String(args.action || "read")}ไฟล์นี้หรือไม่?`);
    }
    return manageFile(args, settings, approved);
  }
  if (name === "web_search") return searchWeb(args.query);
  if (name === "web_read") return readWebPage(args.url);
  if (name === "browser_action") {
    if (String(args.action || "") === "upload" && !approved) return queueConfirmation(name, args, settings, `ยืนยันให้อัปโหลด ${basename(String(args.file_path || "ไฟล์"))} ไปยังเว็บไซต์ที่เปิดอยู่หรือไม่?`);
    return browserAction(args, settings, approved);
  }
  if (name === "api_discovery") return apiDiscovery(args, settings);
  if (name === "run_artifact") {
    if (!approved) return queueConfirmation(name, args, settings, "อนุญาตให้รันไฟล์นี้ใน Docker sandbox หรือไม่?");
    return runArtifact(args);
  }
  if (name === "skill_lab_test") return skillLabTest(args, signal);
  if (name === "skill_lab_cleanup") return cleanupSkillLabRun(String(args.run_id || ""));
  if (name === "list_learned_skills") return listLearnedSkills({ status: "enabled", limit: 100 });
  if (name === "run_learned_skill") return runLearnedSkill(args, signal, settings);
  throw new Error(`ไม่รู้จักเครื่องมือ ${name}`);
}

function queueConfirmation(name, args, settings, summary) {
  const id = randomUUID();
  pending.set(id, { name, args, settings, createdAt: Date.now() });
  return { ok: false, confirmation_required: true, confirmation_id: id, summary };
}

async function toolHealth() {
  await refreshStorageState();
  let dockerConnected = false;
  let searxngConnected = false;
  try { dockerConnected = await dockerReady(); } catch { /* false */ }
  try { searxngConnected = (await fetch("http://127.0.0.1:8888/", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* false */ }
  // Never probe protected macOS folders from a polling health endpoint. Doing so
  // makes macOS repeatedly show a privacy prompt for node. Permission is checked
  // only when the user explicitly asks to access a protected path.
  const fullDisk = "not_requested";
  return {
    app_version: appVersion,
    connected: true,
    storage_connected: storageConnected,
    storage_root: appDir,
    storage_error: storageError,
    docker_connected: dockerConnected,
    searxng_connected: searxngConnected,
    alpha_browser_running: Boolean(alphaContext),
    chrome_extension_connected: [...extensionClients].some((socket) => socket.readyState === 1),
    full_disk_access: fullDisk,
    outputs_directory: outputsDir,
    web_read_ready: storageConnected,
    search_ready: storageConnected,
    search_backend: searxngConnected ? "searxng" : "duckduckgo",
    search_degraded_reason: searxngConnected ? "" : "SearXNG ยังไม่ทำงาน ระบบจะใช้ DuckDuckGo แบบข้อความ",
    browser_ready: storageConnected,
    last_tool_error: lastToolError,
    learned_skills: storageConnected ? (await listLearnedSkills()).skills : [],
    skill_lab_ready: storageConnected && dockerConnected,
    trusted_dependencies: Object.keys(trustedDependencyCatalog),
    skill_backlog_count: storageConnected ? (await readAutoLearnSkillBacklog()).length : 0,
    auto_learn: publicAutoLearnJob(),
  };
}

async function stopHeavyTools() {
  if (alphaContext) await alphaContext.close().catch(() => {});
  alphaContext = null;
  if (publicInspectionContext) await publicInspectionContext.close().catch(() => {});
  publicInspectionContext = null;
  const dockerConnected = await dockerReady();
  if (dockerConnected) {
    if (storageConnected) await run("/usr/local/bin/docker", ["compose", "-f", composeFile, "down", "--remove-orphans"], { timeout: 30_000, allowFailure: true });
    else await run("/usr/local/bin/docker", ["rm", "-f", "alpha-searxng"], { timeout: 15_000, allowFailure: true });
    if (dockerOpenedByAlpha) {
      const running = await run("/usr/local/bin/docker", ["ps", "--format", "{{.Names}}"], { timeout: 5000, allowFailure: true });
      if (!running.stdout.trim()) await quitDockerOpenedByAlpha();
    }
  } else if (dockerOpenedByAlpha) {
    await quitDockerOpenedByAlpha();
  }
  dockerOpenedByAlpha = false;
}

setInterval(async () => {
  await refreshStorageState().catch(() => {});
  for (const [id, item] of pending) if (Date.now() - item.createdAt > 5 * 60_000) pending.delete(id);
  if (autoLearnJob?.status === "running") { lastHeavyUse = Date.now(); return; }
  if (lastHeavyUse && Date.now() - lastHeavyUse > idleSeconds * 1000) {
    lastHeavyUse = 0;
    // alpha-beta10-persistent-search-v1
    // Reclaim UI/browser state only. Search service lifetime is the Alpha session,
    // not the generic heavy-tool idle timeout.
    if (alphaContext) await alphaContext.close().catch(() => {});
    alphaContext = null;
  }
}, 15_000).unref();

await cleanupOwnedSkillLabResources().catch(() => {});
await restoreLastAutoLearn();

// alpha-beta10-persistent-search-v1: keep local search warm for the whole Tool Service lifetime.
// Start eagerly and self-heal if the SearXNG container exits while Alpha is open.
let searxngKeepAliveBusy = false;
async function keepSearxngAlive() {
  if (searxngKeepAliveBusy || !storageConnected) return;
  searxngKeepAliveBusy = true;
  try {
    await ensureSearxng();
    if (lastToolError.startsWith("SearXNG keepalive:")) lastToolError = "";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "SearXNG ไม่พร้อม";
    lastToolError = "SearXNG keepalive: " + reason;
  } finally {
    searxngKeepAliveBusy = false;
  }
}

void keepSearxngAlive();
setInterval(() => { void keepSearxngAlive(); }, 30_000).unref();

const webSocketServer = new WebSocketServer({ noServer: true });
webSocketServer.on("connection", (socket) => {
  extensionClients.add(socket);
  socket.on("close", () => extensionClients.delete(socket));
  socket.send(JSON.stringify({ type: "connected", name: "alpha-tool-service" }));
});

const server = http.createServer(async (request, response) => {
  const requestAbort = new AbortController();
  request.once("aborted", () => requestAbort.abort());
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/v1/extension/pair" && request.method === "POST") {
      const body = await readJson(request, 4096);
      const expected = createHash("sha256").update(token).digest("hex").slice(0, 8).toUpperCase();
      if (!constantTimeEqual(String(body.code || "").toUpperCase(), expected)) return json(response, 403, { error: "รหัสจับคู่ไม่ถูกต้อง" });
      return json(response, 200, { token });
    }
    if (!authenticated(request)) return json(response, 401, { error: "ไม่ได้รับอนุญาต" });
    if (url.pathname === "/v1/health" && request.method === "GET") return json(response, 200, await toolHealth());
    if (!await refreshStorageState() && url.pathname !== "/v1/shutdown") return json(response, 503, { error: storageError, storage_connected: false });
    if (url.pathname === "/v1/ticket-runs" && request.method === "POST") return json(response, 200, await ticketRunManager.start(await readJson(request, 64 * 1024)));
    const ticketRunMatch = url.pathname.match(/^\/v1\/ticket-runs\/([^/]+)(?:\/(input|stop))?$/);
    if (ticketRunMatch && request.method === "GET" && !ticketRunMatch[2]) return json(response, 200, ticketRunManager.get(decodeURIComponent(ticketRunMatch[1])));
    if (ticketRunMatch && request.method === "POST" && ticketRunMatch[2] === "input") { const body = await readJson(request, 16 * 1024); return json(response, 200, await ticketRunManager.input(decodeURIComponent(ticketRunMatch[1]), String(body.value ?? ""))); }
    if (ticketRunMatch && request.method === "POST" && ticketRunMatch[2] === "stop") return json(response, 200, await ticketRunManager.stop(decodeURIComponent(ticketRunMatch[1])));
    if (url.pathname === "/v1/auto-learn/status" && request.method === "GET") return json(response, 200, { ok: true, job: publicAutoLearnJob() });
    if (url.pathname === "/v1/auto-learn/start" && request.method === "POST") return json(response, 200, await startAutoLearn(await readJson(request, 64 * 1024)));
    if (url.pathname === "/v1/auto-learn/stop" && request.method === "POST") return json(response, 200, await stopAutoLearn());
    if (url.pathname === "/v1/auto-learn/runs" && request.method === "GET") return json(response, 200, await listAutoLearnRuns(Object.fromEntries(url.searchParams)));
    const autoRunMatch = url.pathname.match(/^\/v1\/auto-learn\/runs\/([^/]+)(?:\/(retry|skip))?$/);
    if (autoRunMatch && request.method === "GET" && !autoRunMatch[2]) return json(response, 200, { ok: true, run: await readAutoLearnRun(decodeURIComponent(autoRunMatch[1])) });
    if (autoRunMatch && request.method === "POST" && autoRunMatch[2] === "retry") return json(response, 200, await retryAutoLearn(decodeURIComponent(autoRunMatch[1])));
    if (autoRunMatch && request.method === "POST" && autoRunMatch[2] === "skip") return json(response, 200, await skipAutoLearn(decodeURIComponent(autoRunMatch[1])));
    if (url.pathname === "/v1/auto-learn/events" && request.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      const run = requestedRunId && requestedRunId !== String(autoLearnJob?.id || "")
        ? await readAutoLearnRun(requestedRunId)
        : publicAutoLearnJob();
      const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const events = (run.events || []).filter((item) => Number(item.id) > cursor).slice(0, limit);
      return json(response, 200, { ok: true, events, next_cursor: events.at(-1)?.id || cursor, has_more: (run.events || []).some((item) => Number(item.id) > Number(events.at(-1)?.id || cursor)) });
    }
    if (url.pathname === "/v1/auto-learn/ack" && request.method === "POST") {
      if (autoLearnJob) {
        autoLearnJob.imported = true;
        if (["completed", "stopped"].includes(autoLearnJob.status)) await fs.writeFile(autoLearnLastJobFile, JSON.stringify(publicAutoLearnJob(), null, 2), "utf8");
      }
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/v1/extension/pairing" && request.method === "GET") return json(response, 200, { code: createHash("sha256").update(token).digest("hex").slice(0, 8).toUpperCase() });
    if (url.pathname === "/v1/skills" && request.method === "GET") return json(response, 200, await listLearnedSkills(Object.fromEntries(url.searchParams)));
    const skillMatch = url.pathname.match(/^\/v1\/skills\/([^/]+)(?:\/(run|test|reverify|retrain|export|open))?$/);
    if (skillMatch && request.method === "GET" && !skillMatch[2]) return json(response, 200, { ok: true, skill: await readSkill(decodeURIComponent(skillMatch[1])) });
    if (skillMatch && request.method === "PATCH" && !skillMatch[2]) return json(response, 200, await patchLearnedSkill(decodeURIComponent(skillMatch[1]), await readJson(request, 64 * 1024)));
    if (skillMatch && request.method === "DELETE" && !skillMatch[2]) return json(response, 200, await deleteLearnedSkill(decodeURIComponent(skillMatch[1])));
    if (skillMatch && request.method === "POST" && skillMatch[2] === "run") return json(response, 200, await runLearnedSkill({ skill_id: decodeURIComponent(skillMatch[1]), ...(await readJson(request, 64 * 1024)) }, requestAbort.signal, {}));
    if (skillMatch && request.method === "POST" && ["test", "reverify", "export", "open"].includes(skillMatch[2])) return json(response, 200, await skillAction(decodeURIComponent(skillMatch[1]), skillMatch[2]));
    if (skillMatch && request.method === "POST" && skillMatch[2] === "retrain") {
      const skill = await readSkill(decodeURIComponent(skillMatch[1]));
      return json(response, 200, { ok: true, objective: skill.report.objective || skill.manifest.description, success_criteria: skill.report.success_criteria || skill.manifest.verification_scope || "" });
    }
    if (url.pathname === "/v1/tool/execute" && request.method === "POST") {
      const body = await readJson(request);
      const result = await executeTool(String(body.name || ""), body.arguments || {}, body.settings || {}, false, requestAbort.signal);
      lastToolError = "";
      return json(response, result.confirmation_required ? 409 : 200, result);
    }
    if (url.pathname === "/v1/tools/confirm" && request.method === "POST") {
      const body = await readJson(request, 4096);
      const item = pending.get(String(body.confirmation_id || ""));
      if (!item) return json(response, 404, { error: "คำขออนุญาตหมดอายุหรือไม่พบ" });
      pending.delete(String(body.confirmation_id));
      if (body.approved !== true) return json(response, 200, { ok: false, denied: true, message: "ผู้ใช้ไม่อนุญาต" });
      const result = await executeTool(item.name, item.args, item.settings, true);
      lastToolError = "";
      return json(response, 200, result);
    }
    const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/);
    if (artifactMatch && request.method === "GET") {
      const artifact = artifacts.get(artifactMatch[1]);
      if (!artifact) return json(response, 404, { error: "ไม่พบไฟล์หรือบริการเพิ่งเริ่มใหม่" });
      const data = await fs.readFile(artifact.path);
      response.writeHead(200, { "Content-Type": artifact.mime, "Content-Length": data.byteLength, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, "Cache-Control": "no-store" });
      return response.end(data);
    }
    const openMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/open$/);
    if (openMatch && request.method === "POST") {
      const artifact = artifacts.get(openMatch[1]);
      if (!artifact) return json(response, 404, { error: "ไม่พบไฟล์" });
      spawn("/usr/bin/open", ["-R", artifact.path], { detached: true, stdio: "ignore" }).unref();
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/v1/shutdown" && request.method === "POST") {
      await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});
      if (autoLearnJob?.status === "running") {
        await stopAutoLearn();
        await finalizeAutoLearn("ปิดโปรแกรมอัลฟ่า");
      }
      await cleanupOwnedSkillLabResources().catch(() => {});
      await stopHeavyTools();
      json(response, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 50);
      return;
    }
    return json(response, 404, { error: "ไม่พบ endpoint" });
  } catch (error) {
    lastToolError = error instanceof Error ? error.message : "เครื่องมือทำงานไม่สำเร็จ";
    return json(response, 500, { error: lastToolError });
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/v1/extension" || !constantTimeEqual(url.searchParams.get("token"), token)) return socket.destroy();
    webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit("connection", client, request));
  } catch { socket.destroy(); }
});

server.listen(port, "127.0.0.1", () => console.log(`Alpha tool service listening on 127.0.0.1:${port}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});
    if (autoLearnJob?.status === "running") await stopAutoLearn().catch(() => {});
    await cleanupOwnedSkillLabResources().catch(() => {});
    await stopHeavyTools().catch(() => {});
    server.close(() => process.exit(0));
  });
}
