import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

const appDir = resolve(process.env.ALPHA_APP_DIR || process.argv[2] || process.cwd());
const serverPath = resolve(appDir, "tool-service", "server.mjs");
const packagePath = resolve(appDir, "package.json");
const workDir = resolve(appDir, "work");
const statePath = resolve(workDir, "tool-service-supervisor.json");
const pidPath = resolve(workDir, "alpha-tool.pid");
const startedAt = Date.now();
let child = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let heartbeatTimer = null;
let versionTimer = null;
let supervisedAppVersion = "";
let versionRestartPending = false;

async function readAppVersion() {
  try {
    const packageInfo = JSON.parse(await fs.readFile(packagePath, "utf8"));
    return typeof packageInfo?.version === "string" ? packageInfo.version.trim().slice(0, 80) : "";
  } catch {
    return "";
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, path);
  } catch {
    // The project may be on a temporarily disconnected external drive. The
    // supervisor keeps running and retries the real service when it returns.
  }
}

async function writeState(status, detail = "", extra = {}) {
  await atomicJson(statePath, {
    version: 1,
    status,
    detail,
    supervisor_pid: process.pid,
    child_pid: child?.pid || null,
    app_version: supervisedAppVersion || null,
    restart_count: restartCount,
    started_at: startedAt,
    updated_at: Date.now(),
    ...extra,
  });
}

function restartDelay() {
  return Math.min(30_000, 1_000 * (2 ** Math.min(5, Math.max(0, restartCount - 1))));
}

function scheduleRestart(reason) {
  if (stopping || restartTimer) return;
  restartCount += 1;
  const delay = restartDelay();
  void writeState("recovering", reason, { retry_in_ms: delay });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launchCore();
  }, delay);
}

function launchCore() {
  if (stopping || child) return;
  versionRestartPending = false;
  void writeState("starting", restartCount ? "กำลังคืน Tool Service จาก journal หลัง process ขัดข้อง" : "กำลังเริ่ม Tool Service");
  try {
    const next = spawn(process.execPath, [serverPath, appDir], {
      cwd: appDir,
      env: { ...process.env, ALPHA_APP_DIR: appDir, ALPHA_TOOL_SUPERVISED: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = next;
    next.once("spawn", () => {
      void writeState("running", restartCount ? "Tool Service กลับมาทำงานแล้ว" : "Tool Service พร้อมทำงาน");
    });
    next.once("error", (error) => {
      if (child === next) child = null;
      scheduleRestart(`spawn failed: ${String(error?.message || error).slice(0, 500)}`);
    });
    next.once("exit", (code, signal) => {
      if (child === next) child = null;
      if (stopping) return;
      scheduleRestart(`Tool Service exited code=${code ?? "null"} signal=${signal || "none"}`);
    });
  } catch (error) {
    child = null;
    scheduleRestart(`launch failed: ${String(error?.message || error).slice(0, 500)}`);
  }
}

async function restartForVersionChange() {
  if (stopping || versionRestartPending) return;
  const currentAppVersion = await readAppVersion();
  if (!currentAppVersion) return;
  if (!supervisedAppVersion) {
    supervisedAppVersion = currentAppVersion;
    return;
  }
  if (currentAppVersion === supervisedAppVersion) return;
  const previousAppVersion = supervisedAppVersion;
  supervisedAppVersion = currentAppVersion;
  versionRestartPending = true;
  await writeState("recovering", `ตรวจพบ Alpha เปลี่ยนจาก ${previousAppVersion} เป็น ${currentAppVersion} กำลังโหลด Tool Service รุ่นใหม่`, {
    previous_app_version: previousAppVersion,
    next_app_version: currentAppVersion,
  });
  if (child) child.kill("SIGTERM");
  else scheduleRestart("กำลังเริ่ม Tool Service ให้ตรงกับเวอร์ชันแอป");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (versionTimer) clearInterval(versionTimer);
  versionTimer = null;
  await writeState("stopping", `รับ ${signal} จาก launcher`);
  const running = child;
  if (!running) {
    await fs.rm(pidPath, { force: true }).catch(() => undefined);
    process.exit(0);
    return;
  }
  const forceTimer = setTimeout(() => running.kill("SIGKILL"), 8_000);
  running.once("exit", async () => {
    clearTimeout(forceTimer);
    await writeState("stopped", "Tool Service และ supervisor ปิดแล้ว");
    await fs.rm(pidPath, { force: true }).catch(() => undefined);
    process.exit(0);
  });
  running.kill("SIGTERM");
}

await fs.mkdir(workDir, { recursive: true });
supervisedAppVersion = await readAppVersion();
await fs.writeFile(pidPath, `${process.pid}\n`, "utf8");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { void shutdown(signal); });
process.on("uncaughtException", (error) => {
  void writeState("failed", `supervisor exception: ${String(error?.stack || error).slice(0, 2_000)}`).finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  void writeState("failed", `supervisor rejection: ${String(error?.stack || error).slice(0, 2_000)}`).finally(() => process.exit(1));
});

launchCore();
versionTimer = setInterval(() => {
  if (!stopping) void restartForVersionChange();
}, 1_000);
heartbeatTimer = setInterval(() => {
  if (stopping) return;
  const status = child ? "running" : (restartTimer ? "recovering" : "starting");
  void writeState(status, child ? "Tool Service heartbeat" : "กำลังรอคืน Tool Service");
}, 5_000);
