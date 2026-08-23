import http from "node:http";
import net from "node:net";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { basename, resolve } from "node:path";

const appDir = resolve(process.env.ALPHA_APP_DIR || process.argv[2] || process.cwd());
const publicPort = Number(process.env.ALPHA_TOOL_PORT || 4317);
const corePort = publicPort + 1;
const varsFile = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8").catch(() => "");
const token = String(process.env.ALPHA_TOOL_TOKEN || varsFile.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1] || "").trim();
const pending = new Map();

if (token.length < 32) {
  console.error("ALPHA_TOOL_TOKEN is missing or too short");
  process.exit(1);
}

process.env.ALPHA_TOOL_PORT = String(corePort);
await import("./server-core.mjs");

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function safeCommand(command, args = [], timeout = 10_000) {
  try {
    const result = await run(command, args, { timeout, allowFailure: true });
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
    package_manager: {
      homebrew: Boolean(commands.brew?.installed),
      path: commands.brew?.path || "",
    },
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
      note: "ผลนี้เป็น inventory ของ Mac เครื่องจริง ยังไม่สรุปว่าต้องใช้อุปกรณ์ภายนอกจนกว่าจะตรวจ workflow ที่ต้องการกับ hardware/driver นี้",
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
    throw new Error("ชื่อ package ต้องเป็น Homebrew formula จาก core เท่านั้น ห้ามมี URL, tap, cask, option หรือ shell syntax");
  }
  return formula;
}

async function installPackage(args, approved = false) {
  const formula = validateFormula(args.package);
  const reason = String(args.reason || "จำเป็นสำหรับงานปัจจุบัน").trim().slice(0, 500);
  const brew = await brewPath();
  if (!brew) {
    return {
      ok: false,
      package_manager_missing: true,
      manager: "homebrew",
      message: "Mac เครื่องนี้ยังไม่มี Homebrew จึงยังติดตั้ง formula อัตโนมัติไม่ได้",
    };
  }

  const installed = await run(brew, ["list", "--versions", formula], { timeout: 10_000, allowFailure: true });
  if (installed.code === 0 && installed.stdout.trim()) {
    return { ok: true, already_installed: true, package: formula, version: installed.stdout.trim() };
  }

  const info = await run(brew, ["info", "--formula", formula], { timeout: 60_000, allowFailure: true });
  if (info.code !== 0) {
    throw new Error(`ไม่พบ Homebrew formula '${formula}' ในแหล่งที่ Homebrew รู้จัก: ${info.stderr.trim() || info.stdout.trim()}`);
  }

  if (!approved) {
    const confirmationId = randomUUID();
    pending.set(confirmationId, { type: "install_package", args: { package: formula, reason }, createdAt: Date.now() });
    return {
      ok: false,
      confirmation_required: true,
      confirmation_id: confirmationId,
      summary: `อัลฟ่าต้องติดตั้ง ${formula} เพื่อ${reason} — อนุญาตให้ติดตั้งผ่าน Homebrew หรือไม่?`,
      package: formula,
      manager: "homebrew",
    };
  }

  const result = await run(brew, ["install", formula], { timeout: 20 * 60_000, allowFailure: true });
  const verify = await run(brew, ["list", "--versions", formula], { timeout: 10_000, allowFailure: true });
  return {
    ok: result.code === 0 && verify.code === 0,
    package: formula,
    manager: "homebrew",
    version: verify.stdout.trim(),
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-12_000),
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
    const core = await fetch(`http://127.0.0.1:${corePort}/v1/health`, {
      headers: { Authorization: request.headers.authorization || "" },
      signal: AbortSignal.timeout(2500),
    });
    const payload = await core.json();
    const brew = await brewPath();
    return json(response, core.status, {
      ...payload,
      host_capability_ready: true,
      package_install_ready: Boolean(brew),
      package_manager: brew ? "homebrew" : "none",
    });
  } catch (error) {
    return json(response, 503, { error: error instanceof Error ? error.message : "Core Tool Service ยังไม่พร้อม" });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    if (!authenticated(request)) return json(response, 401, { error: "ไม่ได้รับอนุญาต" });
    const url = new URL(request.url || "/", `http://127.0.0.1:${publicPort}`);

    if (url.pathname === "/v1/health" && request.method === "GET") return augmentedHealth(request, response);

    if (url.pathname === "/v1/tool/execute" && request.method === "POST") {
      const { buffer, value: body } = await readJson(request);
      const name = String(body.name || "");
      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));
      if (name === "install_package") {
        const result = await installPackage(body.arguments || {}, false);
        return json(response, result.confirmation_required ? 409 : 200, result);
      }
      return proxyBuffered(request, response, buffer);
    }

    if (url.pathname === "/v1/tools/confirm" && request.method === "POST") {
      const { buffer, value: body } = await readJson(request);
      const id = String(body.confirmation_id || "");
      const item = pending.get(id);
      if (!item) return proxyBuffered(request, response, buffer);
      pending.delete(id);
      if (body.approved !== true) return json(response, 200, { ok: false, denied: true, message: "ผู้ใช้ไม่อนุญาต" });
      if (item.type === "install_package") return json(response, 200, await installPackage(item.args, true));
      return json(response, 400, { error: "confirmation type ไม่รู้จัก" });
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

setInterval(() => {
  const now = Date.now();
  for (const [id, item] of pending) if (now - item.createdAt > 10 * 60_000) pending.delete(id);
}, 30_000).unref();

server.listen(publicPort, "127.0.0.1", () => {
  console.log(`Alpha host-tool wrapper listening on 127.0.0.1:${publicPort}; core=${corePort}`);
});
