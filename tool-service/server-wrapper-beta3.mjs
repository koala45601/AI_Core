import http from "node:http";
import net from "node:net";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const appDir = resolve(process.env.ALPHA_APP_DIR || process.argv[2] || process.cwd());
const publicPort = Number(process.env.ALPHA_TOOL_PORT || 4317);
const corePort = publicPort + 1;
const workDir = resolve(appDir, "work");
const confirmationFile = resolve(workDir, "host-tool-confirmations.json");
const installLogDir = resolve(workDir, "host-install-logs");
const varsFile = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8").catch(() => "");
const token = String(process.env.ALPHA_TOOL_TOKEN || varsFile.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1] || "").trim();
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const pending = new Map();

if (token.length < 32) {
  console.error("ALPHA_TOOL_TOKEN is missing or too short");
  process.exit(1);
}

await fs.mkdir(workDir, { recursive: true });
await fs.mkdir(installLogDir, { recursive: true });

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(request) {
  return constantTimeEqual(request.headers.authorization, `Bearer ${token}`);
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, DELETE",
  });
  response.end(JSON.stringify(payload));
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
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || options.allowFailure) resolveRun(result);
      else reject(new Error(result.stderr.trim() || result.stdout.trim() || `${basename(command)} ล้มเหลว`));
    });
  });
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, path);
}

async function persistPending() {
  const records = [...pending.entries()].map(([id, item]) => ({ id, ...item }));
  await atomicWriteJson(confirmationFile, { version: 1, updated_at: Date.now(), records });
}

function cleanExpiredPending(now = Date.now()) {
  let changed = false;
  for (const [id, item] of pending) {
    const terminal = ["completed", "denied", "failed"].includes(String(item.status || ""));
    const age = now - Number(item.updatedAt || item.createdAt || 0);
    const limit = terminal ? COMPLETED_TTL_MS : CONFIRMATION_TTL_MS;
    if (!Number(item.createdAt) || age > limit) {
      pending.delete(id);
      changed = true;
    }
  }
  return changed;
}

async function loadPending() {
  try {
    const saved = JSON.parse(await fs.readFile(confirmationFile, "utf8"));
    for (const item of Array.isArray(saved.records) ? saved.records : []) {
      if (!item?.id || !item?.type) continue;
      pending.set(String(item.id), { ...item, id: undefined });
    }
    if (cleanExpiredPending()) await persistPending();
  } catch { /* first run or an invalid temporary file */ }
}

await loadPending();

const coreChild = spawn(process.execPath, [resolve(appDir, "tool-service", "server.mjs"), appDir], {
  cwd: appDir,
  env: { ...process.env, ALPHA_TOOL_PORT: String(corePort) },
  stdio: ["ignore", "inherit", "inherit"],
});
coreChild.on("exit", (code) => {
  if (code && code !== 0) console.error(`Alpha core Tool Service exited with ${code}`);
});

async function waitForCore() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${corePort}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return true;
    } catch { /* keep waiting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

await waitForCore();

async function readBuffer(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("คำขอมีขนาดใหญ่เกินกำหนด");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readBuffer(request);
  return { buffer, value: buffer.length ? JSON.parse(buffer.toString("utf8")) : {} };
}

async function executablePath(name) {
  const safe = String(name || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+@-]{0,79}$/.test(safe)) return "";
  const special = {
    airport: "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
    wdutil: "/usr/bin/wdutil",
    tcpdump: "/usr/sbin/tcpdump",
    networksetup: "/usr/sbin/networksetup",
    system_profiler: "/usr/sbin/system_profiler",
  };
  const direct = special[safe];
  if (direct && await fs.access(direct).then(() => true).catch(() => false)) return direct;
  const which = await run("/usr/bin/which", [safe], { timeout: 3000, allowFailure: true });
  return which.code === 0 ? which.stdout.trim().split("\n")[0] : "";
}

async function safeCommand(command, args = [], timeout = 10_000, env = {}) {
  try {
    const result = await run(command, args, { timeout, allowFailure: true, env });
    return {
      ok: result.code === 0,
      exit_code: result.code,
      stdout: result.stdout.trim().slice(0, 24_000),
      stderr: result.stderr.trim().slice(0, 8000),
    };
  } catch (error) {
    return { ok: false, exit_code: -1, stdout: "", stderr: error instanceof Error ? error.message : "command failed" };
  }
}

// alpha-beta6-host-filesystem-v1
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

// alpha-beta12-host-access-routing-v1
async function hostCanAccess(target, mode) {
  try {
    await fs.access(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingHostParent(target) {
  let current = resolve(target);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isDirectory()) return current;
      return resolve(current, "..");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = resolve(current, "..");
      if (parent === current) return current;
      current = parent;
    }
  }
}
async function hostFs(args = {}, settings = {}) {
  const action = new Set(["exists", "stat", "list", "access"]).has(String(args.action)) ? String(args.action) : "stat"; // alpha-beta12-host-access-routing-v1
  const target = hostFsAllowed(args.path, settings);
  if (action === "access") {
    try {
      const accessStat = await fs.lstat(target);
      const readable = await hostCanAccess(target, 4);
      const writable = await hostCanAccess(target, 2);
      const executable = await hostCanAccess(target, 1);
      return {
        ok: true,
        host_scope: "macos",
        docker_used: false,
        action: "access",
        path: target,
        exists: true,
        type: accessStat.isDirectory() ? "directory" : accessStat.isFile() ? "file" : accessStat.isSymbolicLink() ? "symlink" : "other",
        readable,
        writable,
        executable,
        creatable: accessStat.isDirectory() ? (writable && executable) : false,
        nearest_existing_parent: accessStat.isDirectory() ? target : resolve(target, ".."),
        app_dir: appDir,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = await nearestExistingHostParent(resolve(target, ".."));
      const parentWritable = await hostCanAccess(parent, 2);
      const parentExecutable = await hostCanAccess(parent, 1);
      return {
        ok: true,
        host_scope: "macos",
        docker_used: false,
        action: "access",
        path: target,
        exists: false,
        readable: false,
        writable: false,
        executable: false,
        creatable: parentWritable && parentExecutable,
        nearest_existing_parent: parent,
        parent_writable: parentWritable,
        parent_executable: parentExecutable,
        app_dir: appDir,
      };
    }
  }
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

async function systemCapability(args = {}) {
  const area = new Set(["general", "development", "wifi", "security"]).has(String(args.area)) ? String(args.area) : "general";
  const requested = Array.isArray(args.commands) ? args.commands.map(String).slice(0, 20) : [];
  const defaults = area === "wifi" || area === "security"
    ? ["brew", "git", "python3", "node", "airport", "wdutil", "tcpdump", "aircrack-ng", "hcxdumptool", "hcxpcapngtool", "hashcat"]
    : area === "development"
      ? ["brew", "git", "python3", "node", "npm", "pnpm", "docker", "make", "clang"]
      : ["brew", "git", "python3", "node", "docker"];
  const commandNames = [...new Set([...defaults, ...requested])].filter((name) => /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,79}$/.test(name)).slice(0, 30);
  const commands = {};
  for (const name of commandNames) {
    const path = await executablePath(name);
    commands[name] = { installed: Boolean(path), path };
  }

  const os = await safeCommand("/usr/bin/sw_vers", []);
  const arch = await safeCommand("/usr/bin/uname", ["-m"]);
  const result = {
    ok: true,
    area,
    os: os.stdout,
    architecture: arch.stdout,
    commands,
    package_manager: { homebrew: Boolean(commands.brew?.installed), path: commands.brew?.path || "" },
  };

  if (area === "wifi" || area === "security") {
    const profiler = await safeCommand("/usr/sbin/system_profiler", ["SPAirPortDataType", "-detailLevel", "mini"], 20_000);
    const ports = await safeCommand("/usr/sbin/networksetup", ["-listallhardwareports"]);
    result.wifi = {
      built_in_detected: /Wi-Fi|AirPort/i.test(`${profiler.stdout}\n${ports.stdout}`),
      hardware: profiler.stdout,
      hardware_ports: ports.stdout,
      airport_cli: commands.airport || { installed: false, path: "" },
      wdutil: commands.wdutil || { installed: false, path: "" },
      tcpdump: commands.tcpdump || { installed: false, path: "" },
      note: "ตรวจ Mac เครื่องจริงก่อนเสมอ ใช้ built-in Wi-Fi ก่อน และสรุปข้อจำกัดจากผลตรวจจริงเท่านั้น",
    };
  }
  return result;
}

async function brewPath() {
  for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return executablePath("brew");
}

function validateFormula(value) {
  const formula = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9@+_.-]{0,79}$/.test(formula)) {
    throw new Error("ชื่อ package ต้องเป็น Homebrew formula ธรรมดาเท่านั้น ห้ามมี URL, tap, cask, option หรือ shell syntax");
  }
  return formula;
}

async function installedFormula(brew, formula) {
  const check = await run(brew, ["list", "--versions", formula], { timeout: 15_000, allowFailure: true });
  return check.code === 0 && check.stdout.trim() ? check.stdout.trim() : "";
}

async function queueInstallConfirmation(formula, reason) {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (item.type === "install_package" && item.args?.package === formula && ["pending", "running"].includes(String(item.status))) {
      item.updatedAt = now;
      item.expiresAt = now + CONFIRMATION_TTL_MS;
      await persistPending();
      return id;
    }
  }
  const id = randomUUID();
  pending.set(id, {
    type: "install_package",
    args: { package: formula, reason },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    cachedResult: null,
  });
  await persistPending();
  return id;
}

async function installPackage(args, approved = false, confirmationId = "") {
  const formula = validateFormula(args.package);
  const reason = String(args.reason || "จำเป็นสำหรับงานปัจจุบัน").trim().slice(0, 500);
  const brew = await brewPath();
  if (!brew) {
    return {
      ok: false,
      package_manager_missing: true,
      manager: "homebrew",
      message: "ยังไม่พบ Homebrew ใน Mac จึงยังติดตั้ง formula ไม่ได้ อัลฟ่าต้องเตรียม package-manager workflow ก่อน",
      resume: false,
    };
  }

  const existing = await installedFormula(brew, formula);
  if (existing) {
    return {
      ok: true,
      already_installed: true,
      package: formula,
      version: existing,
      manager: "homebrew",
      message: `ตรวจแล้ว ${formula} ติดตั้งอยู่แล้ว (${existing})`,
      resume: true,
      resume_prompt: `ติดตั้ง/ตรวจ ${formula} เรียบร้อยแล้ว ให้ตรวจ capability ใหม่และดำเนินงานเดิมต่อทันทีโดยไม่ถามให้ผู้ใช้พิมพ์ว่า “ทำต่อ”`,
    };
  }

  const info = await run(brew, ["info", "--json=v2", formula], {
    timeout: 60_000,
    allowFailure: true,
    env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
  });
  if (info.code !== 0) {
    throw new Error(`ไม่พบ Homebrew formula '${formula}'`);
  }

  if (!approved) {
    const id = await queueInstallConfirmation(formula, reason);
    return {
      ok: false,
      confirmation_required: true,
      confirmation_id: id,
      expires_at: pending.get(id)?.expiresAt,
      summary: `อัลฟ่าต้องติดตั้ง ${formula} เพื่อ${reason} — อนุญาตให้ติดตั้งบน Mac เครื่องนี้หรือไม่?`,
      package: formula,
      manager: "homebrew",
    };
  }

  const startedAt = Date.now();
  const result = await run(brew, ["install", formula], {
    timeout: 20 * 60_000,
    allowFailure: true,
    env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" },
  });
  const version = await installedFormula(brew, formula);
  const logPath = resolve(installLogDir, `${startedAt}-${formula.replace(/[^a-z0-9_.@+-]/g, "_")}.log`);
  await fs.writeFile(logPath, [result.stdout, result.stderr].filter(Boolean).join("\n"), "utf8").catch(() => {});
  const ok = result.code === 0 && Boolean(version);
  if (!ok) {
    return {
      ok: false,
      package: formula,
      manager: "homebrew",
      message: `ติดตั้ง ${formula} ไม่สำเร็จ`,
      error: result.stderr.trim().split("\n").slice(-8).join("\n") || "Homebrew install failed",
      log_path: logPath,
      resume: false,
    };
  }
  return {
    ok: true,
    package: formula,
    manager: "homebrew",
    version,
    message: `ติดตั้ง ${formula} สำเร็จ (${version})`,
    log_path: logPath,
    resume: true,
    resume_prompt: `ติดตั้ง ${formula} สำเร็จแล้ว ให้ตรวจ system_capability ใหม่ก่อน จากนั้นดำเนินงานเดิมต่ออัตโนมัติจากจุดที่ค้าง ห้ามหยุดเพียงเพราะการติดตั้งเสร็จ`,
  };
}

// alpha-beta4-batch-install-v1
function validateFormulaList(values) {
  const list = Array.isArray(values) ? values : [];
  const formulas = [...new Set(list.map(validateFormula))].slice(0, 8);
  if (!formulas.length) throw new Error("ต้องระบุ package อย่างน้อย 1 รายการ");
  return formulas;
}

async function queueBatchInstallConfirmation(packages, reason) {
  const now = Date.now();
  const key = packages.slice().sort().join("|");
  for (const [id, item] of pending) {
    const existingKey = item.type === "install_packages" && Array.isArray(item.args?.packages)
      ? item.args.packages.slice().sort().join("|") : "";
    if (existingKey === key && ["pending", "running"].includes(String(item.status))) {
      item.updatedAt = now;
      item.expiresAt = now + CONFIRMATION_TTL_MS;
      await persistPending();
      return id;
    }
  }
  const id = randomUUID();
  pending.set(id, {
    type: "install_packages",
    args: { packages, reason },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    cachedResult: null,
  });
  await persistPending();
  return id;
}

async function installPackages(args, approved = false) {
  const packages = validateFormulaList(args.packages);
  const reason = String(args.reason || "จำเป็นสำหรับงานปัจจุบัน").trim().slice(0, 500);
  const brew = await brewPath();
  if (!brew) return {
    ok: false,
    package_manager_missing: true,
    manager: "homebrew",
    message: "ยังไม่พบ Homebrew ใน Mac จึงยังติดตั้ง formula ไม่ได้",
    resume: false,
  };

  const missing = [];
  const versions = {};
  for (const formula of packages) {
    const installed = await installedFormula(brew, formula);
    if (installed) versions[formula] = installed;
    else missing.push(formula);
  }
  if (!missing.length) return {
    ok: true,
    already_installed: true,
    packages,
    versions,
    manager: "homebrew",
    message: "ตรวจแล้ว dependency ครบ " + packages.length + " รายการ",
    resume: true,
    resume_prompt: "dependency ที่ต้องใช้มีครบแล้ว ให้ตรวจ capability ใหม่และดำเนินงานเดิมต่อทันที",
  };

  for (const formula of missing) {
    const info = await run(brew, ["info", "--json=v2", formula], {
      timeout: 60_000,
      allowFailure: true,
      env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
    });
    if (info.code !== 0) throw new Error("ไม่พบ Homebrew formula '" + formula + "'");
  }

  if (!approved) {
    const id = await queueBatchInstallConfirmation(missing, reason);
    return {
      ok: false,
      confirmation_required: true,
      confirmation_id: id,
      expires_at: pending.get(id)?.expiresAt,
      summary: "ต้องติดตั้ง " + missing.join(", ") + " เพื่อ" + reason + " — อนุญาตติดตั้งทั้งหมดครั้งเดียวหรือไม่?",
      packages: missing,
      manager: "homebrew",
    };
  }

  const startedAt = Date.now();
  const result = await run(brew, ["install", ...missing], {
    timeout: 30 * 60_000,
    allowFailure: true,
    env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" },
  });
  const verified = {};
  for (const formula of missing) verified[formula] = await installedFormula(brew, formula);
  const failed = missing.filter((formula) => !verified[formula]);
  const safeNames = missing.join("_").replace(/[^a-z0-9_.@+-]/g, "_");
  const logPath = resolve(installLogDir, String(startedAt) + "-batch-" + safeNames + ".log");
  await fs.writeFile(logPath, [result.stdout, result.stderr].filter(Boolean).join("\n"), "utf8").catch(() => {});
  if (result.code !== 0 || failed.length) return {
    ok: false,
    packages: missing,
    installed: Object.entries(verified).filter(([, version]) => Boolean(version)).map(([name]) => name),
    failed,
    manager: "homebrew",
    message: "ติดตั้ง dependency ไม่ครบ: " + (failed.join(", ") || "Homebrew returned an error"),
    error: result.stderr.trim().split("\n").slice(-8).join("\n") || "Homebrew batch install failed",
    log_path: logPath,
    resume: false,
  };
  return {
    ok: true,
    packages: missing,
    versions: verified,
    manager: "homebrew",
    message: "ติดตั้ง dependency สำเร็จ " + missing.length + " รายการ: " + missing.join(", "),
    log_path: logPath,
    resume: true,
    resume_prompt: "ติดตั้ง dependency ที่ขาดทั้งหมดสำเร็จแล้ว ให้ตรวจ system_capability ใหม่ จากนั้นดำเนินงานเดิมต่ออัตโนมัติจนจบหรือจนพบ approval/ข้อจำกัดใหม่ที่จำเป็นจริง",
  };
}
// alpha-beta10-host-execution-v1
function hostPathInsideWorkspace(target) {
  const root = resolve(appDir);
  const absolute = resolve(target);
  return absolute === root || absolute.startsWith(root + "/");
}

function hostPathSensitive(target) {
  const absolute = resolve(target);
  const relativePath = absolute === resolve(appDir) ? "" : absolute.slice(resolve(appDir).length + 1);
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.includes(".git")) return true;
  const leaf = segments.at(-1) || "";
  return leaf === ".dev.vars" || leaf === ".env" || leaf.startsWith(".env.");
}

function validateHostArgs(value) {
  const args = Array.isArray(value) ? value.slice(0, 32).map((item) => String(item)) : [];
  for (const item of args) {
    if (item.length > 2000 || item.includes("\0")) throw new Error("argument สำหรับ host execution ไม่ถูกต้อง");
  }
  return args;
}

async function resolveHostArtifact(rawPath) {
  const requested = String(rawPath || "").trim();
  if (!requested.startsWith("/")) throw new Error("run_host_artifact ต้องใช้ absolute path ของ Artifact");
  const resolved = resolve(requested);
  if (!hostPathInsideWorkspace(resolved)) throw new Error("HOST_ARTIFACT_OUT_OF_WORKSPACE: รันบน Mac ได้เฉพาะ Artifact ภายใน workspace ของ Alpha");
  if (hostPathSensitive(resolved)) throw new Error("HOST_ARTIFACT_PROTECTED: ไม่อนุญาตให้รันไฟล์ลับหรือ metadata ของ workspace");
  const real = await fs.realpath(resolved).catch(() => "");
  if (!real || !hostPathInsideWorkspace(real) || hostPathSensitive(real)) throw new Error("HOST_ARTIFACT_INVALID: Artifact ไม่มีอยู่จริงหรือ symlink ออกจาก workspace");
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("run_host_artifact รองรับเฉพาะไฟล์");
  if (stat.size > 2 * 1024 * 1024) throw new Error("Artifact ใหญ่เกิน 2MB สำหรับ host execution preview");
  const lower = basename(real).toLowerCase();
  let interpreter = "";
  if (lower.endsWith(".sh")) interpreter = "/bin/zsh";
  else if (lower.endsWith(".py")) interpreter = await executablePath("python3");
  else if (lower.endsWith(".js") || lower.endsWith(".mjs")) interpreter = process.execPath;
  else throw new Error("run_host_artifact รองรับ .sh, .py, .js และ .mjs เท่านั้น");
  if (!interpreter) throw new Error("ไม่พบ interpreter ที่ต้องใช้บน Mac");
  return { path: real, interpreter };
}

function runHostProcess(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const safeEnv = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"]) {
      if (process.env[key]) safeEnv[key] = process.env[key];
    }
    safeEnv.ALPHA_EXECUTION_SCOPE = "macos_host";
    const child = spawn(command, args, {
      cwd: options.cwd || appDir,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = Math.min(600_000, Math.max(1_000, Number(options.timeout || 120_000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) { settled = true; reject(new Error("HOST_EXECUTION_TIMEOUT")); }
    }, timeout);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 64_000),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32_000),
      });
    });
  });
}

async function queueHostArtifactConfirmation(args, resolvedArtifact) {
  const now = Date.now();
  const key = resolvedArtifact.path + "|" + JSON.stringify(validateHostArgs(args.args));
  for (const [id, item] of pending) {
    const existingKey = item.type === "run_host_artifact" ? String(item.key || "") : "";
    if (existingKey === key && ["pending", "running"].includes(String(item.status))) {
      item.updatedAt = now;
      item.expiresAt = now + CONFIRMATION_TTL_MS;
      await persistPending();
      return id;
    }
  }
  const id = randomUUID();
  pending.set(id, {
    type: "run_host_artifact",
    key,
    args: { ...args, path: resolvedArtifact.path },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    cachedResult: null,
  });
  await persistPending();
  return id;
}

// alpha-beta11-full-host-permission-v1
function fullHostPermission(settings = {}) {
  return String(settings?.file_access_mode || "") === "full_user_files";
}

async function runHostArtifact(args, approved = false, settings = {}) {
  const artifact = await resolveHostArtifact(args.path);
  const runArgs = validateHostArgs(args.args);
  const reason = String(args.reason || "งานนี้ต้องใช้ environment จริงของ Mac").trim().slice(0, 600);
  const timeoutSeconds = Math.min(600, Math.max(1, Number(args.timeout_seconds || 120)));
  if (!approved && !fullHostPermission(settings)) {
    const id = await queueHostArtifactConfirmation(args, artifact);
    return {
      ok: false,
      confirmation_required: true,
      confirmation_id: id,
      expires_at: pending.get(id)?.expiresAt,
      summary: "อนุญาตให้อัลฟ่ารัน " + basename(artifact.path) + " บน Mac เครื่องจริง (ไม่ใช่ Docker) เพื่อ" + reason + " หรือไม่?",
      path: artifact.path,
      interpreter: artifact.interpreter,
      execution_scope: "macos_host",
      docker_used: false,
    };
  }
  const result = await runHostProcess(artifact.interpreter, [artifact.path, ...runArgs], { cwd: dirname(artifact.path), timeout: timeoutSeconds * 1000 });
  return {
    ok: result.code === 0,
    message: result.code === 0 ? "รัน " + basename(artifact.path) + " บน Mac จริงเสร็จแล้ว" : "รัน " + basename(artifact.path) + " บน Mac จริงจบด้วย exit code " + result.code,
    path: artifact.path,
    interpreter: artifact.interpreter,
    args: runArgs,
    exit_code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    execution_scope: "macos_host",
    host_scope: "macos",
    docker_used: false,
    permission_mode: fullHostPermission(settings) ? "persistent_full" : (approved ? "approved_once" : "default"),
    approval_skipped: fullHostPermission(settings),
    resume: result.code === 0,
    resume_prompt: result.code === 0 ? "host execution สำเร็จแล้ว ให้ใช้ stdout/stderr เป็นหลักฐานและดำเนิน workflow เดิมต่อจนจบ" : "",
  };
}

function virtualWirelessSkill() {
  return {
    id: "mac-wireless-audit-controller",
    name: "Mac Wireless Audit Controller",
    description: "Inspect the current Mac Wi-Fi hardware and installed audit tooling first, install missing supported Homebrew tools through Alpha after approval, and continue the authorized owned Wi-Fi lab workflow without assuming external hardware.",
    trigger_examples: ["ตรวจ Wi-Fi ของฉัน", "wireless audit", "Wi-Fi lab", "สร้างโปรแกรมทดสอบ Wi-Fi ของฉัน"],
    verification_status: "builtin",
    enabled: true,
    origin: "alpha_core",
  };
}

async function fetchCoreTool(body) {
  const response = await fetch(`http://127.0.0.1:${corePort}/v1/tool/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(190_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function listSkillsWithBuiltin(body) {
  const { response, payload } = await fetchCoreTool(body);
  if (!response.ok && response.status !== 409) return { status: response.status, payload };
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  if (!skills.some((item) => item?.id === "mac-wireless-audit-controller")) skills.unshift(virtualWirelessSkill());
  return { status: response.status, payload: { ...payload, skills, total: Math.max(Number(payload.total || 0) + 1, skills.length) } };
}

async function runVirtualWirelessSkill(args) {
  const input = args?.input && typeof args.input === "object" ? args.input : {};
  const capability = await systemCapability({ area: "wifi", commands: ["aircrack-ng", "hcxdumptool", "hcxpcapngtool", "hashcat"] });
  return {
    ok: true,
    skill: { id: "mac-wireless-audit-controller", name: "Mac Wireless Audit Controller" },
    stdout: JSON.stringify({
      status: "CAPABILITY_INVENTORY_COMPLETE",
      target: input.ssid || input.wifi || input.target || "",
      capability,
      next_action: "Use built-in Mac capability first. If a required Homebrew formula is missing, call install_package. After approval/install, re-check capability and continue the original task automatically.",
    }),
    stderr: "",
    artifacts: [],
  };
}

function proxyBuffered(request, response, body) {
  const upstream = http.request({
    host: "127.0.0.1",
    port: corePort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${corePort}`, "content-length": body.length },
  }, (incoming) => {
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on("error", (error) => json(response, 502, { error: `Core Tool Service ไม่พร้อม: ${error.message}` }));
  if (body.length) upstream.write(body);
  upstream.end();
}

function proxyStream(request, response) {
  const upstream = http.request({
    host: "127.0.0.1",
    port: corePort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${corePort}` },
  }, (incoming) => {
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on("error", (error) => json(response, 502, { error: `Core Tool Service ไม่พร้อม: ${error.message}` }));
  request.pipe(upstream);
}

async function augmentedHealth(request, response) {
  try {
    if (cleanExpiredPending()) await persistPending();
    const core = await fetch(`http://127.0.0.1:${corePort}/v1/health`, {
      headers: { Authorization: request.headers.authorization || "" },
      signal: AbortSignal.timeout(2500),
    });
    const payload = await core.json();
    const brew = await brewPath();
    const pendingApprovals = [...pending.values()].filter((item) => item.status === "pending").length;
    const runningActions = [...pending.values()].filter((item) => item.status === "running").length;
    return json(response, core.status, {
      ...payload,
      host_capability_ready: true,
      host_filesystem_ready: true,
      app_dir: appDir,
      package_install_ready: Boolean(brew),
      package_manager: brew ? "homebrew" : "none",
      approval_store: "persistent",
      pending_approvals: pendingApprovals,
      running_host_actions: runningActions,
    });
  } catch (error) {
    return json(response, 503, { error: error instanceof Error ? error.message : "Core Tool Service ยังไม่พร้อม" });
  }
}

async function confirmHostAction(id, approved) {
  const item = pending.get(id);
  if (!item) return null;
  const now = Date.now();
  if (Number(item.expiresAt || 0) && now > Number(item.expiresAt)) {
    pending.delete(id);
    await persistPending();
    return { status: 410, payload: { ok: false, expired: true, retryable: true, error: "คำขออนุญาตหมดอายุแล้ว กรุณาให้อัลฟ่าสร้างคำขอใหม่" } };
  }
  if (item.status === "completed" || item.status === "denied" || item.status === "failed") {
    return { status: 200, payload: item.cachedResult || { ok: item.status === "completed", denied: item.status === "denied" } };
  }
  if (!approved) {
    const result = { ok: false, denied: true, message: "ไม่ได้ดำเนินการ เพราะคุณไม่อนุญาต", resume: false };
    item.status = "denied";
    item.updatedAt = now;
    item.cachedResult = result;
    await persistPending();
    return { status: 200, payload: result };
  }

  item.status = "running";
  item.updatedAt = now;
  await persistPending();
  try {
    const result = item.type === "install_package"
      ? await installPackage(item.args || {}, true, id)
      : item.type === "install_packages"
        ? await installPackages(item.args || {}, true)
        : item.type === "run_host_artifact"
          ? await runHostArtifact(item.args || {}, true)
          : { ok: false, error: "confirmation type ไม่รู้จัก", resume: false };
    item.status = result.ok ? "completed" : "failed";
    item.updatedAt = Date.now();
    item.cachedResult = result;
    await persistPending();
    return { status: result.ok ? 200 : 500, payload: result };
  } catch (error) {
    const result = { ok: false, error: error instanceof Error ? error.message : "host action failed", resume: false };
    item.status = "failed";
    item.updatedAt = Date.now();
    item.cachedResult = result;
    await persistPending();
    return { status: 500, payload: result };
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    if (!authenticated(request)) return json(response, 401, { error: "ไม่ได้รับอนุญาต" });
    const url = new URL(request.url || "/", `http://127.0.0.1:${publicPort}`);

    if (url.pathname === "/v1/health" && request.method === "GET") return augmentedHealth(request, response);

    const hostStatusMatch = url.pathname.match(/^\/v1\/host\/confirmations\/([^/]+)$/);
    if (hostStatusMatch && request.method === "GET") {
      const item = pending.get(decodeURIComponent(hostStatusMatch[1]));
      return item ? json(response, 200, { ok: true, status: item.status, created_at: item.createdAt, updated_at: item.updatedAt, expires_at: item.expiresAt, result: item.cachedResult || null }) : json(response, 404, { ok: false, error: "ไม่พบคำขอ" });
    }

    if (url.pathname === "/v1/tool/execute" && request.method === "POST") {
      const { buffer, value: body } = await readJson(request);
      const name = String(body.name || "");
      if (name === "host_fs") return json(response, 200, await hostFs(body.arguments || {}, body.settings || {}));
      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));
      if (name === "run_host_artifact") {
        const result = await runHostArtifact(body.arguments || {}, false, body.settings || {});
        return json(response, result.confirmation_required ? 409 : (result.ok ? 200 : 500), result);
      }
      if (name === "install_packages") {
        const result = await installPackages(body.arguments || {}, fullHostPermission(body.settings || {}));
        if (fullHostPermission(body.settings || {}) && result && typeof result === "object") {
          result.permission_mode = "persistent_full";
          result.approval_skipped = true;
        }
        return json(response, result.confirmation_required ? 409 : 200, result);
      }
      if (name === "install_package") {
        const result = await installPackage(body.arguments || {}, fullHostPermission(body.settings || {}));
        if (fullHostPermission(body.settings || {}) && result && typeof result === "object") {
          result.permission_mode = "persistent_full";
          result.approval_skipped = true;
        }
        return json(response, result.confirmation_required ? 409 : 200, result);
      }
      if (name === "list_learned_skills") {
        const result = await listSkillsWithBuiltin(body);
        return json(response, result.status, result.payload);
      }
      if (name === "run_learned_skill" && String(body.arguments?.skill_id || "") === "mac-wireless-audit-controller") {
        return json(response, 200, await runVirtualWirelessSkill(body.arguments || {}));
      }
      return proxyBuffered(request, response, buffer);
    }

    if (url.pathname === "/v1/tools/confirm" && request.method === "POST") {
      const { buffer, value: body } = await readJson(request);
      const id = String(body.confirmation_id || "");
      const handled = await confirmHostAction(id, body.approved === true);
      if (handled) return json(response, handled.status, handled.payload);
      return proxyBuffered(request, response, buffer);
    }

    return proxyStream(request, response);
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : "Tool wrapper ทำงานไม่สำเร็จ" });
  }
});

server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(corePort, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

setInterval(async () => {
  if (cleanExpiredPending()) await persistPending().catch(() => {});
}, 60_000).unref();

function shutdown() {
  server.close(() => {});
  if (!coreChild.killed) coreChild.kill("SIGTERM");
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { shutdown(); setTimeout(() => process.exit(0), 200); });
process.on("exit", () => { if (!coreChild.killed) coreChild.kill("SIGTERM"); });

server.listen(publicPort, "127.0.0.1", () => {
  console.log(`Alpha beta3 host-tool wrapper listening on 127.0.0.1:${publicPort}; core=${corePort}; approvals=persistent`);
});
